import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProject } from '../src/dashboard/render/project.js';
import type { ProjectDetailVM } from '../src/dashboard/data/project.js';
import type { BranchGraphVM } from '../src/dashboard/data/branches.js';

function baseVm(overrides: Partial<ProjectDetailVM> = {}): ProjectDetailVM {
  // 30 daily entries so stat line reads "vs prior 30d"
  const dailySeries = Array.from({ length: 30 }, (_, i) => {
    const d = new Date('2026-06-01');
    d.setDate(d.getDate() + i);
    return { date: d.toISOString().slice(0, 10), total: 0, commits: 0, prs: 0 };
  });
  return {
    projectKey: 'repo:loschenbd/archi',
    projectName: 'archi',
    color: '#835a49',
    totalUsd: 2203,
    priorUsd: 288,
    deltaPct: 649,
    sessionCount: 17,
    featureCount: 18,
    avgUsdPerDay: 73,
    weekStats: {
      thisWeekUsd: 487, lastWeekUsd: 661, priorWeekUsd: 419,
      thisVsLastPct: -26, lastVsPriorPct: 58,
    },
    peakDay: { date: '2026-06-15', totalUsd: 412, featureKey: 'local-rag-chatbot', featureName: 'Local RAG + chatbot' },
    dailySeries,
    features: [
      { featureKey: 'local-rag-chatbot', featureName: 'Local RAG + chatbot', totalUsd: 765, sessionCount: 5, lastActive: '2026-06-27', daily: [] },
    ],
    sessions: [],
    recentCommits: [],
    anomalies: [],
    branchGraph: null,
    unattributed: null,
    ...overrides,
  };
}

describe('renderProject skeleton', () => {
  test('renders sections in order: hero, velocity, active-work, worth-reconciling, features', () => {
    const html = renderProject(baseVm({
      anomalies: [{ id: 1, kind: 'spike_day', date: '2026-06-15', featureKey: 'f', sessionId: null, amount: 100, reason: 'test', cause: null }],
    }));
    const order = ['hero', 'velocity', 'active-work', 'worth-reconciling', 'features'];
    let last = -1;
    for (const s of order) {
      const idx = html.indexOf(`data-section="${s}"`);
      assert.ok(idx > last, `section ${s} should appear in order (found idx=${idx}, last=${last})`);
      last = idx;
    }
  });

  test('hero shows repo label, name, total, delta, session/feature counts, most-active feature', () => {
    const html = renderProject(baseVm());
    assert.match(html, /repo:loschenbd\/archi/);
    assert.match(html, />archi</);
    assert.match(html, /\$2,?203/);
    assert.match(html, /▲649%/);
    assert.match(html, /vs prior 30d/);
    assert.match(html, />17</);            // sessions value cell
    assert.match(html, /Sessions/);
    assert.match(html, />18</);            // features value cell
    assert.match(html, /Local RAG \+ chatbot/);
  });

  test('hero shows "new project" delta cell when priorUsd is 0', () => {
    const html = renderProject(baseVm({ priorUsd: 0, deltaPct: 100 }));
    assert.match(html, /new project/);
  });

  test('hero omits most-active line when features is empty', () => {
    const html = renderProject(baseVm({ features: [] }));
    assert.doesNotMatch(html, /Most active/i);
  });
});

describe('renderProject velocity section', () => {
  test('velocity section shows total, avg/day, and delta stat row', () => {
    const html = renderProject(baseVm());
    const seg = extractSection(html, 'velocity');
    assert.match(seg, /\$2,?203 total/);
    assert.match(seg, /\$73\/day avg/);
    assert.match(seg, /▲649% vs prior 30d/);
  });

  test('velocity section embeds an svg bar chart with y-gridlines', () => {
    const vm = baseVm({
      dailySeries: [
        { date: '2026-06-14', total: 0, commits: 0, prs: 0 },
        { date: '2026-06-15', total: 412, commits: 0, prs: 0 },
        { date: '2026-06-16', total: 50, commits: 0, prs: 0 },
      ],
    });
    const seg = extractSection(renderProject(vm), 'velocity');
    assert.match(seg, /<svg\b[^>]*viewBox/);
    assert.match(seg, /<rect\b/);
    assert.match(seg, /stroke-dasharray/);   // gridlines present
  });

  test('week callouts render both totals and their delta arrows', () => {
    const seg = extractSection(renderProject(baseVm()), 'velocity');
    assert.match(seg, /This week/);
    assert.match(seg, /\$487/);
    assert.match(seg, /▼26% vs last week/);
    assert.match(seg, /Last week/);
    assert.match(seg, /\$661/);
    assert.match(seg, /▲58% vs prior week/);
  });

  test('peak day row shows date, amount, and the driving feature', () => {
    const seg = extractSection(renderProject(baseVm()), 'velocity');
    assert.match(seg, /Peak day/);
    assert.match(seg, /Jun 15/);
    assert.match(seg, /\$412/);
    assert.match(seg, /Local RAG \+ chatbot/);
  });

  test('peak day row omitted when peakDay is null', () => {
    const seg = extractSection(renderProject(baseVm({ peakDay: null })), 'velocity');
    assert.doesNotMatch(seg, /Peak day/);
  });
});

