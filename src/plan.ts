import {
  FileDiff,
  LineRange,
  Piece,
  blankNeighbours,
  mapRange,
  mapRangeToOld,
  renderPieces,
  selectChanges,
  selectPieces,
  summarize,
} from './diff';
import { StageableState } from './git';

export const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export type Action = 'stage' | 'unstage';

/** Everything needed to stage or unstage lines of one editor document. */
export interface Snapshot {
  state: StageableState;
  /** Document version the diffs were computed for. */
  version: number;
  /** Whether the staged blob starts with a UTF-8 BOM. */
  bom: boolean;
  /** Index -> editor text: what can be staged. */
  unstaged: FileDiff;
  /** Index -> HEAD: what can be unstaged. Missing for untracked files or unreadable HEAD versions. */
  staged: FileDiff | undefined;
}

export interface Plan {
  action: Action;
  /** Diff whose old side is the current index version; `pieces` apply to it. */
  diff: FileDiff;
  pieces: Piece[];
  /** Size of the change being staged or unstaged, counted like `git diff` would. */
  added: number;
  removed: number;
  /** Where the plan shows in the editor: the lines it changes... */
  lines: LineRange[];
  /** ...and, for changed lines that only exist outside the editor text, the editor line they sit above. */
  gaps: number[];
}

/**
 * What staging or unstaging `ranges` (editor lines) would do, or undefined if
 * nothing. When staging, blank lines around the selection come along, but only
 * when the selection itself has changes, and they don't count towards
 * `added`/`removed`. Unstaging takes exactly the selected lines.
 */
export function planFor(snapshot: Snapshot, action: Action, ranges: LineRange[]): Plan | undefined {
  const { unstaged, staged } = snapshot;
  if (action === 'stage') {
    const selected = selectPieces(unstaged.changes, ranges, 'new', unstaged.newLines.length);
    if (selected.length === 0) {
      return undefined;
    }
    const blanks = blankNeighbours(unstaged.newLines, unstaged.changes, ranges, 'new');
    const { pieces, lines, gaps } = selectChanges(
      unstaged.changes,
      [...ranges, ...blanks],
      'new',
      unstaged.newLines.length,
      ranges,
    );
    const { added, removed } = summarize(selected);
    return { action, diff: unstaged, pieces, added, removed, lines, gaps };
  }

  if (!staged) {
    return undefined;
  }
  // Editor lines are mapped onto index lines first; staged changes live between the index and HEAD.
  const indexRanges = ranges.map((r) => mapRangeToOld(unstaged.changes, r));
  const selection = selectChanges(staged.changes, indexRanges, 'old', staged.oldLines.length);
  if (selection.pieces.length === 0) {
    return undefined;
  }
  // The pieces turn index lines back into HEAD lines, the reverse of the staged change.
  const { added: removed, removed: added } = summarize(selection.pieces);
  const toEditor = (r: LineRange) => mapRange(unstaged.changes, r, 'old');
  return {
    action,
    diff: staged,
    pieces: selection.pieces,
    added,
    removed,
    lines: selection.lines.map(toEditor).filter((r) => r.end >= r.start),
    gaps: selection.gaps.map((gap) => toEditor({ start: gap, end: gap }).start),
  };
}

export interface IndexContent {
  /** The new index version as text, without a BOM. */
  text: string;
  /** Exactly the bytes to store, including a BOM when the file has one. */
  bytes: Buffer;
}

/** The new index version, or null when the file should leave the index. */
export function indexContent(snapshot: Snapshot, plan: Plan): IndexContent | null {
  const text = renderPieces(plan.diff, plan.pieces);
  // Unstaging all of a file that isn't in HEAD makes it untracked again, like `git restore --staged`.
  if (plan.action === 'unstage' && snapshot.state.kind === 'tracked' && !snapshot.state.head && text === '') {
    return null;
  }
  const body = Buffer.from(text, 'utf8');
  return { text, bytes: snapshot.bom ? Buffer.concat([UTF8_BOM, body]) : body };
}

export function formatCounts({ added, removed }: { added: number; removed: number }): string {
  const parts: string[] = [];
  if (added > 0) {
    parts.push(`+${added}`);
  }
  if (removed > 0) {
    parts.push(`−${removed}`);
  }
  return parts.join(' ');
}
