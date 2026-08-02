import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBudgetCard } from '../src/dashboard/render/budget-card.js';
import type { BudgetReport } from '../src/dashboard/data/budget.js';

const base = {
  budgetUsd: 200, cycleStart: '2026-08-01', cycleEnd: '2026-09-01',
  spentUsd: 88, projectedUsd: 180, pctUsed: 44, projectedPct: 90,
  daysElapsed: 12, daysInCycle: 31, projectionReliable: true, state: 'warn' as const,
};

describe('renderBudgetCard', () => {
  test('empty state links to settings when null', () => {
    const html = renderBudgetCard(null);
    assert.match(html, /Set a monthly budget/);
    assert.match(html, /\/settings#budget/);
  });

  test('configured: shows spent/budget, projected, and a per-source row', () => {
    const r: BudgetReport = { ...base, sources: [
      { ...base, key: 'claude', label: 'Claude Code', budgetUsd: 150, spentUsd: 60, pctUsed: 40 },
    ]};
    const html = renderBudgetCard(r);
    assert.match(html, /\$88 \/ \$200/);
    assert.match(html, /90%/);
    assert.match(html, /Claude Code/);
    assert.match(html, /budget-state-warn/);  // state class drives the tint
  });

  test('too-early forecast when projection unreliable', () => {
    const html = renderBudgetCard({ ...base, projectionReliable: false, sources: [] });
    assert.match(html, /too early/i);
  });
});
