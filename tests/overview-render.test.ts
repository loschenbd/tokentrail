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
    dailySeries: [],
    anomalies: [],
    recentCommits: [],
  };
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
