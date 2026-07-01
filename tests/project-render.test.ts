import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProject } from '../src/dashboard/render/project.js';
import type { ProjectDetailVM } from '../src/dashboard/data/project.js';

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
    ...overrides,
  };
}

describe('renderProject skeleton', () => {
  test('renders five sections in order: hero, velocity, features, active-work, worth-reconciling', () => {
    const html = renderProject(baseVm());
    const order = ['hero', 'velocity', 'features', 'active-work', 'worth-reconciling'];
    let last = -1;
    for (const s of order) {
      const idx = html.indexOf(`data-section="${s}"`);
      assert.ok(idx > last, `section ${s} should appear (found idx=${idx}, last=${last})`);
      last = idx;
    }
  });

  test('hero shows repo label, name, total, delta, session/feature counts, most-active feature', () => {
    const html = renderProject(baseVm());
    assert.match(html, /REPO:LOSCHENBD\/ARCHI/);
    assert.match(html, />archi</);
    assert.match(html, /\$2,?203/);
    assert.match(html, /▲649% vs prior/);
    assert.match(html, /17 sessions/);
    assert.match(html, /18 features/);
    assert.match(html, /Local RAG \+ chatbot/);
  });

  test('hero shows "(new project)" delta line when priorUsd is 0', () => {
    const html = renderProject(baseVm({ priorUsd: 0, deltaPct: 100 }));
    assert.match(html, /\(new project\)/);
  });

  test('hero omits most-active line when features is empty', () => {
    const html = renderProject(baseVm({ features: [] }));
    assert.doesNotMatch(html, /most active:/i);
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

  test('velocity section embeds an svg bar chart', () => {
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

// helper — extract the `<section data-section="X">...</section>` slice.
function extractSection(html: string, name: string): string {
  const start = html.indexOf(`data-section="${name}"`);
  if (start === -1) return '';
  const openEnd = html.indexOf('>', start) + 1;
  const close = html.indexOf('</section>', openEnd);
  return html.slice(openEnd, close);
}
