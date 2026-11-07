import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode = -1,
    readonly stderr = '',
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** The index entry was changed by someone else between reading and writing it. */
export class StaleIndexError extends GitError {
  constructor() {
    super('The staged version of this file changed in the meantime.');
    this.name = 'StaleIndexError';
  }
}

/** Index and HEAD entries of one path; `'conflict'` when the index holds merge stages. */
export interface PathEntries {
  index: BlobRef | null | 'conflict';
  head: BlobRef | null;
}

export interface InRepo {
  /** Work tree root as reported by git. */
  root: string;
  /** Path relative to `root`, with forward slashes. */
  relPath: string;
}

/** A file's blob and mode, as stored in the index or a tree. */
export interface BlobRef {
  mode: string;
  sha: string;
}

/** A file's index entry before and after a write; `null` means no entry. */
export interface IndexTransition {
  before: BlobRef | null;
  after: BlobRef | null;
}

interface OnDisk {
  /** Absolute path of the file git sees, with file symlinks resolved. */
  filePath: string;
}

export type TrackedState = InRepo & OnDisk & { kind: 'tracked'; mode: string; sha: string; head: BlobRef | null };
export type UntrackedState = InRepo & OnDisk & { kind: 'untracked' };
export type StageableState = TrackedState | UntrackedState;

export type FileState =
  | StageableState
  | { kind: 'outside' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }
  | (InRepo & { kind: 'ignored' })
  | (InRepo & { kind: 'conflicted' })
  | (InRepo & { kind: 'unsupported'; reason: string });

interface ExecResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

interface ListedEntry extends BlobRef {
  stage: string;
  path: string;
}

const UNSET_ATTRIBUTES = new Set(['unspecified', 'unset']);
const INDEX_LOCK_RETRIES = 4;

/** Repository settings that decide when two spellings of a path are the same file to git. */
interface PathConfig {
  ignoreCase: boolean;
  /** macOS: git stores composed (NFC) Unicode while the file system may hand out decomposed names. */
  precomposeUnicode: boolean;
}

export class Git {
  private readonly pathConfigByRoot = new Map<string, Promise<PathConfig>>();

  constructor(
    private readonly gitPath: string,
    private readonly timeoutMs = 15_000,
  ) {}

  /**
   * What git thinks of the file at `requestedPath`. A file symlink stands for
   * its target, since editing through it edits the target; symlinked folders
   * are resolved by git itself.
   */
  async fileState(requestedPath: string): Promise<FileState> {
    const resolved = await resolveFile(path.resolve(requestedPath));
    if ('state' in resolved) {
      return resolved.state;
    }
    const { filePath } = resolved;
    const top = await this.exec(path.dirname(filePath), ['rev-parse', '--show-toplevel', '--show-prefix']);
    if (top.exitCode !== 0) {
      return { kind: 'outside' };
    }
    const [root, prefix = ''] = top.stdout.toString('utf8').split('\n');
    const config = await this.pathConfig(root);
    const spell = (p: string) => (config.precomposeUnicode ? p.normalize('NFC') : p);
    const sameFile = (p: string) => (config.ignoreCase ? spell(p).toLowerCase() : spell(p));
    const editorPath = spell(prefix + path.basename(filePath));

    // Literal, so names like `[id].ts` aren't treated as globs. The editor may spell the path
    // differently than the index (case, Unicode composition); writing that spelling would add a
    // second entry for the same file, so the index's spelling wins.
    const pathspec = `:(${config.ignoreCase ? 'literal,icase' : 'literal'})${editorPath}`;
    const listed = await this.run(root, ['ls-files', '--stage', '-z', '--', pathspec]);
    const entries = parseIndexEntries(listed).filter((e) => sameFile(e.path) === sameFile(editorPath));
    const relPath = entries[0]?.path ?? editorPath;
    if (entries.some((e) => e.stage !== '0')) {
      return { kind: 'conflicted', root, relPath };
    }

    const entry = entries[0];
    const [attributeProblem, head] = await Promise.all([
      this.unsupportedAttribute(root, relPath),
      entry ? this.listHead(root, [relPath]).then((head) => head.get(relPath) ?? null) : null,
    ]);
    if (attributeProblem) {
      return { kind: 'unsupported', root, relPath, reason: attributeProblem };
    }

    if (entry) {
      if (entry.mode === '160000') {
        return { kind: 'unsupported', root, relPath, reason: 'Submodules can’t be staged line by line.' };
      }
      if (entry.mode === '120000') {
        return { kind: 'unsupported', root, relPath, reason: 'Symlinks can’t be staged line by line.' };
      }
      return { kind: 'tracked', root, relPath, filePath, mode: entry.mode, sha: entry.sha, head };
    }

    const ignored = await this.exec(root, ['check-ignore', '-q', '--', relPath]);
    if (ignored.exitCode === 0) {
      return { kind: 'ignored', root, relPath };
    }
    if (ignored.exitCode !== 1) {
      throw new GitError(`git check-ignore failed: ${ignored.stderr.trim()}`, ignored.exitCode, ignored.stderr);
    }
    return { kind: 'untracked', root, relPath, filePath };
  }

