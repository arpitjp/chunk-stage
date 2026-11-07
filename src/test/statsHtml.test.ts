import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { recordOp, summarize } from '../stats';
import { renderStatsHtml, smoothPath } from '../statsHtml';

test('smooth curves never overshoot the points they pass through', () => {
  const ys = [0, 0, 40, 5, 0, 30, 30, 0];
  const path = smoothPath(ys.map((y, i) => [i * 10, y]));
  const values = [...path.matchAll(/-?\d+\.\d,(-?\d+\.\d)/g)].map((m) => Number(m[1]));
  assert.ok(values.every((y) => y >= 0 && y <= 40), path);
});

test('the page renders both charts with stats, and a hint without', () => {
  const now = new Date(2026, 10, 7, 12);
  const stats = recordOp(recordOp(undefined, 'stage', 5, now), 'unstage', 2, now);
  const html = renderStatsHtml(stats, summarize(stats, now));
  assert.match(html, /class="line stage"/);
  assert.match(html, /class="line unstage"/);
  assert.match(html, /class="cell stage l4 today"/);
  assert.doesNotMatch(html, /<script/);
  assert.match(renderStatsHtml(undefined, summarize(undefined, now)), /Nothing yet/);
});
