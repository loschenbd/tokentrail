import type DatabaseType from 'better-sqlite3';
import { SOURCE_VALUES } from '../../lib/feature-aggregate.js';
import type { SourceBudgets } from '../../lib/config.js';

// Burn-rate / budget status for the current billing cycle. Null when no budget
// is configured (feature is opt-in). Spend covers ALL sources the user sees as
// their total: usage_events (Claude + Copilot) + Cursor's per-day rollup — so
// the budget tracks the same blended number as the headline total.
export type BudgetStatus = {
  budgetUsd: number;
  cycleStart: string; // YYYY-MM-DD, inclusive
  cycleEnd: string;   // YYYY-MM-DD, exclusive (next cycle start)
  spentUsd: number;   // cycle-to-date
  projectedUsd: number; // run-rate projection to cycle end
  pctUsed: number;      // spentUsd / budgetUsd * 100
  projectedPct: number; // projectedUsd / budgetUsd * 100
  daysElapsed: number;  // days into the cycle, including today
  daysInCycle: number;
  // A linear run-rate over 1-2 days extrapolates wildly (one $300 day → a
  // $9k month), so the forecast isn't trustworthy until a few days in. When
  // false, UIs should soften the projection and `state` ignores it (falling
  // back to actual spend-vs-budget). Threshold: 3 elapsed days.
  projectionReliable: boolean;
  // Coarse state for UI coloring: ok (<80% projected), warn (80-100%), over (>100%).
  // Before the projection is reliable, derived from actual pctUsed alone.
  state: 'ok' | 'warn' | 'over';
};

export type BudgetSourceKey = 'claude' | 'copilot' | 'cursor';
export type SourceBudgetStatus = BudgetStatus & { key: BudgetSourceKey; label: string };
export type BudgetReport = BudgetStatus & { sources: SourceBudgetStatus[] };

const SOURCE_LABELS: Record<BudgetSourceKey, string> = {
  claude: 'Claude Code', copilot: 'Copilot', cursor: 'Cursor',
};

// Days into a cycle before the linear projection is worth showing.
const PROJECTION_MIN_DAYS = 3;

// Pure: spend + budget + cycle position → the full status shape. Shared by the
// global budget and every per-source cap so the state logic can't diverge.
function computeStatus(
  spentUsd: number, budgetUsd: number, daysElapsed: number, daysInCycle: number,
  cycleStart: string, cycleEnd: string,
): BudgetStatus {
  if (budgetUsd <= 0) {
    const projectedUsd = round2(daysElapsed > 0 ? (spentUsd / daysElapsed) * daysInCycle : spentUsd);
    return { budgetUsd: 0, cycleStart, cycleEnd, spentUsd, projectedUsd, pctUsed: 0,
      projectedPct: 0, daysElapsed, daysInCycle, projectionReliable: daysElapsed >= PROJECTION_MIN_DAYS, state: 'ok' };
  }
  const projectedUsd = round2(daysElapsed > 0 ? (spentUsd / daysElapsed) * daysInCycle : spentUsd);
  const pctUsed = round1((spentUsd / budgetUsd) * 100);
  const projectedPct = round1((projectedUsd / budgetUsd) * 100);
  const projectionReliable = daysElapsed >= PROJECTION_MIN_DAYS;
  // Once we trust the projection, either an already-over cycle or a run-rate
  // heading over trips the state. Early on, only actual spend counts — a single
  // spendy day shouldn't scream "trending over".
  const state: BudgetStatus['state'] = projectionReliable
    ? (pctUsed >= 100 || projectedPct > 100 ? 'over' : projectedPct >= 80 ? 'warn' : 'ok')
    : (pctUsed >= 100 ? 'over' : pctUsed >= 80 ? 'warn' : 'ok');
  return { budgetUsd, cycleStart, cycleEnd, spentUsd, projectedUsd, pctUsed,
    projectedPct, daysElapsed, daysInCycle, projectionReliable, state };
}