  readBlob(root: string, sha: string): Promise<Buffer> {
    return this.run(root, ['cat-file', 'blob', sha]);
  }

  /**
   * Sets the file's index entry to `content` (creating it for untracked
   * files), or removes the entry when `content` is null. The working file is
   * never touched.
   */
  async writeIndex(state: StageableState, content: Buffer | null): Promise<IndexTransition> {
    const before: BlobRef | null = state.kind === 'tracked' ? { mode: state.mode, sha: state.sha } : null;
    const [after] = await Promise.all([this.storeBlob(state, content), this.expectEntry(state, before)]);
    await this.setEntry(state, after);
    return { before, after };
  }

  /** Sets the file's index entry to `next`, but only if it is still `expected`. */
  async replaceIndexEntry(location: InRepo, expected: BlobRef | null, next: BlobRef | null): Promise<void> {
    await this.expectEntry(location, expected);
    await this.setEntry(location, next);
  }

  /** Current index and HEAD entries for several paths of one repository, in two git calls. */
  async entries(root: string, relPaths: string[]): Promise<Map<string, PathEntries>> {
    const [index, head] = await Promise.all([this.listIndex(root, relPaths), this.listHead(root, relPaths)]);
    return new Map(relPaths.map((p) => [p, { index: index.get(p) ?? null, head: head.get(p) ?? null }]));
  }

  /** The mode a write keeps: the index mode, or the executable bit for new files. */
  async modeFor(state: StageableState): Promise<string> {
    if (state.kind === 'tracked') {
      return state.mode;
    }
    const stat = await fs.stat(state.filePath);
    return stat.mode & 0o100 ? '100755' : '100644';
  }

  /** Throws `StaleIndexError` unless the file's index entry is `expected`. */
  async expectEntry(location: InRepo, expected: BlobRef | null): Promise<void> {
    const current = await this.indexEntry(location);
    const unchanged = expected
      ? current !== null && current !== 'conflict' && current.sha === expected.sha && current.mode === expected.mode
      : current === null;
    if (!unchanged) {
      throw new StaleIndexError();
    }
  }