describe('renderProject features section', () => {
  function fullVm() {
    return baseVm({
      totalUsd: 1000,
      features: [
        { featureKey: 'local-rag-chatbot', featureName: 'Local RAG + chatbot', totalUsd: 765, sessionCount: 5, lastActive: '2026-06-27', daily: [{date:'2026-06-20', totalUsd:0},{date:'2026-06-21', totalUsd:200},{date:'2026-06-27', totalUsd:565}] },
        { featureKey: 'archi-homepage-redesign', featureName: 'Archi homepage redesign', totalUsd: 235, sessionCount: 3, lastActive: '2026-06-21', daily: [{date:'2026-06-20', totalUsd:100},{date:'2026-06-21', totalUsd:135}] },
      ],
    });
  }

  test('features section header includes the count', () => {
    const seg = extractSection(renderProject(fullVm()), 'features');
    assert.match(seg, /FEATURES/i);
    assert.match(seg, /· 2/);
  });

  test('each row shows rank, name, sessions, lastActive, amount, share', () => {
    const seg = extractSection(renderProject(fullVm()), 'features');
    assert.match(seg, /Local RAG \+ chatbot/);
    assert.match(seg, />5 sess</);   // sessions count
    assert.match(seg, /Jun 27/);      // lastActive formatted as Mon D
    assert.match(seg, /\$765/);
    assert.match(seg, /77%/);         // 765 / 1000
    assert.match(seg, /Archi homepage redesign/);
    assert.match(seg, />3 sess</);
    assert.match(seg, /Jun 21/);
    assert.match(seg, /\$235/);
    assert.match(seg, /24%/);         // 235 / 1000
  });

  test('row is a link to /feature/<key>', () => {
    const seg = extractSection(renderProject(fullVm()), 'features');
    assert.match(seg, /href="\/feature\/local-rag-chatbot"/);
  });

  test('share bar embedded per row, no per-row sparkline svg', () => {
    const seg = extractSection(renderProject(fullVm()), 'features');
    assert.equal((seg.match(/pfeat-fill/g) ?? []).length, 2);
    assert.doesNotMatch(seg, /<svg\b/);
  });

  test('long tail folds behind a toggle naming count + summed dollars', () => {
    const many = [
      { featureKey: 'a', featureName: 'Alpha', totalUsd: 262, sessionCount: 2, lastActive: '2026-06-27', daily: [] },
      { featureKey: 'b', featureName: 'Bravo', totalUsd: 149, sessionCount: 3, lastActive: '2026-06-23', daily: [] },
      { featureKey: 'c', featureName: 'Charlie', totalUsd: 129, sessionCount: 1, lastActive: '2026-06-25', daily: [] },
      { featureKey: 'd', featureName: 'Delta', totalUsd: 80, sessionCount: 1, lastActive: '2026-06-22', daily: [] },
      { featureKey: 'e', featureName: 'Echo', totalUsd: 42, sessionCount: 1, lastActive: '2026-06-21', daily: [] },
      { featureKey: 'f', featureName: 'Foxtrot', totalUsd: 4, sessionCount: 1, lastActive: '2026-06-20', daily: [] },
      { featureKey: 'g', featureName: 'Golf', totalUsd: 3, sessionCount: 1, lastActive: '2026-06-19', daily: [] },
      { featureKey: 'h', featureName: 'Hotel', totalUsd: 1, sessionCount: 1, lastActive: '2026-06-18', daily: [] },
    ];
    const seg = extractSection(renderProject(baseVm({ totalUsd: 670, features: many })), 'features');
    // 5 features >= $10 stay visible; 3 (<$10) fold.
    assert.match(seg, /data-tail-toggle/);
    assert.match(seg, /\+ 3 more under \$10 · \$8 total/);
    assert.match(seg, /class="tail-body" hidden/);
    assert.match(seg, /Foxtrot/);   // tail row still in DOM (just hidden)
  });

  test('empty features → muted note, no rows', () => {
    const seg = extractSection(renderProject(baseVm({ features: [] })), 'features');
    assert.match(seg, /No features in window/);
  });
});

