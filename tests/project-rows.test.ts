import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProjectRows } from '../src/dashboard/render/project-rows.js';
import { renderToday } from '../src/dashboard/render/today.js';
import type { TodayVM } from '../src/dashboard/data/today.js';

const item = {
  key: 'research',
  name: 'Research',
  totalUsd: 17,
  pct: 60,
  featureCount: 2,
  color: '#8b6f47',
};

describe('renderProjectRows', () => {
  test('emits the CSS grid grammar: rank, swatch, name-col, amt-col, subbar', () => {
    const html = renderProjectRows([item]);
    for (const cls of ['rank', 'swatch', 'name-col', 'amt-col', 'subbar']) {
      assert.match(html, new RegExp(`class="${cls}`), `missing .${cls}`);
    }
    // The legacy Today classes must be gone — they overlap in the new grid.
    assert.doesNotMatch(html, /class="mile"/);
    assert.doesNotMatch(html, /class="amt"/);
  });

  test('staticFill emits a solid subbar segment; default emits none', () => {
    assert.match(renderProjectRows([item], { staticFill: true }), /subbar-segment/);
    assert.doesNotMatch(renderProjectRows([item]), /subbar-segment/);
  });

  test('escapes project names', () => {
    const html = renderProjectRows([{ ...item, name: '<script>x' }]);
    assert.doesNotMatch(html, /<script>x/);
  });
});

describe('renderToday project rows', () => {
  test('Today page uses the shared grammar (drift tripwire)', () => {
    const vm: TodayVM = {
      todayUsd: 28,
      yesterdayUsd: 25,
      deltaPct: 13,
      sessionsToday: 4,
      topProjects: [item],
      anomalies: [],
    };
    const html = renderToday(vm);
    for (const cls of ['rank', 'swatch', 'name-col', 'amt-col', 'subbar']) {
      assert.match(html, new RegExp(`class="${cls}`), `Today drifted: missing .${cls}`);
    }
  });
});
