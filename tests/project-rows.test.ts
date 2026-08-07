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
  sessionCount: 1,
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
      sessions: [],
      topProjects: [item],
      anomalies: [],
      hourly: [],
      projectFeatureMix: [],
      paceUsd: null,
      usualDayUsd: 0,
      shipped: { prCount: 0, commitCount: 0, items: [] },
    };
    const html = renderToday(vm);
    for (const cls of ['rank', 'swatch', 'name-col', 'amt-col', 'subbar']) {
      assert.match(html, new RegExp(`class="${cls}`), `Today drifted: missing .${cls}`);
    }
  });

  test('renders strip, sessions, and shipped modules', () => {
    const vm: TodayVM = {
      todayUsd: 28, yesterdayUsd: 25, deltaPct: 13, sessionsToday: 2,
      topProjects: [item], anomalies: [],
      hourly: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        usd: hour === 9 ? 5 : 0,
        projects: hour === 9 ? [{ name: 'Research', usd: 5, color: '#8b6f47' }] : []
      })),
      projectFeatureMix: [{ projectKey: 'research', features: [{ key: 'f', name: 'F', color: '#8b6f47', totalUsd: 17 }] }],
      paceUsd: 41, usualDayUsd: 23,
      sessions: [{
        sessionId: 's1', title: 'deep research', projectName: 'Research',
        featureKey: 'research', startedAt: '09:02', endedAt: '10:14', usd: 11,
      }, {
        sessionId: 's2', title: 'no feature', projectName: 'misc',
        featureKey: null, startedAt: '11:00', endedAt: '11:30', usd: 2,
      }],
      shipped: {
        prCount: 1, commitCount: 2,
        items: [
          { kind: 'pr', title: 'Today page redesign', state: 'merged', at: '' },
          { kind: 'commit', title: 'fix: today page markup', at: '' },
        ],
      },
    };
    const html = renderToday(vm);
    assert.match(html, /class="strip/);
    assert.match(html, /Burn by hour/i);
    assert.match(html, /pace ~\$41/);
    assert.match(html, /usual day \$23/);
    assert.match(html, /Sessions today · 2/);
    assert.match(html, /09:02–10:14/);
    assert.match(html, /href="\/feature\/research"/);       // attributed → link
    assert.doesNotMatch(html, /href="[^"]*"[^>]*>no feature/); // unattributed → no link
    assert.match(html, /1 PR · 2 commits/);
    assert.match(html, /Today page redesign/);
    assert.match(html, /id="burn-paths-data"/);
    assert.match(html, /id="hour-burn-data"/);
    assert.match(html, /"projectKey":"research"/);
    assert.match(html, /"hour":9/);
    assert.doesNotMatch(html, /"hour":3/);            // zero hours excluded from payload
    assert.match(html, /class="hour-bar" data-hour="9"/);
    assert.doesNotMatch(html, /hour-bar" title=/);    // native title gone
    assert.doesNotMatch(html, /<div class="hour-bar" data-hour="\d+" title/);
    // hour 9 is a stacked column with a project-colored segment
    assert.match(html, /class="hour-seg" style="flex:5;background:#8b6f47"/);
  });

  test('pace omitted when null', () => {
    const vm: TodayVM = {
      todayUsd: 28, yesterdayUsd: 25, deltaPct: 13, sessionsToday: 0,
      topProjects: [item], anomalies: [],
      hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, usd: 0, projects: [] })),
      projectFeatureMix: [],
      paceUsd: null, usualDayUsd: 23,
      sessions: [],
      shipped: { prCount: 0, commitCount: 0, items: [] },
    };
    const html = renderToday(vm);
    assert.doesNotMatch(html, /pace ~/);
    assert.match(html, /usual day \$23/);
  });
});
