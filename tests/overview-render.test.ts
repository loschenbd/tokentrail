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
    projects: [],
    days: [],
    projectFeatureMix: [],
    unattributed: null,
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

test('trend-data JSON embeds days and projects arrays', () => {
  const vm = makeVm({
    projects: [{ key: 'menubar', name: 'menubar', color: '#0072B2', totalUsd: 5, clickable: true, stackPosition: 0 }],
    days: [{ date: '2026-06-29', total: 5, bands: { menubar: 5 }, featureBands: {}, unattributedTotal: 0, commits: 0, prs: 0 }],
  });
  const html = renderOverview(vm);
  const m = html.match(/<script type="application\/json" id="trend-data">([^<]+)<\/script>/);
  assert.ok(m);
  const parsed = JSON.parse(m![1]!);
  assert.ok(Array.isArray(parsed.days));
  assert.ok(Array.isArray(parsed.projects));
  assert.equal(parsed.projects[0].key, 'menubar');
});

test('trend legend uses data-project-key and orders by stackPosition desc', () => {
  const vm: OverviewVM = {
    ...emptyVM(),
    totalUsd: 100,
    projects: [
      { key: 'a', name: 'Alpha', color: '#000', totalUsd: 60, clickable: true, stackPosition: 0 },
      { key: 'b', name: 'Beta',  color: '#111', totalUsd: 40, clickable: true, stackPosition: 1 },
      { key: '__other__', name: 'Other', color: '#9CA3AF', totalUsd: 5, clickable: false, stackPosition: 2 },
    ],
    days: [{ date: '2026-06-30', total: 105, bands: { a: 60, b: 40, __other__: 5 }, featureBands: {}, unattributedTotal: 0, commits: 0, prs: 0 }],
  };
  const html = renderOverview(vm);
  // First legend row is __other__ (highest stackPosition).
  const otherIdx = html.indexOf('data-project-key="__other__"');
  const bIdx = html.indexOf('data-project-key="b"');
  const aIdx = html.indexOf('data-project-key="a"');
  assert.ok(otherIdx > 0 && bIdx > 0 && aIdx > 0);
  assert.ok(otherIdx < bIdx && bIdx < aIdx, 'legend order should be Other, b, a');
});

test('__other__ legend row has data-clickable="0"', () => {
  const vm: OverviewVM = {
    ...emptyVM(),
    totalUsd: 100,
    projects: [
      { key: 'a', name: 'A', color: '#000', totalUsd: 60, clickable: true, stackPosition: 0 },
      { key: '__other__', name: 'Other', color: '#9CA3AF', totalUsd: 40, clickable: false, stackPosition: 1 },
    ],
    days: [{ date: '2026-06-30', total: 100, bands: {}, featureBands: {}, unattributedTotal: 0, commits: 0, prs: 0 }],
  };
  const html = renderOverview(vm);
  assert.match(html, /data-project-key="__other__"[^>]*data-clickable="0"/);
});

test('burn paths rows carry data-project-key and include an empty subbar container', () => {
  const vm: OverviewVM = {
    ...emptyVM(),
    totalUsd: 100,
    topProjects: [{ key: 'archi', name: 'archi', totalUsd: 100, pct: 100, featureCount: 2, sessionCount: 3 }],
  };
  const html = renderOverview(vm);
  assert.match(html, /class="project-row"[^>]*data-project-key="archi"/);
  assert.match(html, /class="subbar"[^>]*data-project-key="archi"/);
});

test('burn paths payload includes projectFeatureMix JSON', () => {
  const vm: OverviewVM = {
    ...emptyVM(),
    totalUsd: 100,
    topProjects: [{ key: 'archi', name: 'archi', totalUsd: 100, pct: 100, featureCount: 2, sessionCount: 3 }],
    projectFeatureMix: [{
      projectKey: 'archi',
      features: [
        { key: 'rag', name: 'RAG', color: '#0072B2', totalUsd: 60 },
        { key: '__unattributed__', name: 'unattributed', color: '__striped__', totalUsd: 40 },
      ],
    }],
  };
  const html = renderOverview(vm);
  assert.match(html, /id="burn-paths-data"/);
  assert.match(html, /"projectKey":"archi"/);
  assert.match(html, /"__striped__"/);
});

test('unattributed card visible with rendered content when payload present', () => {
  const vm: OverviewVM = {
    ...emptyVM(),
    totalUsd: 200,
    unattributed: {
      totalUsd: 60,
      pctOfTrail: 30,
      sparkline: Array.from({ length: 30 }, (_, i) => ({ date: `2026-06-${String(i+1).padStart(2,'0')}`, usd: i })),
      topProjects: [
        { key: 'archi', name: 'archi', color: '#0072B2', unattributedUsd: 40, projectTotalUsd: 120 },
      ],
    },
  };
  const html = renderOverview(vm);
  assert.match(html, /id="unattributed-card"/);
  // The card's data payload should be in the JSON blob so client JS can mount it.
  assert.match(html, /"pctOfTrail":30/);
});

test('unattributed card placeholder hidden by default; visible marker when payload present', () => {
  const empty: OverviewVM = { ...emptyVM(), totalUsd: 0 };
  assert.doesNotMatch(renderOverview(empty), /id="unattributed-card"/);

  const withUnatt: OverviewVM = {
    ...emptyVM(),
    totalUsd: 100,
    unattributed: {
      totalUsd: 40,
      pctOfTrail: 40,
      sparkline: [],
      topProjects: [],
    },
  };
  const html = renderOverview(withUnatt);
  assert.match(html, /id="unattributed-card"/);
  assert.doesNotMatch(html, /id="unattributed-card"[^>]* hidden/);
});
