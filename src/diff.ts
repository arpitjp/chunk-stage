/**
 * Line diffing and partial staging, independent of VS Code and git.
 *
 * Lines keep their terminators ("\n", "\r\n", or none for a final line without
 * a newline), so joining them reproduces the original text exactly.
 */

/** A contiguous difference between an old and a new version. */
export interface Change {
  /** Index of the first affected line in the old version. */
  oldIndex: number;
  oldLines: string[];
  /**
   * Index of the first affected line in the new version. When the change has
   * no new lines, this is the new line that follows the removed block.
   */
  newIndex: number;
  newLines: string[];
}

/** An edit to the old version: `oldCount` lines at `oldIndex` become `newLines`. */
export interface Piece {
  oldIndex: number;
  oldCount: number;
  newLines: string[];
}

/** Inclusive, 0-based range of lines. */
export interface LineRange {
  start: number;
  end: number;
}

/** Which version a set of line numbers refers to. */
export type Side = 'old' | 'new';

export interface FileDiff {
  oldLines: string[];
  newLines: string[];
  changes: Change[];
  /** Line terminator used when copying new lines into the old version. */
  eol: string;
}

/** Diffs whose middle part needs more edits than this become a single change. */
export const DEFAULT_MAX_EDITS = 1000;

export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
    lines.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

export function detectEol(text: string): string | undefined {
  const nl = text.indexOf('\n');
  if (nl === -1) {
    return undefined;
  }
  return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
}

export function computeFileDiff(oldText: string, newText: string, maxEdits = DEFAULT_MAX_EDITS): FileDiff {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  return {
    oldLines,
    newLines,
    changes: computeChanges(oldLines, newLines, maxEdits),
    eol: detectEol(oldText) ?? detectEol(newText) ?? '\n',
  };
}

/** Line diff where CRLF and LF terminators compare equal. */
export function computeChanges(oldLines: string[], newLines: string[], maxEdits = DEFAULT_MAX_EDITS): Change[] {
  const ids = new Map<string, number>();
  const toId = (line: string): number => {
    const key = line.endsWith('\r\n') ? line.slice(0, -2) + '\n' : line;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    return id;
  };
  const a = oldLines.map(toId);
  const b = newLines.map(toId);
  const changedA = new Uint8Array(a.length);
  const changedB = new Uint8Array(b.length);
  markChanges(a, b, changedA, changedB, maxEdits);
  compact(a, changedA);
  compact(b, changedB);
  return collectChanges(oldLines, newLines, changedA, changedB);
}

/**
 * The parts of `changes` touched by `ranges`, given as line numbers of `side`
 * (which has `lineCount` lines). Pieces always apply to the old version.
 *
 * Lines that only exist on the other side sit in a gap between two lines of
 * `side`; they're included when a range covers both neighbours, or touches the
 * first/last line for a gap at the start/end of the file.
 *
 * A partly selected block is split only where that is unambiguous: pure
 * additions or removals, and blocks where each old line became exactly one new
 * line. Any other partly selected block is taken whole.
 *
 * `gapRanges` (default: `ranges`) are the ranges allowed to cover gaps.
 */
export function selectPieces(
  changes: Change[],
  ranges: LineRange[],
  side: Side,
  lineCount: number,
  gapRanges: LineRange[] = ranges,
): Piece[] {
  return selectChanges(changes, ranges, side, lineCount, gapRanges).pieces;
}

/** What `selectPieces` picks, plus where on `side` those changes are. */
export interface Selection {
  pieces: Piece[];
  /** Lines of `side` that the pieces change. */
  lines: LineRange[];
  /** Gaps of `side` whose other-side lines the pieces change, as the index of the line after the gap. */
  gaps: number[];
}

export function selectChanges(
  changes: Change[],
  ranges: LineRange[],
  side: Side,
  lineCount: number,
  gapRanges: LineRange[] = ranges,
): Selection {
  const merged = mergeRanges(ranges);
  const gapMerged = gapRanges === ranges ? merged : mergeRanges(gapRanges);
  const selection: Selection = { pieces: [], lines: [], gaps: [] };
  for (const change of changes) {
    const start = side === 'new' ? change.newIndex : change.oldIndex;
    const length = side === 'new' ? change.newLines.length : change.oldLines.length;
    if (length === 0) {
      if (gapMerged.some((r) => coversGap(r, start, lineCount))) {
        selection.pieces.push(wholeChange(change));
        selection.gaps.push(start);
      }
      continue;
    }
    const parts: Array<[number, number]> = [];
    for (const r of merged) {
      const from = Math.max(r.start, start);
      const to = Math.min(r.end, start + length - 1);
      if (from <= to) {
        parts.push([from - start, to - start]);
      }
    }
    if (parts.length === 0) {
      continue;
    }
    const m = change.oldLines.length;
    const n = change.newLines.length;
    const isWhole = parts.length === 1 && parts[0][0] === 0 && parts[0][1] === length - 1;
    if (isWhole || (m > 0 && n > 0 && m !== n)) {
      selection.pieces.push(wholeChange(change));
      selection.lines.push({ start, end: start + length - 1 });
    } else {
      for (const [first, last] of parts) {
        selection.pieces.push(partOf(change, first, last));
        selection.lines.push({ start: start + first, end: start + last });
      }
    }
  }
  return selection;
}

