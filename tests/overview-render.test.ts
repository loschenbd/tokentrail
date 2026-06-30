import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderOverview } from '../src/dashboard/render/overview.js';
import type { OverviewVM } from '../src/dashboard/data/overview.js';

function emptyVM(): OverviewVM {
  return {
    windowDays: 30,
    totalUsd: 0,
    priorUsd: 0,
    deltaPct: 0,
    weekUsd: 0,
    weekSessions: 0,
    topFeatures: [],
    topProjects: [],
    features: [],
    days: [],
    anomalies: [],
    recentCommits: [],
  };
}

function makeVm(overrides: Partial<OverviewVM> = {}): OverviewVM {
  return { ...emptyVM(), totalUsd: 67, ...overrides };
}

describe('renderOverview empty-state', () => {
  test('renders the onboarding trail map and troubleshooting hint when empty', () => {
    const html = renderOverview(emptyVM());
    // PR #20 swapped the "No trail yet" string for the onboarding trail
    // map + a collapsible troubleshooting details block.
    assert.match(html, /\bempty-state\b/);
    assert.match(html, /Don't see your trail\?/);
    assert.match(html, /Claude Code/);
    // The standard layout grid should NOT render when empty — the hint
    // replaces it so the user isn't staring at a row of zeros.
    assert.doesNotMatch(html, /class="layout"/);
  });

  test('renders the standard layout when any spend is present', () => {
    const vm = emptyVM();
    vm.totalUsd = 12.34;
    const html = renderOverview(vm);
    assert.match(html, /class="layout"/);
    assert.doesNotMatch(html, /\bempty-state\b/);
  });
});

test('renders the legend scaffold next to the chart with one li per feature', () => {
  // Build a minimal VM with 2 real features + Other + uncategorized.
  const vm = makeVm({
    features: [
      { key: 'menubar',              name: 'menubar',              color: '#0072B2', totalUsd: 30, clickable: true,  stackPosition: 0 },
      { key: 'ingest',               name: 'ingest',               color: '#E69F00', totalUsd: 20, clickable: true,  stackPosition: 1 },
      { key: '__other__',            name: 'Other',                color: '#9CA3AF', totalUsd: 5,  clickable: false, stackPosition: 2 },
      { key: 'uncategorized-mainline', name: 'uncategorized-mainline', color: '__striped__', totalUsd: 12, clickable: false, stackPosition: 3 },
    ],
    days: [{ date: '2026-06-29', total: 67, bands: { menubar: 30, ingest: 20, '__other__': 5, 'uncategorized-mainline': 12 }, commits: 1, prs: 0 }],
  });
  const html = renderOverview(vm);
  assert.match(html, /id="trend-legend"/);
  // 4 entries (top-of-stack first = uncategorized).
  const lis = html.match(/<li[^>]+data-feature-key=/g) ?? [];
  assert.equal(lis.length, 4);
  // Order: uncategorized first, then __other__, then real features sorted desc.
  const order = [...html.matchAll(/data-feature-key="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['uncategorized-mainline', '__other__', 'menubar', 'ingest']);
  // clickable flags.
  assert.match(html, /data-feature-key="menubar"[^>]*data-clickable="1"/);
  assert.match(html, /data-feature-key="__other__"[^>]*data-clickable="0"/);
});

test('trend-data JSON embeds both days and features arrays', () => {
  const vm = makeVm({
    features: [{ key: 'menubar', name: 'menubar', color: '#0072B2', totalUsd: 5, clickable: true, stackPosition: 0 }],
    days: [{ date: '2026-06-29', total: 5, bands: { menubar: 5 }, commits: 0, prs: 0 }],
  });
  const html = renderOverview(vm);
  const m = html.match(/<script type="application\/json" id="trend-data">([^<]+)<\/script>/);
  assert.ok(m);
  const parsed = JSON.parse(m![1]!);
  assert.ok(Array.isArray(parsed.days));
  assert.ok(Array.isArray(parsed.features));
  assert.equal(parsed.features[0].key, 'menubar');
});
