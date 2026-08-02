import type { BudgetReport, BudgetStatus, SourceBudgetStatus } from '../data/budget.js';

const usd0 = (n: number) => '$' + Math.round(n);

// Filled = spent%, caret = projected% (only when it exceeds spend and is reliable).
function bar(b: BudgetStatus): string {
  const spentFrac = Math.min(100, Math.max(0, b.pctUsed));
  const projFrac = b.projectionReliable ? Math.min(100, Math.max(0, b.projectedPct)) : spentFrac;
  const caret = projFrac > spentFrac
    ? `<span class="budget-caret" style="left:${projFrac}%"></span>` : '';
  return `<div class="budget-bar-wrap budget-state-${b.state}">
    <div class="budget-bar">
      <span class="budget-fill" style="width:${spentFrac}%"></span>
    </div>${caret}
  </div>`;
}

function sourceRow(s: SourceBudgetStatus): string {
  return `<li class="budget-source budget-state-${s.state}">
    <span class="budget-source-label">${s.label}</span>
    ${bar(s)}
    <span class="budget-source-figs">${usd0(s.spentUsd)} / ${usd0(s.budgetUsd)}</span>
  </li>`;
}

export function renderBudgetCard(budget: BudgetReport | null): string {
  if (!budget) {
    return `<div class="card budget-card">
      <div class="label">Budget</div>
      <div class="muted">Set a monthly budget to track burn rate.</div>
      <div class="footer-link"><a href="/settings#budget">Set a budget →</a></div>
    </div>`;
  }
  const hasGlobal = budget.budgetUsd > 0;
  const projLine = !hasGlobal ? ''
    : budget.projectionReliable
      ? `<div class="muted">projected ${usd0(budget.projectedUsd)} · ${Math.round(budget.projectedPct)}%</div>`
      : `<div class="muted">too early to forecast</div>`;
  const globalBlock = hasGlobal ? `
    ${bar(budget)}
    <div class="budget-figs">${usd0(budget.spentUsd)} / ${usd0(budget.budgetUsd)}</div>
    ${projLine}` : '';
  const sourceBlock = budget.sources.length
    ? `<ul class="budget-sources">${budget.sources.map(sourceRow).join('')}</ul>` : '';
  return `<div class="card budget-card">
    <div class="label">Budget</div>
    ${globalBlock}
    ${sourceBlock}
  </div>`;
}
