import type DatabaseType from 'better-sqlite3';

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

// Days into a cycle before the linear projection is worth showing.
const PROJECTION_MIN_DAYS = 3;

export function buildBudget(
  db: DatabaseType.Database,
  // `today` (YYYY-MM-DD) is injectable for deterministic tests; production
  // leaves it undefined and we read the DB's localtime clock.
  opts: { budgetUsd: number | null; cycleStartDay: number; today?: string }
): BudgetStatus | null {
  if (!opts.budgetUsd || opts.budgetUsd <= 0) return null;

  // Use the app's localtime "today" so the cycle lines up with the rest of the UI.
  const today =
    opts.today ?? (db.prepare(`SELECT date('now', 'localtime') AS d`).get() as { d: string }).d;
  const { cycleStart, cycleEnd, daysElapsed, daysInCycle } = cycleBounds(today, opts.cycleStartDay);

  // usage_events (Claude + Copilot) within the cycle.
  const ue = (db
    .prepare(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS u FROM usage_events
        WHERE date(timestamp) >= ? AND date(timestamp) < ?`
    )
    .get(cycleStart, cycleEnd) as { u: number }).u;
  // Cursor's per-day metered rollup within the cycle (its own table).
  const cur = (db
    .prepare(
      `SELECT COALESCE(SUM(usd), 0) AS u FROM cursor_daily_cost
        WHERE date >= ? AND date < ?`
    )
    .get(cycleStart, cycleEnd) as { u: number }).u;

  const spentUsd = round2(ue + cur);
  const projectedUsd = round2(daysElapsed > 0 ? (spentUsd / daysElapsed) * daysInCycle : spentUsd);
  const pctUsed = round1((spentUsd / opts.budgetUsd) * 100);
  const projectedPct = round1((projectedUsd / opts.budgetUsd) * 100);
  const projectionReliable = daysElapsed >= PROJECTION_MIN_DAYS;

  // Once we trust the projection, either an already-over cycle or a run-rate
  // heading over trips the state. Early on, only actual spend counts — a single
  // spendy day shouldn't scream "trending over".
  const state: BudgetStatus['state'] = projectionReliable
    ? pctUsed >= 100 || projectedPct > 100
      ? 'over'
      : projectedPct >= 80
        ? 'warn'
        : 'ok'
    : pctUsed >= 100
      ? 'over'
      : pctUsed >= 80
        ? 'warn'
        : 'ok';

  return {
    budgetUsd: opts.budgetUsd,
    cycleStart,
    cycleEnd,
    spentUsd,
    projectedUsd,
    pctUsed,
    projectedPct,
    daysElapsed,
    daysInCycle,
    projectionReliable,
    state,
  };
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
