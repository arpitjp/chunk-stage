import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { computeFileDiff } from '../diff';
import { StageableState } from '../git';
import { Snapshot, formatCounts, indexContent, planFor } from '../plan';

const text = (...lines: string[]): string => lines.map((l) => `${l}\n`).join('');

const tracked: StageableState = {
  kind: 'tracked',
  root: '/repo',
  relPath: 'file.ts',
  filePath: '/repo/file.ts',
  mode: '100644',
  sha: 'index',
  head: { mode: '100644', sha: 'head' },
};

function snapshot(head: string, index: string, working: string, state: StageableState = tracked): Snapshot {
  return {
    state,
    version: 1,
    bom: false,
    unstaged: computeFileDiff(index, working),
    staged: state.kind === 'tracked' ? computeFileDiff(index, head) : undefined,
  };
}

function result(s: Snapshot, action: 'stage' | 'unstage', start: number, end: number): string | null | undefined {
  const plan = planFor(s, action, [{ start, end }]);
  if (!plan) {
    return undefined;
  }
  const content = indexContent(s, plan);
  return content && content.bytes.toString('utf8');
}

// HEAD: a b c. Index: b became B, d was added. Editor: e was added on top of that.
const head = text('a', 'b', 'c');
const index = text('a', 'B', 'c', 'd');
const working = text('a', 'B', 'c', 'd', 'e');

test('stage takes unstaged lines from the editor', () => {
  assert.equal(result(snapshot(head, index, working), 'stage', 4, 4), text('a', 'B', 'c', 'd', 'e'));
  assert.equal(result(snapshot(head, index, working), 'stage', 0, 3), undefined);
});

test('unstage puts selected lines back to their HEAD version', () => {
  const s = snapshot(head, index, working);
  assert.equal(result(s, 'unstage', 1, 1), text('a', 'b', 'c', 'd'));
  assert.equal(result(s, 'unstage', 3, 3), text('a', 'B', 'c'));
  assert.equal(result(s, 'unstage', 4, 4), undefined);
});

test('unstage works through lines that were edited again after staging', () => {
  // Index has B; the editor changed it further to B2. Selecting B2 unstages B.
  const s = snapshot(head, index, text('a', 'B2', 'c', 'd'));
  assert.equal(result(s, 'unstage', 1, 1), text('a', 'b', 'c', 'd'));
});

test('unstage counts describe the staged change being undone', () => {
  const plan = planFor(snapshot(head, index, working), 'unstage', [{ start: 1, end: 3 }]);
  assert.ok(plan);
  assert.equal(formatCounts(plan), '+2 −1');
});

test('unstaging all of a file that is not in HEAD removes it from the index', () => {
  const newFile: StageableState = { ...tracked, head: null } as StageableState;
  const s = snapshot('', text('x', 'y'), text('x', 'y', 'z'), newFile);
  assert.equal(result(s, 'unstage', 0, 1), null);
  assert.equal(result(s, 'unstage', 0, 0), text('y'));
});

test('untracked files can be staged but have nothing to unstage', () => {
  const untracked: StageableState = { kind: 'untracked', root: '/repo', relPath: 'new.ts', filePath: '/repo/new.ts' };
  const s = snapshot('', '', text('x', 'y'), untracked);
  assert.equal(result(s, 'stage', 1, 1), text('y'));
  assert.equal(result(s, 'unstage', 0, 1), undefined);
});

test('stage takes blank and whitespace-only lines around the selection along', () => {
  const s = snapshot('', text('a', 'c'), text('a', '', '  ', 'b', '\t', 'c'), tracked);
  assert.equal(result(s, 'stage', 3, 3), text('a', '', '  ', 'b', '\t', 'c'));
});

test('snapped blank lines are staged but not counted', () => {
  const s = snapshot('', text('a', 'c'), text('a', '', 'b', '', 'c'), tracked);
  const plan = planFor(s, 'stage', [{ start: 2, end: 2 }]);
  assert.ok(plan);
  assert.equal(formatCounts(plan), '+1');
  assert.equal(result(s, 'stage', 2, 2), text('a', '', 'b', '', 'c'));
});

