import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectAnomalies, type AnomalyInput } from '../src/services/anomalies.js';

describe('spike_day', () => {
  test('flags day ≥ 2× trailing 7-day median when ≥ $20', () => {
    const dailyTotals = [
      { date: '2026-06-01', total: 30 },
      { date: '2026-06-02', total: 30 },
      { date: '2026-06-03', total: 30 },
      { date: '2026-06-04', total: 30 },
      { date: '2026-06-05', total: 30 },
      { date: '2026-06-06', total: 30 },
      { date: '2026-06-07', total: 30 },
      { date: '2026-06-08', total: 100 },  // 100 / 30 = 3.33× → flag
    ];
    const out = detectAnomalies({ dailyTotals, featureWeekly: [], sessions: [], labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    const spike = out.find((a) => a.kind === 'spike_day' && a.date === '2026-06-08');
    assert.ok(spike, 'expected spike_day on 2026-06-08');
    assert.equal(spike!.amount, 100);
    assert.equal(spike!.baseline, 30);
    assert.ok(spike!.multiplier >= 3.3 && spike!.multiplier <= 3.4);
  });

  test('does not flag when below $20 floor', () => {
    const dailyTotals = [
      { date: '2026-06-01', total: 5 },
      { date: '2026-06-02', total: 5 },
      { date: '2026-06-03', total: 5 },
      { date: '2026-06-04', total: 5 },
      { date: '2026-06-05', total: 5 },
      { date: '2026-06-06', total: 5 },
      { date: '2026-06-07', total: 5 },
      { date: '2026-06-08', total: 19 },  // 19 < $20 floor
    ];
    const out = detectAnomalies({ dailyTotals, featureWeekly: [], sessions: [], labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    assert.equal(out.filter((a) => a.kind === 'spike_day').length, 0);
  });

  test('does not flag when multiplier below 2×', () => {
    const dailyTotals = [
      { date: '2026-06-01', total: 30 },
      { date: '2026-06-02', total: 30 },
      { date: '2026-06-03', total: 30 },
      { date: '2026-06-04', total: 30 },
      { date: '2026-06-05', total: 30 },
      { date: '2026-06-06', total: 30 },
      { date: '2026-06-07', total: 30 },
      { date: '2026-06-08', total: 50 },  // 50 / 30 = 1.67× → no
    ];
    const out = detectAnomalies({ dailyTotals, featureWeekly: [], sessions: [], labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    assert.equal(out.filter((a) => a.kind === 'spike_day').length, 0);
  });
});

describe('burning_feature', () => {
  test('flags feature whose this-week ≥ 1.5× prior-week and ≥ $50', () => {
    const featureWeekly = [
      { featureKey: 'rag', priorWeek: 100, thisWeek: 200 },  // 2× and ≥ $50 → flag
    ];
    const out = detectAnomalies({ dailyTotals: [], featureWeekly, sessions: [], labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    const burn = out.find((a) => a.kind === 'burning_feature' && a.feature_key === 'rag');
    assert.ok(burn);
    assert.equal(burn!.amount, 200);
    assert.equal(burn!.baseline, 100);
  });

  test('does not flag when below $50 floor', () => {
    const featureWeekly = [
      { featureKey: 'tiny', priorWeek: 5, thisWeek: 40 },  // ratio fine, floor not met
    ];
    const out = detectAnomalies({ dailyTotals: [], featureWeekly, sessions: [], labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    assert.equal(out.filter((a) => a.kind === 'burning_feature').length, 0);
  });

  test('handles prior-week of zero without dividing by zero', () => {
    const featureWeekly = [
      { featureKey: 'new', priorWeek: 0, thisWeek: 100 },  // new feature
    ];
    const out = detectAnomalies({ dailyTotals: [], featureWeekly, sessions: [], labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    const burn = out.find((a) => a.kind === 'burning_feature' && a.feature_key === 'new');
    assert.ok(burn, 'new feature with zero prior week should flag');
    assert.equal(burn!.baseline, 0);
    assert.equal(burn!.multiplier, Number.POSITIVE_INFINITY);
  });
});

describe('hot_session', () => {
  const baseSessions = Array.from({ length: 30 }, (_, i) => ({
    sessionId: `s${i}`,
    date: '2026-06-08',
    cost: 5,
    branch: null as string | null,
    hasOverride: false,
  }));

  test('flags session ≥ $25 and ≥ 3× 30-day p90', () => {
    const sessions = [
      ...baseSessions,
      { sessionId: 'hot', date: '2026-06-08', cost: 50, branch: null, hasOverride: false },
    ];
    const out = detectAnomalies({ dailyTotals: [], featureWeekly: [], sessions, labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    const hot = out.find((a) => a.kind === 'hot_session' && a.session_id === 'hot');
    assert.ok(hot);
  });

  test('suppresses when session has feature_override', () => {
    const sessions = [
      ...baseSessions,
      { sessionId: 'hot', date: '2026-06-08', cost: 50, branch: null, hasOverride: true },
    ];
    const out = detectAnomalies({ dailyTotals: [], featureWeekly: [], sessions, labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    assert.equal(out.filter((a) => a.kind === 'hot_session').length, 0);
  });

  test('suppresses when session branch matches a labeled work unit', () => {
    const sessions = [
      ...baseSessions,
      { sessionId: 'hot', date: '2026-06-08', cost: 50, branch: 'feat/rag', hasOverride: false },
    ];
    const out = detectAnomalies({
      dailyTotals: [],
      featureWeekly: [],
      sessions,
      labeledWorkUnitBranches: new Set(['feat/rag']),
    } satisfies AnomalyInput);
    assert.equal(out.filter((a) => a.kind === 'hot_session').length, 0);
  });

  test('does not flag when below $25 floor', () => {
    const sessions = [
      ...baseSessions,
      { sessionId: 'modest', date: '2026-06-08', cost: 20, branch: null, hasOverride: false },
    ];
    const out = detectAnomalies({ dailyTotals: [], featureWeekly: [], sessions, labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    assert.equal(out.filter((a) => a.kind === 'hot_session').length, 0);
  });

  test('does NOT flag $50 when the user routinely has big sessions (p90 is high)', () => {
    // 20 small sessions + 10 medium ones: p90 lands around the medium tier,
    // so a $50 session is only ~1.25× the typical big session. Under the
    // old median-based detector this DID flag and produced the noise that
    // had to be bulk-dismissed.
    const sessions = [
      ...Array.from({ length: 20 }, (_, i) => ({
        sessionId: `small-${i}`, date: '2026-06-08', cost: 5,
        branch: null as string | null, hasOverride: false,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        sessionId: `med-${i}`, date: '2026-06-08', cost: 40,
        branch: null as string | null, hasOverride: false,
      })),
      { sessionId: 'maybe', date: '2026-06-08', cost: 50, branch: null, hasOverride: false },
    ];
    const out = detectAnomalies({ dailyTotals: [], featureWeekly: [], sessions, labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    assert.equal(
      out.filter((a) => a.kind === 'hot_session').length,
      0,
      'p90 ≈ $40; a $50 session is only 1.25× — well below 3×'
    );
  });

  test('still flags a truly huge session against a big-session population', () => {
    // Same population as above, but with a $500 session — that IS anomalous
    // at ~12.5× p90, so it should still flag.
    const sessions = [
      ...Array.from({ length: 20 }, (_, i) => ({
        sessionId: `small-${i}`, date: '2026-06-08', cost: 5,
        branch: null as string | null, hasOverride: false,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        sessionId: `med-${i}`, date: '2026-06-08', cost: 40,
        branch: null as string | null, hasOverride: false,
      })),
      { sessionId: 'huge', date: '2026-06-08', cost: 500, branch: null, hasOverride: false },
    ];
    const out = detectAnomalies({ dailyTotals: [], featureWeekly: [], sessions, labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    const hot = out.find((a) => a.kind === 'hot_session' && a.session_id === 'huge');
    assert.ok(hot, 'a $500 session against p90 ≈ $40 should still flag');
  });
});

describe('reason text format', () => {
  test('spike_day reason mentions amount and multiplier', () => {
    const dailyTotals = [
      ...Array.from({ length: 7 }, (_, i) => ({ date: `2026-06-0${i + 1}`, total: 30 })),
      { date: '2026-06-08', total: 100 },
    ];
    const out = detectAnomalies({ dailyTotals, featureWeekly: [], sessions: [], labeledWorkUnitBranches: new Set() } satisfies AnomalyInput);
    const reason = out.find((a) => a.kind === 'spike_day')!.reason;
    assert.match(reason, /\$100/);
    assert.match(reason, /3\.3×/);
  });
});
