/** Usage counters behind the stats page; plain data, independent of VS Code. */

export type StatKind = 'stage' | 'unstage' | 'undo';

export interface DayStats {
  ops: number;
  staged: number;
  unstaged: number;
}

/** Thirteen full weeks: as much as the heat map shows, and as much as is kept. */
export const HISTORY_DAYS = 91;

const NO_DAY: DayStats = { ops: 0, staged: 0, unstaged: 0 };

/** Stored days from before staged and unstaged lines were counted separately had only `lines`. */
function readDay(value: Partial<DayStats> & { lines?: number }): DayStats {
  return { ops: value.ops ?? 0, staged: value.staged ?? value.lines ?? 0, unstaged: value.unstaged ?? 0 };
}

export function linesOf(day: DayStats): number {
  return day.staged + day.unstaged;
}

export interface Stats {
  /** Day of the first recorded operation, as a `dayKey`. */
  since: string;
  stages: number;
  unstages: number;
  /** Undos and redos together. */
  undos: number;
  linesStaged: number;
  linesUnstaged: number;
  /** Recent days only; see `HISTORY_DAYS`. */
  days: Record<string, DayStats>;
}

/** Local calendar day, e.g. "2026-11-07". */
export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysBefore(date: Date, n: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - n);
}

/** `stats` with one more operation of `kind` that changed `lines` lines. */
export function recordOp(stats: Stats | undefined, kind: StatKind, lines: number, now: Date): Stats {
  const today = dayKey(now);
  const oldest = dayKey(daysBefore(now, HISTORY_DAYS - 1));
  const days: Record<string, DayStats> = {};
  for (const [day, value] of Object.entries(stats?.days ?? {})) {
    if (day >= oldest) {
      days[day] = readDay(value);
    }
  }
  const day = days[today] ?? NO_DAY;
  days[today] = {
    ops: day.ops + 1,
    staged: day.staged + (kind === 'stage' ? lines : 0),
    unstaged: day.unstaged + (kind === 'unstage' ? lines : 0),
  };
  const base = stats ?? { since: today, stages: 0, unstages: 0, undos: 0, linesStaged: 0, linesUnstaged: 0, days };
  return {
    ...base,
    stages: base.stages + (kind === 'stage' ? 1 : 0),
    unstages: base.unstages + (kind === 'unstage' ? 1 : 0),
    undos: base.undos + (kind === 'undo' ? 1 : 0),
    linesStaged: base.linesStaged + (kind === 'stage' ? lines : 0),
    linesUnstaged: base.linesUnstaged + (kind === 'unstage' ? lines : 0),
    days,
  };
}

export type DayEntry = { day: string; /** 0 = Sunday. */ weekday: number } & DayStats;

export interface Summary {
  today: DayEntry;
  /** Lines and operations on an average active day in the last 30, today excluded. */
  typicalDay: { ops: number; lines: number };
  /** Consecutive active days up to today, or up to yesterday while today has nothing yet. */
  streak: number;
  bestDay: { day: string; lines: number } | undefined;
  /** The last `HISTORY_DAYS` days, oldest first, today last. */
  history: DayEntry[];
}

export function summarize(stats: Stats | undefined, now: Date): Summary {
  const days = stats?.days ?? {};
  const get = (n: number): DayEntry => {
    const date = daysBefore(now, n);
    const day = dayKey(date);
    return { day, weekday: date.getDay(), ...(days[day] ? readDay(days[day]) : NO_DAY) };
  };
  const history = Array.from({ length: HISTORY_DAYS }, (_, i) => get(HISTORY_DAYS - 1 - i));
  const today = history[history.length - 1];

  let streak = 0;
  for (let n = today.ops > 0 ? 0 : 1; get(n).ops > 0; n++) {
    streak++;
  }

  const earlier = history.slice(-30, -1).filter((d) => d.ops > 0);
  const average = (pick: (d: DayStats) => number) =>
    earlier.length === 0 ? 0 : Math.round(earlier.reduce((sum, d) => sum + pick(d), 0) / earlier.length);

  let bestDay: Summary['bestDay'];
  for (const [day, value] of Object.entries(days)) {
    const lines = linesOf(readDay(value));
    if (lines > 0 && (!bestDay || lines > bestDay.lines)) {
      bestDay = { day, lines };
    }
  }

  return {
    today,
    typicalDay: { ops: average((d) => d.ops), lines: average(linesOf) },
    streak,
    bestDay,
    history,
  };
}