describe('renderProject active-work section', () => {
  const branchGraph: BranchGraphVM = {
    trunk: 'main',
    windowStart: '2026-06-01',
    windowEnd: '2026-06-30',
    days: 30,
    totalBranches: 3,
    totalUsd: 12,
    branches: [
      { branch: 'onboarding-wizard', firstEventAt: '2026-06-01', lastEventAt: '2026-06-09', mergedAt: '2026-06-09', status: 'merged', totalUsd: 0, sessionCount: 0, prNumber: null, prUrl: null, featureKey: null },
      { branch: 'coherence-pass', firstEventAt: '2026-06-01', lastEventAt: '2026-06-05', mergedAt: null, status: 'stale', totalUsd: 0, sessionCount: 0, prNumber: null, prUrl: null, featureKey: null },
      { branch: 'worktree-local-semantic-search', firstEventAt: '2026-06-01', lastEventAt: '2026-06-29', mergedAt: null, status: 'open', totalUsd: 12, sessionCount: 0, prNumber: null, prUrl: null, featureKey: null },
    ],
  };

  test('branch table renders a row per branch with name, spend fill, last-active date, sessions', () => {
    const seg = extractSection(renderProject(baseVm({ branchGraph })), 'active-work');
    assert.match(seg, /worktree-local-semantic-search/);
    assert.match(seg, /bwork-fill/);       // spend bar
    assert.match(seg, /bwork-last/);        // last-active date cell
    assert.match(seg, /bwork-row bwork-open/);
  });

  test('merged branch carries a ✓; stale branch carries the stale class', () => {
    const seg = extractSection(renderProject(baseVm({ branchGraph })), 'active-work');
    assert.match(seg, /bwork-row bwork-merged/);
    assert.match(seg, /bwork-tick/);
    assert.match(seg, /bwork-row bwork-stale/);
  });

  test('each row shows a "last <date>" from mergedAt/lastEventAt, not an activity bar', () => {
    const seg = extractSection(renderProject(baseVm({ branchGraph })), 'active-work');
    assert.match(seg, /last Jun 29/);       // open worktree branch, lastEventAt 2026-06-29
    assert.match(seg, /last Jun 9/);         // merged onboarding-wizard, mergedAt 2026-06-09
    assert.doesNotMatch(seg, /bwork-seg/);   // no activity-window segment anymore
  });

  test('the SVG branch-graph mount and JSON payload are gone', () => {
    const seg = extractSection(renderProject(baseVm({ branchGraph })), 'active-work');
    assert.doesNotMatch(seg, /id="branch-graph"/);
    assert.doesNotMatch(seg, /branch-graph-data/);
  });

  test('recent commits still render inline', () => {
    const seg = extractSection(renderProject(baseVm({
      branchGraph,
      recentCommits: [
        { sha: 'a2c6cad1000000', subject: 'fix: nodes grow by radius', repo: 'loschenbd/archi', authoredAt: '2026-06-09T00:00:00Z' },
      ],
    })), 'active-work');
    assert.match(seg, /a2c6cad1/);
    assert.match(seg, /fix: nodes grow by radius/);
  });

  test('empty state: no branches AND no commits → gentle placeholder', () => {
    const seg = extractSection(renderProject(baseVm({ branchGraph: null, recentCommits: [] })), 'active-work');
    assert.match(seg, /No branches touched archi in this window/);
  });
});

describe('renderProject worth-reconciling section', () => {
  test('collapses to "All clear on <name>." when unattributed is null AND anomalies empty', () => {
    const html = renderProject(baseVm({ unattributed: null, anomalies: [] }));
    assert.match(html, /All clear on archi\./);
    // The section container should NOT be present.
    assert.doesNotMatch(html, /data-section="worth-reconciling"/);
  });

  test('renders unattributed subblock when unattributed is non-null', () => {
    const vm = baseVm({
      unattributed: {
        totalUsd: 155,
        sparkline: [{ date: '2026-06-01', usd: 40 }, { date: '2026-06-02', usd: 115 }],
        topFeatures: [],
      },
    });
    const seg = extractSection(renderProject(vm), 'worth-reconciling');
    assert.match(seg, /Unattributed on archi/);
    assert.match(seg, /\$155/);
    assert.match(seg, /<svg\b/);
    assert.match(seg, /Run <code>tokentrail infer-mainline<\/code>/);
  });

  test('renders unattributed positive empty state when null', () => {
    const vm = baseVm({
      unattributed: null,
      anomalies: [
        { id: 1, kind: 'spike_day', date: '2026-06-15', featureKey: 'local-rag-chatbot', sessionId: '075fff73', amount: 412, reason: '4.2× the prior week', cause: { kind: 'session', ref: '075fff73', label: 'brainstorm copy' } } as any,
      ],
    });
    const seg = extractSection(renderProject(vm), 'worth-reconciling');
    assert.match(seg, /all sessions attributed/);
  });

  test('renders anomaly rows with cause line', () => {
    const vm = baseVm({
      anomalies: [
        { id: 1, kind: 'spike_day', date: '2026-06-15', featureKey: 'local-rag-chatbot', sessionId: '075fff73abc', amount: 412, reason: '4.2× the prior week', cause: { kind: 'session', ref: '075fff73abc', label: 'brainstorm copy' } } as any,
      ],
    });
    const seg = extractSection(renderProject(vm), 'worth-reconciling');
    assert.match(seg, /4\.2× the prior week/);
    assert.match(seg, /brainstorm copy/);
    assert.match(seg, /href="\/session\/075fff73abc"/);
  });
});

// helper — extract the `<section data-section="X">...</section>` slice.
function extractSection(html: string, name: string): string {
  const start = html.indexOf(`data-section="${name}"`);
  if (start === -1) return '';
  const openEnd = html.indexOf('>', start) + 1;
  const close = html.indexOf('</section>', openEnd);
  return html.slice(openEnd, close);
}
