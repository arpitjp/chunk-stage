import { TextDecoder } from 'util';
import * as vscode from 'vscode';
import { FileDiff, LineRange, computeFileDiff } from './diff';
import {
  BlobRef,
  FileState,
  Git,
  InRepo,
  IndexTransition,
  PathEntries,
  StageableState,
  StaleIndexError,
  TrackedState,
  blobId,
} from './git';
import { Action, IndexContent, Plan, Snapshot, UTF8_BOM, formatCounts, indexContent, planFor } from './plan';

const MAX_CACHED_BLOBS = 64;

/** What the built-in git extension can do for us. */
export interface GitExtensionBridge {
  /**
   * The path the git extension would stage the file under, relative to its
   * repository root; undefined when it can't stage the file.
   */
  relativePath(uri: vscode.Uri): string | undefined;
  /**
   * Has the git extension set the file's index content. Its own writes refresh
   * the editor's gutter right away. Settles only after the git extension has
   * refreshed its views, which runs a full `git status` and can take far longer
   * than the write itself.
   */
  stage(uri: vscode.Uri, text: string): Thenable<unknown>;
  /** Asks the git extension to refresh its views after a write made by us. */
  refresh(uri: vscode.Uri): void;
}

export type DiffResult = ({ ok: true } & Snapshot) | { ok: false; reason: string };

export type ApplyOutcome =
  | { kind: 'done'; plan: Plan; location: InRepo; transition: IndexTransition }
  | { kind: 'nothing' }
  | { kind: 'unavailable'; reason: string };

type Blob = { ok: true; text: string; bom: boolean } | { ok: false; reason: string };

interface KnownState {
  key: string;
  promise: Promise<FileState>;
  state: FileState;
}

/**
 * Knows, per open file, what is in the git index and HEAD and how the editor
 * text differs from them. Diffs are computed against the in-memory document,
 * so they stay accurate while the file has unsaved edits.
 */
export class ChangeTracker implements vscode.Disposable {
  private readonly states = new Map<string, Promise<FileState>>();
  private readonly blobs = new Map<string, Promise<Blob>>();
  private readonly stagedDiffs = new WeakMap<FileState, Promise<FileDiff | undefined>>();
  private readonly diffs = new Map<
    string,
    { version: number; state: FileState; statePromise: Promise<FileState>; result: DiffResult }
  >();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly externalEmitter = new vscode.EventEmitter<string>();
  /** Files with a write in flight; their cached state is ahead of git on purpose. */
  private readonly writing = new Set<string>();
  private refreshing = false;
  private refreshAgain = false;

  /** Fires when the index or HEAD version of any known file changes. */
  readonly onDidChange = this.changeEmitter.event;
  /** Fires with the file path when something other than this extension changed its index or HEAD version. */
  readonly onDidChangeExternally = this.externalEmitter.event;

  constructor(
    private readonly git: Git,
    private readonly log: vscode.LogOutputChannel,
    private readonly bridge?: GitExtensionBridge,
  ) {}

  async getDiff(doc: vscode.TextDocument): Promise<DiffResult> {
    if (doc.uri.scheme !== 'file') {
      return { ok: false, reason: doc.isUntitled ? 'Save the file first.' : 'Only files on disk can be staged.' };
    }
    const key = doc.uri.fsPath;
    const statePromise = this.getState(key);
    const state = await statePromise;
    const cached = this.diffs.get(key);
    if (cached && cached.state === state && cached.version === doc.version) {
      return cached.result;
    }
    const result = await this.computeDiff(doc, state);
    if (this.states.get(key) === statePromise) {
      this.diffs.set(key, { version: result.ok ? result.version : doc.version, state, statePromise, result });
    }
    return result;
  }

  /** What `apply` would do, if that is already known without waiting for git. */
  peekPlan(doc: vscode.TextDocument, action: Action, ranges: LineRange[]): Plan | undefined {
    const key = doc.uri.fsPath;
    const cached = this.diffs.get(key);
    if (!cached || cached.version !== doc.version || cached.statePromise !== this.states.get(key) || !cached.result.ok) {
      return undefined;
    }
    return planFor(cached.result, action, ranges);
  }