test('blank lines alone are not staged when the selection has no changes of its own', () => {
  const index = text('a', 'c');
  const s = snapshot(index, index, text('a', '', 'c'));
  assert.equal(result(s, 'stage', 0, 0), undefined);
  assert.equal(result(s, 'stage', 1, 1), text('a', '', 'c'));
});

test('blank-line snapping stops at the first non-blank line', () => {
  const s = snapshot('', text('a', 'c'), text('a', 'x', '', 'b', 'c'), tracked);
  assert.equal(result(s, 'stage', 3, 3), text('a', '', 'b', 'c'));
});

test('blank-line snapping never pulls in a deletion the selection does not span', () => {
  const index = text('f1', '', 'dead', '', 'f2');
  const s = snapshot(index, index, text('f1 changed', '', '', 'f2'));
  assert.equal(result(s, 'stage', 0, 0), text('f1 changed', '', 'dead', '', 'f2'));
});

test('blank-line snapping stops before a block that would have to be taken whole', () => {
  const index = text('u', 'k1', 'z');
  const s = snapshot(index, index, text('u', '', 'x', 'z'));
  assert.equal(result(s, 'stage', 0, 0), undefined);
});

test('unstage takes exactly the selected lines, without blank lines around them', () => {
  const s = snapshot(text('a', 'c'), text('a', '', 'b', '', 'c'), text('a', '', 'b', '', 'c'));
  assert.equal(result(s, 'unstage', 2, 2), text('a', '', '', 'c'));
});

test('the last stage also takes blank lines left elsewhere in the file', () => {
  const s = snapshot('', text('a', 'b', 'c'), text('a', '', 'b', 'x', 'c', ''), tracked);
  assert.equal(result(s, 'stage', 3, 3), text('a', '', 'b', 'x', 'c', ''));
  assert.equal(formatCounts(planFor(s, 'stage', [{ start: 3, end: 3 }])!), '+1');
  // Not while other changes are still unstaged.
  const partial = snapshot('', text('a', 'b', 'c'), text('a', '', 'y', 'b', 'x', 'c'), tracked);
  assert.equal(result(partial, 'stage', 4, 4), text('a', 'b', 'x', 'c'));
});

test('the last stage leaves a partly staged block alone when real lines of it remain', () => {
  const s = snapshot('', text('a', 'c'), text('a', 'x', 'y', 'c', ''), tracked);
  assert.equal(result(s, 'stage', 1, 1), text('a', 'x', 'c'));
});

test('the last stage also takes a missing final newline', () => {
  const s = snapshot('', 'a\nb\nc', 'a\nx\nb\nc\n', tracked);
  assert.equal(result(s, 'stage', 1, 1), 'a\nx\nb\nc\n');
});

test('stage plans say which editor lines and gaps they touch, snapped blank lines excluded', () => {
  const added = planFor(snapshot('', text('a', 'c'), text('a', '', 'b', '', 'c'), tracked), 'stage', [{ start: 2, end: 2 }]);
  assert.deepEqual(added && { lines: added.lines, gaps: added.gaps }, { lines: [{ start: 2, end: 2 }], gaps: [] });

  const index = text('a', 'b', 'c', 'd');
  const removed = planFor(snapshot(index, index, text('a', 'd')), 'stage', [{ start: 0, end: 1 }]);
  assert.deepEqual(removed && { lines: removed.lines, gaps: removed.gaps }, { lines: [], gaps: [1] });
});

test('unstage plans map the staged lines they touch back onto editor lines', () => {
  const s = snapshot(head, index, working);
  assert.deepEqual(planFor(s, 'unstage', [{ start: 3, end: 3 }])?.lines, [{ start: 3, end: 3 }]);

  // HEAD a b c; b's removal is staged; the editor added x at the end.
  const removal = snapshot(text('a', 'b', 'c'), text('a', 'c'), text('a', 'c', 'x'));
  const plan = planFor(removal, 'unstage', [{ start: 0, end: 1 }]);
  assert.deepEqual(plan && { lines: plan.lines, gaps: plan.gaps }, { lines: [], gaps: [1] });
});

test('formatCounts', () => {
  assert.equal(formatCounts({ added: 3, removed: 2 }), '+3 −2');
  assert.equal(formatCounts({ added: 0, removed: 2 }), '−2');
  assert.equal(formatCounts({ added: 1, removed: 0 }), '+1');
});
