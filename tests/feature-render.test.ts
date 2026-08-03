import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFeature } from '../src/dashboard/render/feature.js';
import type { FeatureDetailVM } from '../src/dashboard/data/feature.js';

function baseVm(over: Partial<FeatureDetailVM> = {}): FeatureDetailVM {
  return {
    featureKey: 'feat-x',
    featureName: 'Feature X',
    totalUsd: 262,
    status: 'closed',
    deltaPct: null,
    sessionCount: 1,
    branches: ['feat/x'],
    mergedPrCount: 8,
    commitCount: 21,
    releaseCount: 8,
    costPerPr: 33,
    costPerCommit: 12,
    activeDays: 2,
    dailySeries: [{ date: '2026-08-01', total: 250, commits: 3, prs: 2 }],
    events: [{ date: '2026-08-01', type: 'pr', label: '#64 thing', url: 'u64' }],
    releases: [
      { version: 'v0.2.0', date: '2026-08-02T10:00:00Z', prs: [{ repo: 'o/r', prNumber: 71, title: 'Budgets everywhere', url: 'u71' }], changeCommitCount: 3 },
      { version: 'v0.1.0', date: '2026-08-01T10:00:00Z', prs: [{ repo: 'o/r', prNumber: 64, title: 'Copilot', url: 'u64' }], changeCommitCount: 0 },
    ],
    clusters: [],
    sessions: [
      {
        sessionId: '2257bfe4-aaaa',
        title: 'can i see this through tailscale',
        date: '2026-08-01',
        cost: 262,
        commits: [{ sha: 'deadbeef1234', subject: 'feat: work', repo: 'o/r' }],
        prs: [{ repo: 'o/r', prNumber: 71, title: 'Budgets', url: 'u71', state: 'merged' }],
      },
    ],
    ...over,
  };
}

test('renders the two-column shell + statement header with efficiency chips', () => {
  const html = renderFeature(baseVm());
  assert.match(html, /fp-grid/);
  assert.match(html, /fp-chip-eff/); // efficiency chip present
  assert.match(html, /~\$33/); // cost per PR
  assert.match(html, /8<\/b><span class="fp-chip-k">PRs shipped/);
  assert.match(html, /fp-status-closed/); // lifecycle glyph
  assert.match(html, /estimated/); // cost stays labeled estimated
});

test('no fake delta when deltaPct is null; a real delta renders when set', () => {
  assert.doesNotMatch(renderFeature(baseVm({ deltaPct: null })), /vs prior/);
  assert.match(renderFeature(baseVm({ deltaPct: 27 })), /▲ 27% vs prior/);
});

test('What shipped lists merged PR rows grouped under releases, newest-first', () => {
  const html = renderFeature(baseVm());
  assert.match(html, /What shipped/);
  assert.match(html, /fp-rel-tag">v0\.2\.0/);
  assert.match(html, /#71/);
  assert.match(html, /fp-badge-merged">merged/);
  // v0.2.0 (newest) group tag appears before the v0.1.0 group tag. (Check the
  // rel-tag specifically — the "v0.1.0 → v0.2.0" range label sits above both.)
  const firstTag = html.indexOf('fp-rel-tag">v0.2.0');
  const secondTag = html.indexOf('fp-rel-tag">v0.1.0');
  assert.ok(firstTag !== -1 && firstTag < secondTag);
});

test('ledger renders a waterfall row with an expand target and deduped commits', () => {
  const html = renderFeature(baseVm());
  assert.match(html, /fp-ses-row/);
  assert.match(html, /data-expand-target="session-0-details"/);
  assert.match(html, /fp-ses-bar/);
  assert.match(html, /deadbeef/); // commit sha shown in the detail
});

test('activity payload is emitted for the client to render adaptively', () => {
  const html = renderFeature(baseVm());
  assert.match(html, /data-feature-activity/);
  assert.match(html, /feature-activity-data/);
  assert.match(html, /"activeDays":2/);
});

test('topics render capped at 5 rows with an Other roll-up', () => {
  const clusters = Array.from({ length: 8 }, (_, i) => ({
    name: `topic-${i}`, sessionIds: [], sessionCount: 1, totalUsd: 100 - i * 10,
  }));
  const html = renderFeature(baseVm({ clusters }));
  const rows = (html.match(/fp-topic-row/g) || []).length;
  assert.equal(rows, 5); // 4 leaders + Other
  assert.match(html, /Other · 4/);
});

test('topics section is omitted when there are no clusters', () => {
  assert.doesNotMatch(renderFeature(baseVm({ clusters: [] })), /class="label">Topics/);
});
