import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProject } from '../src/dashboard/render/project.js';
import type { ProjectDetailVM } from '../src/dashboard/data/project.js';

function baseVm(overrides: Partial<ProjectDetailVM> = {}): ProjectDetailVM {
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
    dailySeries: [],
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