  /**
   * Stages or unstages the editor lines in `ranges`. Works from the cached
   * view of the index; the write itself verifies that view and, if someone
   * else changed the index meanwhile, this retries once against fresh state.
   */
  async apply(
    doc: vscode.TextDocument,
    action: Action,
    ranges: LineRange[],
    onWillWrite?: (plan: Plan) => void,
  ): Promise<ApplyOutcome> {
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      const result = await this.getDiff(doc);
      if (!result.ok) {
        return { kind: 'unavailable', reason: result.reason };
      }
      const plan = planFor(result, action, ranges);
      if (!plan) {
        return { kind: 'nothing' };
      }
      // Show the outcome right away; git (and the network to a remote host) can take a moment.
      onWillWrite?.(plan);
      const content = indexContent(result, plan);
      const predicted = content
        ? { mode: await this.git.modeFor(result.state), sha: blobId(content.bytes) }
        : null;
      const key = doc.uri.fsPath;
      this.writing.add(key);
      this.adopt(doc.uri, result.state, predicted, content?.bytes ?? null);
      try {
        const { viaGitExtension, ...transition } = await this.write(doc.uri, result.state, content);
        if (!sameEntry(transition.after, predicted)) {
          this.adopt(doc.uri, result.state, transition.after, content?.bytes ?? null);
        }
        const verb = action === 'stage' ? 'Staged' : 'Unstaged';
        const how = viaGitExtension ? 'via the git extension' : 'directly';
        this.log.info(`${verb} ${formatCounts(plan)} in ${result.state.relPath} ${how} (${Date.now() - started} ms)`);
        return { kind: 'done', plan, location: { root: result.state.root, relPath: result.state.relPath }, transition };
      } catch (err) {
        this.forget(doc.uri);
        this.changeEmitter.fire();
        if (!(err instanceof StaleIndexError) || attempt > 0) {
          throw err;
        }
      } finally {
        this.writing.delete(key);
      }
    }
  }

  /** Sets the file's index entry to `next` if it is still `expected` (used by undo/redo). */
  async replaceEntry(uri: vscode.Uri, location: InRepo, expected: BlobRef | null, next: BlobRef | null): Promise<void> {
    const key = uri.fsPath;
    const previous = await this.states.get(key);
    let entry = next;
    this.writing.add(key);
    this.adopt(uri, previous, next, null);
    try {
      const text = next && previous ? await this.textForGitExtension(uri, previous, next) : undefined;
      if (text !== undefined) {
        await this.git.expectEntry(location, expected);
        entry = await this.stageViaGitExtension(uri, location, text, expected);
      } else {
        await this.git.replaceIndexEntry(location, expected, next);
        this.bridge?.refresh(uri);
      }
    } catch (err) {
      this.forget(uri);
      this.changeEmitter.fire();
      throw err;
    } finally {
      this.writing.delete(key);
    }
    if (!sameEntry(entry, next)) {
      this.adopt(uri, previous, entry, null);
    }
  }

  forget(uri: vscode.Uri): void {
    this.states.delete(uri.fsPath);
    this.diffs.delete(uri.fsPath);
  }

  /** Re-checks the git state of every known file and fires events for those that moved. */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        const known = await Promise.all(
          [...this.states].map(async ([key, promise]): Promise<KnownState> => ({ key, promise, state: await promise })),
        );
        const suspects = await this.findSuspects(known);
        const reloaded = await Promise.all(suspects.map(async (s) => ({ ...s, next: await this.loadState(s.key) })));
        let moved = false;
        for (const { key, promise, state, next } of reloaded) {
          // Skip files that were re-read or written by us while this refresh ran.
          const ours = this.writing.has(key) || this.states.get(key) !== promise;
          if (!ours && JSON.stringify(state) !== JSON.stringify(next)) {
            this.states.set(key, Promise.resolve(next));
            this.externalEmitter.fire(key);
            moved = true;
          }
        }
        if (moved) {
          this.changeEmitter.fire();
        }
      } while (this.refreshAgain);
    } finally {
      this.refreshing = false;
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.externalEmitter.dispose();
  }

  /**
   * Files whose index or HEAD entry no longer matches what we know, checked
   * with one batched lookup per repository. Conflicted, missing and failed
   * files are always re-read, since that's how they recover.
   */
  private async findSuspects(known: KnownState[]): Promise<KnownState[]> {
    const suspects: KnownState[] = [];
    const byRoot = new Map<string, Array<KnownState & { state: StageableState }>>();
    for (const item of known) {
      const { state } = item;
      if (state.kind === 'tracked' || state.kind === 'untracked') {
        const group = byRoot.get(state.root) ?? [];
        group.push({ ...item, state });
        byRoot.set(state.root, group);
      } else if (state.kind === 'conflicted' || state.kind === 'missing' || state.kind === 'error') {
        suspects.push(item);
      }
    }
    await Promise.all(
      [...byRoot].map(async ([root, group]) => {
        let entries: Map<string, PathEntries>;
        try {
          entries = await this.git.entries(root, group.map((item) => item.state.relPath));
        } catch {
          suspects.push(...group);
          return;
        }
        for (const item of group) {
          const current = entries.get(item.state.relPath);
          if (!current || !matchesKnown(item.state, current)) {
            suspects.push(item);
          }
        }
      }),
    );
    return suspects;
  }

  private async write(
    uri: vscode.Uri,
    state: StageableState,
    content: IndexContent | null,
  ): Promise<IndexTransition & { viaGitExtension: boolean }> {
    const before: BlobRef | null = state.kind === 'tracked' ? { mode: state.mode, sha: state.sha } : null;
    if (content && this.canUseGitExtension(uri, state, content.bytes, await this.git.modeFor(state))) {
      await this.git.expectEntry(state, before);
      const after = await this.stageViaGitExtension(uri, state, content.text, before);
      return { before, after, viaGitExtension: true };
    }
    const transition = await this.git.writeIndex(state, content?.bytes ?? null);
    this.bridge?.refresh(uri);
    return { ...transition, viaGitExtension: false };
  }

  /**
   * Has the git extension stage `text` and resolves with the new index entry
   * as soon as it lands, without waiting for the git extension's refresh.
   */
  private stageViaGitExtension(uri: vscode.Uri, location: InRepo, text: string, before: BlobRef | null): Promise<BlobRef | null> {
    const stopPolling = new AbortController();
    const call = Promise.resolve(this.bridge?.stage(uri, text));
    const failed = call.then(
      () => new Promise<never>(() => undefined),
      (err: unknown) => {
        stopPolling.abort();
        throw err;
      },
    );
    const landed = this.git.waitForEntry(location, (e) => e !== null && e.sha !== before?.sha, { signal: stopPolling.signal });
    return Promise.race([landed, failed]);
  }

  /**
   * The git extension writes the mode from HEAD (644 for new files), drops
   * BOMs and uses the editor's spelling of the path. Its write is only used
   * when it comes out byte-for-byte the same as ours.
   */
  private canUseGitExtension(uri: vscode.Uri, state: StageableState, bytes: Buffer, mode: string): boolean {
    const extensionMode = state.kind === 'tracked' && state.head ? state.head.mode : '100644';
    return (
      mode === extensionMode &&
      !bytes.subarray(0, 3).equals(UTF8_BOM) &&
      this.bridge?.relativePath(uri) === state.relPath
    );
  }

  /** The text to hand the git extension for restoring `entry`, if it can do that write. */
  private async textForGitExtension(uri: vscode.Uri, state: FileState, entry: BlobRef): Promise<string | undefined> {
    if (state.kind !== 'tracked' && state.kind !== 'untracked') {
      return undefined;
    }
    const blob = await this.getBlob(state.root, entry.sha);
    if (!blob.ok || blob.bom) {
      return undefined;
    }
    const bytes = Buffer.from(blob.text, 'utf8');
    return this.canUseGitExtension(uri, state, bytes, entry.mode) ? blob.text : undefined;
  }

  /** Records the entry we just wrote, so the UI updates without asking git again. */
  private adopt(uri: vscode.Uri, previous: FileState | undefined, entry: BlobRef | null, content: Buffer | null): void {
    const next = previous && withIndexEntry(previous, entry);
    if (next) {
      if (content && entry && blobId(content) === entry.sha) {
        this.cacheBlob(entry.sha, Promise.resolve(decodeBlob(content)));
      }
      this.states.set(uri.fsPath, Promise.resolve(next));
      this.diffs.delete(uri.fsPath);
    } else {
      this.forget(uri);
    }
    this.changeEmitter.fire();
  }

  private getState(key: string): Promise<FileState> {
    let state = this.states.get(key);
    if (!state) {
      state = this.loadState(key);
      this.states.set(key, state);
    }
    return state;
  }

  private async loadState(key: string): Promise<FileState> {
    try {
      return await this.git.fileState(key);
    } catch (err) {
      const message = errorMessage(err);
      this.log.warn(`Could not read git state of ${key}: ${message}`);
      return { kind: 'error', message };
    }
  }

  private async computeDiff(doc: vscode.TextDocument, state: FileState): Promise<DiffResult> {
    switch (state.kind) {
      case 'outside':
        return { ok: false, reason: 'This file is not in a git repository.' };
      case 'missing':
        return { ok: false, reason: 'This file no longer exists on disk.' };
      case 'error':
        return { ok: false, reason: `Git failed: ${state.message}` };
      case 'ignored':
        return { ok: false, reason: 'This file is ignored by git.' };
      case 'conflicted':
        return { ok: false, reason: 'Resolve the merge conflict in this file first.' };
      case 'unsupported':
        return { ok: false, reason: state.reason };
    }
    const encoding = vscode.workspace.getConfiguration('files', doc.uri).get<string>('encoding', 'utf8');
    if (encoding !== 'utf8' && encoding !== 'utf8bom') {
      return { ok: false, reason: 'Only UTF-8 files can be staged line by line.' };
    }
    let indexText = '';
    let bom = encoding === 'utf8bom';
    let staged: FileDiff | undefined;
    if (state.kind === 'tracked') {
      const blob = await this.getBlob(state.root, state.sha);
      if (!blob.ok) {
        return blob;
      }
      indexText = blob.text;
      bom = blob.bom;
      staged = await this.getStagedDiff(state, indexText);
    }
    return {
      ok: true,
      state,
      bom,
      version: doc.version,
      unstaged: computeFileDiff(indexText, doc.getText()),
      staged,
    };
  }

  private getStagedDiff(state: TrackedState, indexText: string): Promise<FileDiff | undefined> {
    let diff = this.stagedDiffs.get(state);
    if (!diff) {
      const head = state.head;
      diff = head
        ? this.getBlob(state.root, head.sha).then((blob) => (blob.ok ? computeFileDiff(indexText, blob.text) : undefined))
        : Promise.resolve(computeFileDiff(indexText, ''));
      this.stagedDiffs.set(state, diff);
    }
    return diff;
  }

  private getBlob(root: string, sha: string): Promise<Blob> {
    const cached = this.blobs.get(sha);
    if (cached) {
      return cached;
    }
    const blob = this.git.readBlob(root, sha).then(decodeBlob, (err): Blob => {
      this.blobs.delete(sha);
      return { ok: false, reason: `Git failed: ${errorMessage(err)}` };
    });
    this.cacheBlob(sha, blob);
    return blob;
  }

  private cacheBlob(sha: string, blob: Promise<Blob>): void {
    this.blobs.delete(sha);
    this.blobs.set(sha, blob);
    if (this.blobs.size > MAX_CACHED_BLOBS) {
      const oldest = this.blobs.keys().next().value;
      if (oldest !== undefined) {
        this.blobs.delete(oldest);
      }
    }
  }
}

