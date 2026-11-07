import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HIGHLIGHT_COLORS, parseColor } from '../colors';

const manifest = require('../../package.json') as { contributes: { colors: Array<{ id: string; defaults: unknown }> } };

test('highlight defaults match the colors contributed in package.json', () => {
  for (const { id, defaults } of Object.values(HIGHLIGHT_COLORS)) {
    assert.deepEqual(manifest.contributes.colors.find((c) => c.id === id)?.defaults, defaults);
  }
});

test('parseColor', () => {
  assert.deepEqual(parseColor('#2fbf6b3d'), { r: 47, g: 191, b: 107, a: 61 / 255 });
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(parseColor('green'), undefined);
  assert.equal(parseColor(undefined), undefined);
});