  /**
   * Polls the index until `isDone` accepts the file's entry, for writes made by
   * another process. Gives up quietly with null once `signal` is aborted.
   */
  async waitForEntry(
    location: InRepo,
    isDone: (entry: BlobRef | null) => boolean,
    { timeoutMs = 3000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<BlobRef | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) {
        return null;
      }
      const current = await this.indexEntry(location);
      if (current !== 'conflict' && isDone(current)) {
        return current;
      }
      if (Date.now() > deadline) {
        throw new GitError('Timed out waiting for the staged version to update.');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async indexEntry(location: InRepo): Promise<BlobRef | null | 'conflict'> {
    return (await this.listIndex(location.root, [location.relPath])).get(location.relPath) ?? null;
  }

  private async storeBlob(state: StageableState, content: Buffer | null): Promise<BlobRef | null> {
    if (!content) {
      return null;
    }
    const mode = await this.modeFor(state);
    // --path applies the file's clean filters (e.g. CRLF -> LF), just like `git add`.
    const hashed = await this.run(state.root, ['hash-object', '-w', '--stdin', `--path=${state.relPath}`], content);
    return { mode, sha: hashed.toString('utf8').trim() };
  }

  private async setEntry(location: InRepo, next: BlobRef | null): Promise<void> {
    const args = next
      ? ['update-index', '--add', '--cacheinfo', next.mode, next.sha, location.relPath]
      : ['update-index', '--force-remove', '--', location.relPath];
    await this.retryOnIndexLock(() => this.run(location.root, args));
  }

  private async listIndex(root: string, relPaths: string[]): Promise<Map<string, BlobRef | 'conflict'>> {
    const out = await this.run(root, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...relPaths]);
    const entries = new Map<string, BlobRef | 'conflict'>();
    for (const entry of parseIndexEntries(out)) {
      const conflicted = entry.stage !== '0' || entries.get(entry.path) === 'conflict';
      entries.set(entry.path, conflicted ? 'conflict' : { mode: entry.mode, sha: entry.sha });
    }
    return entries;
  }

  private async listHead(root: string, relPaths: string[]): Promise<Map<string, BlobRef>> {
    const entries = new Map<string, BlobRef>();
    const head = await this.exec(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (head.exitCode !== 0) {
      return entries;
    }
    const out = await this.run(root, ['--literal-pathspecs', 'ls-tree', '-z', 'HEAD', '--', ...relPaths]);
    for (const record of out.toString('utf8').split('\0')) {
      const tab = record.indexOf('\t');
      if (tab === -1) {
        continue;
      }
      const [mode, type, sha] = record.slice(0, tab).split(' ');
      if (type === 'blob') {
        entries.set(record.slice(tab + 1), { mode, sha });
      }
    }
    return entries;
  }

  private pathConfig(root: string): Promise<PathConfig> {
    let config = this.pathConfigByRoot.get(root);
    if (!config) {
      const args = ['config', '--bool', '-z', '--get-regexp', '^core\\.(ignorecase|precomposeunicode)$'];
      config = this.exec(root, args).then(
        (result) => {
          // Records are "key\nvalue"; exit code 1 just means neither key is set.
          const values = new Map(
            result.stdout
              .toString('utf8')
              .split('\0')
              .filter(Boolean)
              .map((record) => record.split('\n') as [string, string]),
          );
          return {
            ignoreCase: values.get('core.ignorecase') === 'true',
            precomposeUnicode: values.get('core.precomposeunicode') === 'true',
          };
        },
        (err) => {
          this.pathConfigByRoot.delete(root);
          throw err;
        },
      );
      this.pathConfigByRoot.set(root, config);
    }
    return config;
  }

  private async unsupportedAttribute(root: string, relPath: string): Promise<string | undefined> {
    const out = await this.run(root, ['check-attr', '-z', 'filter', 'working-tree-encoding', '--', relPath]);
    const fields = out.toString('utf8').split('\0');
    for (let i = 0; i + 2 < fields.length; i += 3) {
      if (!UNSET_ATTRIBUTES.has(fields[i + 2])) {
        return `Files with a git "${fields[i + 1]}" attribute can’t be staged line by line.`;
      }
    }
    return undefined;
  }

  private async retryOnIndexLock<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (err) {
        if (attempt >= INDEX_LOCK_RETRIES || !(err instanceof GitError) || !err.stderr.includes('index.lock')) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
  }

  private async run(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
    const result = await this.exec(cwd, args, input);
    if (result.exitCode !== 0) {
      throw new GitError(`git ${commandName(args)} failed: ${result.stderr.trim()}`, result.exitCode, result.stderr);
    }
    return result.stdout;
  }

  private exec(cwd: string, args: string[], input?: Buffer): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitPath, args, {
        cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new GitError(`git ${commandName(args)} timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.stdin.on('error', () => {
        // git may exit before reading all of stdin; the exit code reports the real problem.
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: code ?? -1,
        });
      });
      child.stdin.end(input);
    });
  }
}

function commandName(args: string[]): string {
  return args.find((arg) => !arg.startsWith('-')) ?? '';
}

function parseIndexEntries(out: Buffer): ListedEntry[] {
  const entries: ListedEntry[] = [];
  for (const record of out.toString('utf8').split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) {
      continue;
    }
    const [mode, sha, stage] = record.slice(0, tab).split(' ');
    entries.push({ mode, sha, stage, path: record.slice(tab + 1) });
  }
  return entries;
}

/** Follows a file symlink to the file that holds the content. */
async function resolveFile(filePath: string): Promise<{ filePath: string } | { state: FileState }> {
  try {
    const stat = await fs.lstat(filePath);
    return { filePath: stat.isSymbolicLink() ? await fs.realpath(filePath) : filePath };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { state: { kind: 'missing' } };
    }
    if (code === 'ELOOP') {
      return { state: { kind: 'error', message: 'This symlink points to itself.' } };
    }
    throw err;
  }
}

/** The id git gives `content` as a blob in a SHA-1 repository. */
export function blobId(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}
