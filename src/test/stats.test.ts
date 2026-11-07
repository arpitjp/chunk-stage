import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HISTORY_DAYS, Stats, dayKey, recordOp, summarize } from '../stats';

const at = (day: number, hour = 12) => new Date(2026, 10, day, hour);

test('recordOp counts operations and lines per kind and per day', () => {
  let stats = recordOp(undefined, 'stage', 5, at(7));
  stats = recordOp(stats, 'unstage', 2, at(7));
  stats = recordOp(stats, 'undo', 0, at(8));
  assert.equal(stats.since, '2026-11-07');
  assert.deepEqual(
    { stages: stats.stages, unstages: stats.unstages, undos: stats.undos, staged: stats.linesStaged, unstaged: stats.linesUnstaged },
    { stages: 1, unstages: 1, undos: 1, staged: 5, unstaged: 2 },
  );
  assert.deepEqual(stats.days, {
    '2026-11-07': { ops: 2, staged: 5, unstaged: 2 },
    '2026-11-08': { ops: 1, staged: 0, unstaged: 0 },
  });
});

test('recordOp keeps totals but forgets days beyond the history', () => {
  const old = recordOp(undefined, 'stage', 3, new Date(2026, 6, 1));
  const stats = recordOp(old, 'stage', 1, at(7));
  assert.deepEqual(Object.keys(stats.days), ['2026-11-07']);
  assert.equal(stats.linesStaged, 4);
});

test('days stored before staged and unstaged were split count as staged', () => {
  const legacy = { ...recordOp(undefined, 'stage', 1, at(6)), days: { '2026-11-06': { ops: 2, lines: 9 } } } as unknown as Stats;
  assert.deepEqual(recordOp(legacy, 'unstage', 1, at(7)).days['2026-11-06'], { ops: 2, staged: 9, unstaged: 0 });
  assert.deepEqual(summarize(legacy, at(7)).bestDay, { day: '2026-11-06', lines: 9 });
});

test('dayKey uses the local calendar day', () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('the streak counts back from today, or from yesterday until today has activity', () => {
  let stats: Stats | undefined;
  for (const day of [3, 5, 6]) {
    stats = recordOp(stats, 'stage', 1, at(day));
  }
  assert.equal(summarize(stats, at(7)).streak, 2);
  assert.equal(summarize(recordOp(stats, 'stage', 1, at(7)), at(7)).streak, 3);
  assert.equal(summarize(stats, at(8)).streak, 0);
});

test('summarize compares today with a typical active day and finds the best day', () => {
  let stats = recordOp(undefined, 'stage', 10, at(5));
  stats = recordOp(stats, 'stage', 25, at(6));
  stats = recordOp(stats, 'unstage', 5, at(6));
  stats = recordOp(stats, 'stage', 4, at(7));
  const summary = summarize(stats, at(7));
  assert.deepEqual({ ops: summary.today.ops, staged: summary.today.staged }, { ops: 1, staged: 4 });
  assert.deepEqual(summary.typicalDay, { ops: 2, lines: 20 });
  assert.deepEqual(summary.bestDay, { day: '2026-11-06', lines: 30 });
});

test('the history covers whole weeks and ends today', () => {
  const { history } = summarize(undefined, at(7));
  assert.equal(history.length, HISTORY_DAYS);
  assert.equal(HISTORY_DAYS % 7, 0);
  assert.deepEqual({ day: history[history.length - 1].day, weekday: history[history.length - 1].weekday }, { day: '2026-11-07', weekday: 6 });
});

test('summarize works with no stats at all', () => {
  const summary = summarize(undefined, at(7));
  assert.equal(summary.streak, 0);
  assert.equal(summary.bestDay, undefined);
  assert.deepEqual(summary.typicalDay, { ops: 0, lines: 0 });
});