function withIndexEntry(state: FileState, entry: BlobRef | null): FileState | undefined {
  if (state.kind !== 'tracked' && state.kind !== 'untracked') {
    return undefined;
  }
  const { root, relPath, filePath } = state;
  const head = state.kind === 'tracked' ? state.head : null;
  return entry
    ? { kind: 'tracked', root, relPath, filePath, mode: entry.mode, sha: entry.sha, head }
    : { kind: 'untracked', root, relPath, filePath };
}

function sameEntry(a: BlobRef | null, b: BlobRef | null): boolean {
  return a === b || (a !== null && b !== null && a.sha === b.sha && a.mode === b.mode);
}

function matchesKnown(state: StageableState, { index, head }: PathEntries): boolean {
  if (state.kind === 'untracked') {
    return index === null;
  }
  return (
    index !== null &&
    index !== 'conflict' &&
    index.sha === state.sha &&
    index.mode === state.mode &&
    head?.sha === state.head?.sha &&
    head?.mode === state.head?.mode
  );
}

function decodeBlob(bytes: Buffer): Blob {
  if (bytes.includes(0)) {
    return { ok: false, reason: 'Binary files can’t be staged line by line.' };
  }
  try {
    // The decoder drops a leading BOM; remember it so the staged blob keeps it.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, text, bom: bytes.subarray(0, 3).equals(UTF8_BOM) };
  } catch {
    return { ok: false, reason: 'Only UTF-8 files can be staged line by line.' };
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