/**
 * Runs of blank (empty or whitespace-only) lines of `side` directly above and
 * below `ranges`, so a selected block takes its surrounding blank lines along.
 * A run stops before a line whose change would have to be taken whole
 * (see `selectPieces`), so snapping never pulls in more than blank lines.
 */
export function blankNeighbours(lines: string[], changes: Change[], ranges: LineRange[], side: Side): LineRange[] {
  const snappable = (line: number) =>
    line >= 0 && line < lines.length && lines[line].trim() === '' && !inUnevenChange(changes, line, side);
  const extra: LineRange[] = [];
  for (const range of mergeRanges(ranges)) {
    let start = range.start;
    let end = range.end;
    while (snappable(start - 1)) {
      start--;
    }
    while (snappable(end + 1)) {
      end++;
    }
    if (start < range.start) {
      extra.push({ start, end: range.start - 1 });
    }
    if (end > range.end) {
      extra.push({ start: range.end + 1, end });
    }
  }
  return extra;
}

/**
 * Maps a range of new-version lines to the old-version lines it spans. Lines
 * inside a change map to that change's whole old block.
 */
export function mapRangeToOld(changes: Change[], range: LineRange): LineRange {
  return mapRange(changes, range, 'new');
}

/** Like `mapRangeToOld`, from either side to the other. */
export function mapRange(changes: Change[], range: LineRange, from: Side): LineRange {
  return { start: mapLine(changes, range.start, from, true), end: mapLine(changes, range.end, from, false) };
}

export function wholeChange(change: Change): Piece {
  return { oldIndex: change.oldIndex, oldCount: change.oldLines.length, newLines: change.newLines };
}

/** The old version with only `pieces` applied. */
export function renderPieces(diff: FileDiff, pieces: Piece[]): string {
  return applyPieces(diff.oldLines, pieces, diff.eol);
}

export function applyPieces(oldLines: string[], pieces: Piece[], eol: string): string {
  const out: string[] = [];
  let cursor = 0;
  for (const { piece } of inOrder(pieces)) {
    if (piece.oldIndex < cursor) {
      throw new Error('Overlapping changes cannot be staged together.');
    }
    for (let k = cursor; k < piece.oldIndex; k++) {
      out.push(oldLines[k]);
    }
    for (const line of piece.newLines) {
      out.push(withEol(line, eol));
    }
    cursor = piece.oldIndex + piece.oldCount;
  }
  for (let k = cursor; k < oldLines.length; k++) {
    out.push(oldLines[k]);
  }
  // A line without a terminator can only stay last; anything after it needs a line break.
  for (let k = 0; k < out.length - 1; k++) {
    if (!out[k].endsWith('\n')) {
      out[k] += eol;
    }
  }
  return out.join('');
}

export function summarize(pieces: Piece[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const piece of pieces) {
    added += piece.newLines.length;
    removed += piece.oldCount;
  }
  return { added, removed };
}

/**
 * Whether a change only adds, removes or edits blank lines, or only adds or
 * removes a final line terminator.
 */
export function isTrivialChange(change: Change): boolean {
  const isBlank = (line: string) => line.trim() === '';
  if (change.oldLines.every(isBlank) && change.newLines.every(isBlank)) {
    return true;
  }
  return (
    change.oldLines.length === change.newLines.length &&
    change.oldLines.every((line, k) => stripEol(line) === stripEol(change.newLines[k]))
  );
}

function inOrder(pieces: Piece[]): Array<{ piece: Piece; order: number }> {
  return pieces
    .map((piece, order) => ({ piece, order }))
    .sort((x, y) => x.piece.oldIndex - y.piece.oldIndex || x.order - y.order);
}

function withEol(line: string, eol: string): string {
  const content = stripEol(line);
  return content.length === line.length ? line : content + eol;
}

