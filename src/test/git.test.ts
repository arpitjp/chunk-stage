import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { StaleIndexError, blobId } from '../git';
import { applyLines, git, gitIn, text } from './helpers';

// Keep the developer's own git config (autocrlf, templates, signing, ...) out of these tests.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

let repo: string;

function sh(...args: string[]): string {
  return gitIn(repo, ...args);
}

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'chunk-stage-'));
  sh('init', '-q');
  sh('config', 'user.email', 'test@example.com');
  sh('config', 'user.name', 'Test');
  await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(repo, 'app.ts'), text('function a() {', '  return 1;', '}'));
  sh('add', '.');
  sh('commit', '-qm', 'init');
});

after(async () => {
  await rm(repo, { recursive: true, force: true });
});

test('stages selected lines of a tracked file and leaves the rest unstaged', async () => {
  const file = join(repo, 'app.ts');
  const working = text('function a() {', '  return 2;', '}', '', 'function b() {', '  return 3;', '}');
  await writeFile(file, working);

  await applyLines(file, working, 'stage', 4, 6);

  // The blank line above the selected function comes along.
  assert.equal(sh('show', ':app.ts'), text('function a() {', '  return 1;', '}', '', 'function b() {', '  return 3;', '}'));
  assert.match(sh('diff', '--', 'app.ts'), /-  return 1;\n\+  return 2;/);
});

test('unstages selected lines back to their HEAD version', async () => {
  const file = join(repo, 'app.ts');
  const working = text('function a() {', '  return 2;', '}', '', 'function b() {', '  return 3;', '}');
  await applyLines(file, working, 'stage', 0, 6);
  assert.equal(sh('show', ':app.ts'), working);

  await applyLines(file, working, 'unstage', 1, 1);

  assert.equal(sh('show', ':app.ts'), text('function a() {', '  return 1;', '}', '', 'function b() {', '  return 3;', '}'));
  sh('reset', '-q', '--', 'app.ts');
});

test('undo and redo restore the previous index entry, only if nobody changed it since', async () => {
  const file = join(repo, 'app.ts');
  const working = text('function a() {', '  return 4;', '}');
  await writeFile(file, working);
  const original = sh('show', ':app.ts');

  const { state, transition } = await applyLines(file, working, 'stage', 1, 1);
  assert.equal(sh('show', ':app.ts'), working);

  await git.replaceIndexEntry(state, transition.after, transition.before);
  assert.equal(sh('show', ':app.ts'), original);
  await git.replaceIndexEntry(state, transition.before, transition.after);
  assert.equal(sh('show', ':app.ts'), working);

  sh('reset', '-q', '--', 'app.ts');
  await assert.rejects(git.replaceIndexEntry(state, transition.after, transition.before), StaleIndexError);
});

test('blobId matches the id git assigns', async () => {
  const content = Buffer.from(text('héllo', 'wörld'), 'utf8');
  const fromGit = execFileSync('git', ['hash-object', '--stdin'], { cwd: repo, input: content, encoding: 'utf8' }).trim();
  assert.equal(blobId(content), fromGit);
});

test('entries looks up index and HEAD entries of several paths at once', async () => {
  await writeFile(join(repo, 'staged-new.ts'), 'x\n');
  sh('add', '--', 'staged-new.ts');

  const entries = await git.entries(repo, ['app.ts', 'staged-new.ts', 'not-there.ts']);

  const app = entries.get('app.ts');
  assert.ok(app?.index && app.index !== 'conflict' && app.head);
  assert.equal(app.index.sha, app.head.sha);
  assert.ok(entries.get('staged-new.ts')?.index);
  assert.equal(entries.get('staged-new.ts')?.head, null);
  assert.deepEqual(entries.get('not-there.ts'), { index: null, head: null });
  sh('rm', '-q', '--cached', '--', 'staged-new.ts');
});

test('stages part of a brand-new file whose name has glob characters, then unstages it fully', async () => {
  await mkdir(join(repo, 'pages'), { recursive: true });
  const file = join(repo, 'pages', '[id].ts');
  const working = text('import x from "x";', '', 'export function page() {', '}');
  await writeFile(file, working);

  const { state } = await applyLines(file, working, 'stage', 2, 3);
  assert.equal(state.kind, 'untracked');
  assert.equal(state.relPath, 'pages/[id].ts');
  assert.equal(sh('show', ':pages/[id].ts'), text('', 'export function page() {', '}'));

  await applyLines(file, working, 'unstage', 0, 3);
  assert.equal((await git.fileState(file)).kind, 'untracked');
  assert.equal(sh('ls-files', '--', 'pages'), '');
});

test('new executable files keep their mode', async () => {
  const file = join(repo, 'run.sh');
  await writeFile(file, text('#!/bin/sh', 'echo hi'));
  await chmod(file, 0o755);

  await applyLines(file, text('#!/bin/sh', 'echo hi'), 'stage', 0, 0);

  assert.match(sh('ls-files', '--stage', '--', 'run.sh'), /^100755 /);
});

test('a path spelled with different case updates the existing index entry', async (t) => {
  const file = join(repo, 'Case.ts');
  await writeFile(file, text('one'));
  sh('add', '--', 'Case.ts');
  const otherCase = join(repo, 'CASE.ts');
  if (!existsSync(otherCase)) {
    t.skip('file system is case-sensitive');
    return;
  }
  sh('config', 'core.ignorecase', 'true');
  const working = text('one', 'two');
  await writeFile(file, working);

  const { state } = await applyLines(otherCase, working, 'stage', 1, 1);

  assert.equal(state.relPath, 'Case.ts');
  assert.deepEqual(sh('ls-files').split('\n').filter((p) => p.toLowerCase() === 'case.ts'), ['Case.ts']);
  assert.equal(sh('show', ':Case.ts'), working);
});

test('reports files that no longer exist on disk', async () => {
  assert.equal((await git.fileState(join(repo, 'deleted', 'gone.ts'))).kind, 'missing');
});

test('reports ignored files and files outside a repository', async () => {
  const ignored = join(repo, 'ignored.txt');
  await writeFile(ignored, 'secret\n');
  assert.equal((await git.fileState(ignored)).kind, 'ignored');

  const outsideDir = await mkdtemp(join(tmpdir(), 'chunk-stage-outside-'));
  try {
    const outside = join(outsideDir, 'loose.txt');
    await writeFile(outside, 'x\n');
    assert.equal((await git.fileState(outside)).kind, 'outside');
  } finally {
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('refuses to overwrite an index entry that changed after it was read', async () => {
  const file = join(repo, 'app.ts');
  await writeFile(file, text('function a() {', '  return 5;', '}'));
  const stale = await git.fileState(file);
  sh('add', '--', 'app.ts');

  assert.ok(stale.kind === 'tracked');
  await assert.rejects(git.writeIndex(stale, Buffer.from('nope\n')), /changed in the meantime/);
  assert.equal(sh('show', ':app.ts'), text('function a() {', '  return 5;', '}'));
});

test('refuses files that use git filters', async () => {
  await writeFile(join(repo, '.gitattributes'), '*.lfs filter=lfs\n');
  const file = join(repo, 'big.lfs');
  await writeFile(file, 'data\n');
  assert.equal((await git.fileState(file)).kind, 'unsupported');
});
