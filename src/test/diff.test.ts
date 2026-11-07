import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  Change,
  Side,
  computeChanges,
  computeFileDiff,
  mapRange,
  mapRangeToOld,
  renderPieces,
  selectPieces,
  splitLines,
  wholeChange,
} from '../diff';

const text = (...lines: string[]): string => lines.map((l) => `${l}\n`).join('');

/** The old text with the changes on lines `start..end` of `side` applied. */
function apply(oldText: string, newText: string, start: number, end: number, side: Side = 'new'): string {
  const diff = computeFileDiff(oldText, newText);
  const lineCount = side === 'new' ? diff.newLines.length : diff.oldLines.length;
  return renderPieces(diff, selectPieces(diff.changes, [{ start, end }], side, lineCount));
}

test('splitLines keeps terminators', () => {
  assert.deepEqual(splitLines('a\nb\r\nc'), ['a\n', 'b\r\n', 'c']);
  assert.deepEqual(splitLines('a\n'), ['a\n']);
  assert.deepEqual(splitLines(''), []);
});

test('identical text has no changes, even with different line endings', () => {
  assert.deepEqual(computeFileDiff(text('a', 'b'), text('a', 'b')).changes, []);
  assert.deepEqual(computeFileDiff('a\r\nb\r\n', 'a\nb\n').changes, []);
});

test('a missing newline at end of file is a change', () => {
  const changes = computeFileDiff('a\nb', 'a\nb\n').changes;
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].oldLines, ['b']);
  assert.deepEqual(changes[0].newLines, ['b\n']);
});

test('a new function appended after a modified one keeps its own closing brace', () => {
  const oldText = text('function a() {', '  return 1;', '}');
  const newText = text('function a() {', '  return 2;', '}', '', 'function b() {', '  return 3;', '}');

  assert.equal(apply(oldText, newText, 4, 6), text('function a() {', '  return 1;', '}', 'function b() {', '  return 3;', '}'));
  assert.equal(apply(oldText, newText, 0, 2), text('function a() {', '  return 2;', '}'));
});

test('selected lines of a brand-new file', () => {
  const newText = text('import x from "x";', '', 'function a() {', '}');
  assert.equal(apply('', newText, 2, 3), text('function a() {', '}'));
});

test('unchanged lines in the selection are ignored', () => {
  const oldText = text('a', 'b', 'c');
  assert.equal(apply(oldText, text('a', 'B', 'c'), 0, 0), oldText);
  assert.equal(apply(oldText, text('a', 'B', 'c'), 0, 2), text('a', 'B', 'c'));
});

test('part of a pure addition', () => {
  assert.equal(apply(text('a', 'c'), text('a', 'b1', 'b2', 'c'), 2, 2), text('a', 'b2', 'c'));
});

test('part of a one-to-one modification pairs lines', () => {
  assert.equal(apply(text('x1', 'x2', 'x3'), text('y1', 'y2', 'y3'), 1, 1), text('x1', 'y2', 'x3'));
});

test('part of an uneven modification takes the whole block', () => {
  assert.equal(apply(text('x1'), text('y1', 'y2', 'y3'), 2, 2), text('y1', 'y2', 'y3'));
  assert.equal(apply(text('x1', 'x2', 'x3', 'x4'), text('y1', 'y2'), 1, 1), text('y1', 'y2'));
});

test('a deletion is included only when the selection covers both of its neighbours', () => {
  const oldText = text('a', 'b', 'c', 'd');
  const newText = text('a', 'd');
  assert.equal(apply(oldText, newText, 0, 0), oldText);
  assert.equal(apply(oldText, newText, 1, 1), oldText);
  assert.equal(apply(oldText, newText, 0, 1), newText);
});

test('deletions at the start or end of the file are included from the first or last line', () => {
  assert.equal(apply(text('a', 'b', 'c'), text('b'), 0, 0), text('b'));
});

test('selecting old-side lines removes just those lines from a pure removal', () => {
  assert.equal(apply(text('a', 'b', 'c', 'd'), text('a', 'd'), 1, 1, 'old'), text('a', 'c', 'd'));
});

