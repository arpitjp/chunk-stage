import { strict as assert } from 'node:assert';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { applyLines, git, gitIn, text } from './helpers';

// Keep the developer's own git config (autocrlf, templates, signing, ...) out of these tests.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const scratch: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chunk-stage-paths-'));
  scratch.push(dir);
  return dir;
}

/** A repository with `files` committed. */
async function repoWith(dir: string, files: Record<string, string>): Promise<string> {
  await mkdir(dir, { recursive: true });
  gitIn(dir, 'init', '-q');
  gitIn(dir, 'config', 'user.email', 'test@example.com');
  gitIn(dir, 'config', 'user.name', 'Test');
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'init');
  return dir;
}

after(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

test('a workspace opened through a symlinked folder stages into the real repository', async () => {
  const real = await repoWith(join(await tempDir(), 'real'), { 'src/a.ts': text('one') });
  const link = join(await tempDir(), 'link');
  await symlink(real, link);
  const working = text('one', 'two');
  await writeFile(join(real, 'src/a.ts'), working);

  const { state } = await applyLines(join(link, 'src/a.ts'), working, 'stage', 1, 1);

  assert.equal(state.relPath, 'src/a.ts');
  assert.equal(state.root, realpathSync(real));
  assert.equal(gitIn(real, 'show', ':src/a.ts'), working);
});

test('a file symlink stages its target, and leaves the link itself alone', async () => {
  const repo = await repoWith(join(await tempDir(), 'repo'), { 'app.ts': text('one') });
  await symlink('app.ts', join(repo, 'alias.ts'));
  gitIn(repo, 'add', 'alias.ts');
  gitIn(repo, 'commit', '-qm', 'alias');
  const linkEntry = gitIn(repo, 'ls-files', '--stage', '--', 'alias.ts');
  const working = text('one', 'two');
  await writeFile(join(repo, 'app.ts'), working);

  const { state } = await applyLines(join(repo, 'alias.ts'), working, 'stage', 1, 1);

  assert.equal(state.relPath, 'app.ts');
  assert.equal(state.filePath, realpathSync(join(repo, 'app.ts')));
  assert.equal(gitIn(repo, 'show', ':app.ts'), working);
  assert.equal(gitIn(repo, 'ls-files', '--stage', '--', 'alias.ts'), linkEntry);
});

test('broken symlinks are reported instead of failing', async () => {
  const repo = await repoWith(join(await tempDir(), 'repo'), { 'app.ts': text('one') });
  await symlink('nowhere.ts', join(repo, 'dangling.ts'));
  await symlink('loop.ts', join(repo, 'loop.ts'));

  assert.equal((await git.fileState(join(repo, 'dangling.ts'))).kind, 'missing');
  assert.equal((await git.fileState(join(repo, 'loop.ts'))).kind, 'error');
});

test('files in a submodule stage into the submodule, not the superproject', async () => {
  const library = await repoWith(join(await tempDir(), 'library'), { 'lib.ts': text('one') });
  const app = await repoWith(join(await tempDir(), 'app'), { 'main.ts': text('main') });
  gitIn(app, 'submodule', 'add', '-q', library, 'vendor/lib');
  gitIn(app, 'commit', '-qm', 'add submodule');
  const submodule = join(app, 'vendor/lib');
  const gitlink = gitIn(app, 'ls-files', '--stage', '--', 'vendor/lib');
  const working = text('one', 'two');
  await writeFile(join(submodule, 'lib.ts'), working);

  const { state } = await applyLines(join(submodule, 'lib.ts'), working, 'stage', 1, 1);

  assert.equal(state.root, realpathSync(submodule));
  assert.equal(state.relPath, 'lib.ts');
  assert.equal(gitIn(submodule, 'show', ':lib.ts'), working);
  assert.equal(gitIn(app, 'ls-files', '--stage', '--', 'vendor/lib'), gitlink);
  assert.equal(gitIn(app, 'diff', '--cached', '--name-only'), '');
});

test('the submodule entry itself is not stageable line by line', async () => {
  const library = await repoWith(join(await tempDir(), 'library'), { 'lib.ts': text('one') });
  const app = await repoWith(join(await tempDir(), 'app'), { 'main.ts': text('main') });
  gitIn(app, 'submodule', 'add', '-q', library, 'lib');
  // A file at the gitlink's path in the superproject (e.g. after deleting the submodule checkout).
  await rm(join(app, 'lib'), { recursive: true, force: true });
  await writeFile(join(app, 'lib'), 'not a folder\n');

  const state = await git.fileState(join(app, 'lib'));
  assert.equal(state.kind, 'unsupported');
});

test('a linked worktree stages into its own index', async () => {
  const main = await repoWith(join(await tempDir(), 'main'), { 'a.ts': text('one') });
  const worktree = join(await tempDir(), 'feature');
  gitIn(main, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  const working = text('one', 'two');
  await writeFile(join(worktree, 'a.ts'), working);

  const { state } = await applyLines(join(worktree, 'a.ts'), working, 'stage', 1, 1);

  assert.equal(state.root, realpathSync(worktree));
  assert.equal(gitIn(worktree, 'show', ':a.ts'), working);
  assert.equal(gitIn(main, 'show', ':a.ts'), text('one'));
});

test('a repository nested in an ignored folder of another repository is its own repository', async () => {
  const outer = await repoWith(join(await tempDir(), 'outer'), { '.gitignore': 'vendor/\n' });
  const inner = await repoWith(join(outer, 'vendor/inner'), { 'x.ts': text('x') });
  await writeFile(join(inner, 'new.ts'), text('fresh', 'file'));

  const { state } = await applyLines(join(inner, 'new.ts'), text('fresh', 'file'), 'stage', 0, 0);

  assert.equal(state.root, realpathSync(inner));
  assert.equal(gitIn(inner, 'show', ':new.ts'), text('fresh'));
});

test('paths with spaces, Unicode, brackets and leading dashes', async () => {
  const repo = await repoWith(join(await tempDir(), 'repo'), { 'keep.ts': text('k') });
  const names = ['dir with space/ünïcödé [x].ts', '-dash/-file.ts', 'colon:name.ts'];
  for (const name of names) {
    await mkdir(join(repo, name, '..'), { recursive: true });
    await writeFile(join(repo, name), text('a', 'b'));

    const { state } = await applyLines(join(repo, name), text('a', 'b'), 'stage', 0, 0);

    assert.equal(state.relPath, name);
    assert.equal(gitIn(repo, 'show', `:${name}`), text('a'));
  }
});

test('a decomposed Unicode spelling of a tracked file updates its entry instead of adding one', async (t) => {
  const composed = 'caf\u00e9.ts';
  const decomposed = 'cafe\u0301.ts';
  const repo = await repoWith(join(await tempDir(), 'repo'), { [composed]: text('one') });
  const precompose = gitIn(repo, 'config', '--bool', '--default', 'false', 'core.precomposeunicode').trim();
  if (precompose !== 'true' || !existsSync(join(repo, decomposed))) {
    t.skip('only applies where git precomposes Unicode file names (macOS)');
    return;
  }
  const working = text('one', 'two');
  await writeFile(join(repo, composed), working);

  const { state } = await applyLines(join(repo, decomposed), working, 'stage', 1, 1);

  assert.equal(state.kind, 'tracked');
  assert.equal(state.relPath, composed);
  const entries = gitIn(repo, 'ls-files', '-z').split('\0').filter((p) => p.normalize('NFC') === composed);
  assert.deepEqual(entries, [composed]);
  assert.equal(gitIn(repo, 'show', `:${composed}`), working);
});

test('paths with ".." segments and files inside .git', async () => {
  const repo = await repoWith(join(await tempDir(), 'repo'), { 'app.ts': text('one'), 'src/x.ts': text('x') });

  const viaDots = await git.fileState(join(repo, 'src', '..', 'app.ts'));
  assert.equal(viaDots.kind, 'tracked');
  assert.equal(viaDots.kind === 'tracked' && viaDots.relPath, 'app.ts');
  assert.equal((await git.fileState(join(repo, '.git', 'HEAD'))).kind, 'outside');
});