// Cycle-to-date spend for one source, using the SAME source→spend mapping as
// the per-harness overview (SOURCE_VALUES for usage_events; cursor_daily_cost
// for Cursor).
function sourceSpend(db: DatabaseType.Database, key: BudgetSourceKey, start: string, end: string): number {
  if (key === 'cursor') {
    return (db.prepare(`SELECT COALESCE(SUM(usd),0) AS u FROM cursor_daily_cost WHERE date >= ? AND date < ?`)
      .get(start, end) as { u: number }).u;
  }
  const vals = SOURCE_VALUES[key];                      // fixed whitelist, no injection
  const ph = vals.map(() => '?').join(',');
  return (db.prepare(
    `SELECT COALESCE(SUM(estimated_cost_usd),0) AS u FROM usage_events
      WHERE source IN (${ph}) AND date(timestamp) >= ? AND date(timestamp) < ?`
  ).get(...vals, start, end) as { u: number }).u;
}

export function buildBudget(
  db: DatabaseType.Database,
  // `today` (YYYY-MM-DD) is injectable for deterministic tests; production
  // leaves it undefined and we read the DB's localtime clock.
  opts: { budgetUsd: number | null; cycleStartDay: number; sourceBudgets?: SourceBudgets; today?: string }
): BudgetReport | null {
  const sb: SourceBudgets = opts.sourceBudgets ?? { claude: null, copilot: null, cursor: null };
  const hasGlobal = !!opts.budgetUsd && opts.budgetUsd > 0;
  const configuredSources = (Object.keys(sb) as BudgetSourceKey[]).filter((k) => sb[k] && sb[k]! > 0);
  if (!hasGlobal && configuredSources.length === 0) return null;

  // Use the app's localtime "today" so the cycle lines up with the rest of the UI.
  const today =
    opts.today ?? (db.prepare(`SELECT date('now', 'localtime') AS d`).get() as { d: string }).d;
  const { cycleStart, cycleEnd, daysElapsed, daysInCycle } = cycleBounds(today, opts.cycleStartDay);

  // Global blended spend (unchanged behavior): usage_events + cursor_daily_cost.
  const ueAll = (db
    .prepare(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS u FROM usage_events
        WHERE date(timestamp) >= ? AND date(timestamp) < ?`
    )
    .get(cycleStart, cycleEnd) as { u: number }).u;
  const curAll = (db
    .prepare(
      `SELECT COALESCE(SUM(usd), 0) AS u FROM cursor_daily_cost
        WHERE date >= ? AND date < ?`
    )
    .get(cycleStart, cycleEnd) as { u: number }).u;
  const globalSpent = round2(ueAll + curAll);

  // When there's no global budget we still return a report (for the source
  // caps); budgetUsd 0 signals "no global bar" to every UI.
  const global = computeStatus(globalSpent, hasGlobal ? opts.budgetUsd! : 0, daysElapsed, daysInCycle, cycleStart, cycleEnd);

  const sources: SourceBudgetStatus[] = configuredSources.map((key) => {
    const spent = round2(sourceSpend(db, key, cycleStart, cycleEnd));
    const s = computeStatus(spent, sb[key]!, daysElapsed, daysInCycle, cycleStart, cycleEnd);
    return { ...s, key, label: SOURCE_LABELS[key] };
  });

  return { ...global, sources };
}

// Pure date math on a YYYY-MM-DD string. cycleStartDay is 1-28. The cycle is
// the [start, start+1 month) window containing `today`. Exported for tests.
export function cycleBounds(
  today: string,
  cycleStartDay: number
): { cycleStart: string; cycleEnd: string; daysElapsed: number; daysInCycle: number } {
  const day = Math.min(28, Math.max(1, Math.trunc(cycleStartDay)));
  const [y, m, d] = today.split('-').map((n) => parseInt(n, 10)) as [number, number, number];

  // Cycle start month/year: this month if we're at/after the reset day, else last month.
  let sy = y;
  let sm = m; // 1-12
  if (d < day) {
    sm -= 1;
    if (sm === 0) { sm = 12; sy -= 1; }
  }
  const cycleStart = ymd(sy, sm, day);

  let ey = sy;
  let em = sm + 1;
  if (em === 13) { em = 1; ey += 1; }
  const cycleEnd = ymd(ey, em, day);

  const daysInCycle = daysBetween(cycleStart, cycleEnd);
  const daysElapsed = daysBetween(cycleStart, today) + 1; // inclusive of today
  return { cycleStart, cycleEnd, daysElapsed, daysInCycle };
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Whole days from a→b (b assumed >= a). UTC midnight avoids DST off-by-one.
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
  const ms = Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad);
  return Math.round(ms / 86_400_000);
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round1(n: number): number { return Math.round(n * 10) / 10; }