function stripEol(line: string): string {
  if (line.endsWith('\r\n')) {
    return line.slice(0, -2);
  }
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

function inUnevenChange(changes: Change[], line: number, side: Side): boolean {
  return changes.some((change) => {
    const m = change.oldLines.length;
    const n = change.newLines.length;
    const start = side === 'new' ? change.newIndex : change.oldIndex;
    const length = side === 'new' ? n : m;
    return m > 0 && n > 0 && m !== n && line >= start && line < start + length;
  });
}

function coversGap(range: LineRange, at: number, lineCount: number): boolean {
  return (
    (range.start < at && at <= range.end) ||
    (at === 0 && range.start === 0) ||
    (at === lineCount && range.end >= lineCount - 1)
  );
}

/** Lines `first..last` (relative, on the selected side) of a change that is pure or one-to-one. */
function partOf(change: Change, first: number, last: number): Piece {
  if (change.oldLines.length === 0) {
    return { oldIndex: change.oldIndex, oldCount: 0, newLines: change.newLines.slice(first, last + 1) };
  }
  const newLines = change.newLines.length === 0 ? [] : change.newLines.slice(first, last + 1);
  return { oldIndex: change.oldIndex + first, oldCount: last - first + 1, newLines };
}

function mapLine(changes: Change[], line: number, from: Side, isStart: boolean): number {
  let offset = 0;
  for (const change of changes) {
    const [fromStart, fromLength, toStart, toLength] =
      from === 'new'
        ? [change.newIndex, change.newLines.length, change.oldIndex, change.oldLines.length]
        : [change.oldIndex, change.oldLines.length, change.newIndex, change.newLines.length];
    if (line < fromStart) {
      break;
    }
    if (line < fromStart + fromLength) {
      return isStart ? toStart : toStart + toLength - 1;
    }
    offset = toStart + toLength - (fromStart + fromLength);
  }
  return line + offset;
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = ranges
    .filter((r) => r.end >= r.start)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((x, y) => x.start - y.start);
  const merged: LineRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push(r);
    }
  }
  return merged;
}

function markChanges(a: number[], b: number[], changedA: Uint8Array, changedB: Uint8Array, maxEdits: number): void {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  changedA.fill(1, start, endA);
  changedB.fill(1, start, endB);
  if (endA === start || endB === start) {
    return;
  }
  const matches = myersMatches(a.slice(start, endA), b.slice(start, endB), maxEdits);
  if (!matches) {
    return;
  }
  for (let k = 0; k < matches.length; k += 2) {
    changedA[start + matches[k]] = 0;
    changedB[start + matches[k + 1]] = 0;
  }
}

/** Matched line pairs of a shortest edit script, flattened as [x0, y0, x1, y1, ...]. */
function myersMatches(a: number[], b: number[], maxEdits: number): number[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let edits = -1;
  for (let d = 0; d <= max && edits < 0; d++) {
    if (d > maxEdits) {
      return undefined;
    }
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        edits = d;
        break;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }

  const reversed: number[] = [];
  let x = n;
  let y = m;
  for (let d = edits; d > 0; d--) {
    // trace[d - 1] holds diagonals -(d - 1)..(d - 1) at indices 0..2(d - 1).
    const prev = trace[d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[prevK + d - 1];
    const snakeStart = down ? prevX : prevX + 1;
    while (x > snakeStart) {
      x--;
      y--;
      reversed.push(y, x);
    }
    x = prevX;
    y = prevX - prevK;
  }
  while (x > 0) {
    x--;
    y--;
    reversed.push(y, x);
  }
  return reversed.reverse();
}

/**
 * Moves each changed block's alignment so the unchanged line after it matches
 * the earliest equal line inside the block. This keeps a new function's closing
 * brace with the new function instead of the one above it:
 *
 *     function a() {        function a() {
 *   -   one();            -   one();
 *   +   two();            +   two();
 *   + }                     }
 *   +                     +
 *   + function b() {      + function b() {
 *   +   three();          +   three();
 *     }                   + }
 */
function compact(lines: number[], changed: Uint8Array): void {
  const n = lines.length;
  let i = 0;
  while (i < n) {
    if (!changed[i]) {
      i++;
      continue;
    }
    let end = i;
    while (end < n && changed[end]) {
      end++;
    }
    if (end < n) {
      let k = i;
      while (k < end && lines[k] !== lines[end]) {
        k++;
      }
      if (k < end) {
        changed[k] = 0;
        changed[end] = 1;
        i = k + 1;
        continue;
      }
    }
    i = end;
  }
}

function collectChanges(oldLines: string[], newLines: string[], changedA: Uint8Array, changedB: Uint8Array): Change[] {
  const changes: Change[] = [];
  const n = oldLines.length;
  const m = newLines.length;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && !changedA[i] && !changedB[j]) {
      i++;
      j++;
      continue;
    }
    const oldIndex = i;
    const newIndex = j;
    while (i < n && changedA[i]) {
      i++;
    }
    while (j < m && changedB[j]) {
      j++;
    }
    if (i === oldIndex && j === newIndex) {
      throw new Error('Inconsistent diff alignment.');
    }
    changes.push({
      oldIndex,
      oldLines: oldLines.slice(oldIndex, i),
      newIndex,
      newLines: newLines.slice(newIndex, j),
    });
  }
  return changes;
}