test('mapRangeToOld follows unchanged lines and widens over changes', () => {
  const { changes } = computeFileDiff(text('a', 'b', 'c'), text('a', 'X', 'Y', 'b', 'c'));
  assert.deepEqual(mapRangeToOld(changes, { start: 3, end: 3 }), { start: 1, end: 1 });
  assert.deepEqual(mapRangeToOld(changes, { start: 0, end: 3 }), { start: 0, end: 1 });
  // Only added lines selected: no old lines.
  const inside = mapRangeToOld(changes, { start: 1, end: 2 });
  assert.ok(inside.end < inside.start);

  const modified = computeFileDiff(text('a', 'b1', 'b2', 'c'), text('a', 'B', 'c')).changes;
  assert.deepEqual(mapRangeToOld(modified, { start: 1, end: 1 }), { start: 1, end: 2 });
  assert.deepEqual(mapRangeToOld(modified, { start: 2, end: 2 }), { start: 3, end: 3 });

  // And back: old lines inside a change map to its whole new block.
  assert.deepEqual(mapRange(modified, { start: 2, end: 2 }, 'old'), { start: 1, end: 1 });
  assert.deepEqual(mapRange(modified, { start: 3, end: 3 }, 'old'), { start: 2, end: 2 });
});

test('adds a line break when inserting after a last line that had none', () => {
  assert.equal(apply('a\nb', 'a\nb\nc\n', 1, 2), 'a\nb\nc\n');
});

test('keeps the old version line endings for copied lines', () => {
  assert.equal(apply('a\r\nb\r\n', 'a\nb\nc\n', 2, 2), 'a\r\nb\r\nc\r\n');
});

test('falls back to one change when the diff needs too many edits', () => {
  const changes = computeChanges(splitLines(text('a', 'b', 'c')), splitLines(text('x', 'b', 'y')), 1);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].oldLines.length, 3);
});

test('random edits: changes line up, and any selection on either side gives a valid file', () => {
  const random = seededRandom(42);
  const alphabet = ['}', '', 'a', 'b', 'c', '  x();', 'function f() {', 'return;'];
  const pick = (): string => alphabet[Math.floor(random() * alphabet.length)];

  for (let round = 0; round < 500; round++) {
    const oldLines = Array.from({ length: Math.floor(random() * 30) }, pick);
    const newLines = [...oldLines];
    for (let e = Math.floor(random() * 6); e > 0; e--) {
      const at = Math.floor(random() * (newLines.length + 1));
      const inserted = Array.from({ length: Math.floor(random() * 4) }, pick);
      newLines.splice(at, Math.floor(random() * 3), ...inserted);
    }
    const oldText = text(...oldLines);
    const newText = text(...newLines);
    const diff = computeFileDiff(oldText, newText);

    assertAligned(diff.changes, diff.oldLines, diff.newLines);
    assert.equal(renderPieces(diff, diff.changes.map(wholeChange)), newText);
    assert.equal(renderPieces(diff, []), oldText);

    for (const side of ['new', 'old'] as const) {
      const lineCount = side === 'new' ? newLines.length : oldLines.length;
      const start = Math.floor(random() * (lineCount + 1));
      const range = { start, end: start + Math.floor(random() * 5) };
      const staged = renderPieces(diff, selectPieces(diff.changes, [range], side, lineCount));
      assert.ok(staged === '' || staged.endsWith('\n'));
      // Selecting everything always reproduces the new text.
      const all = selectPieces(diff.changes, [{ start: 0, end: lineCount }], side, lineCount);
      assert.equal(renderPieces(diff, all), newText);
    }
  }
});

function assertAligned(changes: Change[], oldLines: string[], newLines: string[]): void {
  let oldCursor = 0;
  let newCursor = 0;
  for (const c of changes) {
    assert.equal(c.oldIndex - oldCursor, c.newIndex - newCursor, 'unchanged runs must have equal length');
    assert.deepEqual(oldLines.slice(oldCursor, c.oldIndex), newLines.slice(newCursor, c.newIndex));
    assert.deepEqual(oldLines.slice(c.oldIndex, c.oldIndex + c.oldLines.length), c.oldLines);
    assert.deepEqual(newLines.slice(c.newIndex, c.newIndex + c.newLines.length), c.newLines);
    oldCursor = c.oldIndex + c.oldLines.length;
    newCursor = c.newIndex + c.newLines.length;
  }
  assert.deepEqual(oldLines.slice(oldCursor), newLines.slice(newCursor));
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}
