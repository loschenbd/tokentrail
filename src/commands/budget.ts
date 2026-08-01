import { getDb } from '../db/db.js';
import { getConfig } from '../lib/config.js';
import { buildBudget } from '../dashboard/data/budget.js';

// `tokentrail budget` — cycle-to-date spend vs the configured monthly budget,
// with a run-rate forecast to cycle end. Opt-in: prints setup help when no
// budget is set. All figures estimated (constitution rule 3).
export async function runBudget(): Promise<void> {
  const db = getDb();
  const cfg = getConfig();
  const b = buildBudget(db, {
    budgetUsd: cfg.monthlyBudgetUsd,
    cycleStartDay: cfg.budgetCycleStartDay,
  });

  if (!b) {
    console.log('No budget set. Add a monthly budget to track burn rate:');
    console.log('  echo \'{ "monthlyBudgetUsd": 200 }\' > .tokentrail.json');
    console.log('  (or ~/.config/tokentrail/config.json; optional "budgetCycleStartDay": 1-28)');
    return;
  }

  const usd = (n: number) => '$' + n.toFixed(2);
  const bar = renderBar(b.pctUsed, b.projectedPct);
  const tag = b.state === 'over' ? ' ⚠ over' : b.state === 'warn' ? ' ⚠ trending over' : '';

  console.log(`Budget — cycle ${b.cycleStart} → ${b.cycleEnd} (day ${b.daysElapsed}/${b.daysInCycle})`);
  console.log('─'.repeat(64));
  console.log(`  ${bar}`);
  console.log(`  Spent      ${usd(b.spentUsd)} of ${usd(b.budgetUsd)}  (${b.pctUsed}%)`);
  if (b.projectionReliable) {
    console.log(`  Projected  ${usd(b.projectedUsd)} by cycle end  (${b.projectedPct}%)${tag}`);
  } else {
    console.log(`  Projected  — too early in the cycle to forecast${tag}`);
  }
  console.log('  (estimated · Claude + Copilot + Cursor)');
}

// A 24-cell bar: filled = spent%, a caret marks the projected% position.
function renderBar(pctUsed: number, projectedPct: number): string {
  const width = 24;
  const filled = Math.max(0, Math.min(width, Math.round((pctUsed / 100) * width)));
  const cells: string[] = Array.from({ length: width }, (_, i) => (i < filled ? '█' : '░'));
  const caret = Math.max(0, Math.min(width - 1, Math.round((projectedPct / 100) * width) - 1));
  if (projectedPct > pctUsed) cells[caret] = '▸';
  return `[${cells.join('')}]`;
}
