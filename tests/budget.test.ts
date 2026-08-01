import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildBudget, cycleBounds } from '../src/dashboard/data/budget.js';

// A usage_events row on `date` (YYYY-MM-DD) costing `usd`. Only the columns
// buildBudget reads (timestamp, estimated_cost_usd) matter.
function seedEvent(db: Database.Database, id: string, date: string, usd: number) {
  db.prepare(
    `INSERT INTO usage_events
       (id, session_id, timestamp, model, estimated_cost_usd, source)
     VALUES (?, 's', ?, 'claude', ?, 'jsonl')`
  ).run(id, `${date}T12:00:00.000Z`, usd);
}
function seedCursorDay(db: Database.Database, date: string, usd: number) {
  db.prepare(`INSERT INTO cursor_daily_cost (date, usd, updated_at) VALUES (?, ?, '2026-07-24')`).run(date, usd);
}

describe('cycleBounds', () => {
  test('day-1 cycle spans the calendar month', () => {
    const b = cycleBounds('2026-08-15', 1);
    assert.equal(b.cycleStart, '2026-08-01');
    assert.equal(b.cycleEnd, '2026-09-01');
    assert.equal(b.daysInCycle, 31);
    assert.equal(b.daysElapsed, 15); // inclusive of the 15th
  });

  test('mid-month reset day, today at/after the reset', () => {
    const b = cycleBounds('2026-08-20', 10);
    assert.equal(b.cycleStart, '2026-08-10');
    assert.equal(b.cycleEnd, '2026-09-10');
    assert.equal(b.daysInCycle, 31);
    assert.equal(b.daysElapsed, 11);
  });

  test('today before the reset day rolls back to the previous cycle', () => {
    const b = cycleBounds('2026-08-05', 10);
    assert.equal(b.cycleStart, '2026-07-10');
    assert.equal(b.cycleEnd, '2026-08-10');
    assert.equal(b.daysElapsed, 27); // Jul 10 → Aug 5 inclusive
  });

  test('January reset rolls the year back', () => {
    const b = cycleBounds('2026-01-03', 15);
    assert.equal(b.cycleStart, '2025-12-15');
    assert.equal(b.cycleEnd, '2026-01-15');
  });

  test('cycleStartDay is clamped to 1-28', () => {
    // 31 clamps to 28. today=Aug 15 is before day 28, so the cycle rolls back
    // to [Jul 28, Aug 28). Guards against short-month drift (no Feb 30/31).
    const hi = cycleBounds('2026-08-15', 31);
    assert.equal(hi.cycleStart, '2026-07-28');
    assert.equal(hi.cycleEnd, '2026-08-28');
    const lo = cycleBounds('2026-08-15', 0);
    assert.equal(lo.cycleStart, '2026-08-01'); // 0 clamps to 1
  });
});

describe('buildBudget', () => {
  test('returns null when no budget configured', () => {
    const db = new Database(':memory:'); runMigrations(db);
    assert.equal(buildBudget(db, { budgetUsd: null, cycleStartDay: 1 }), null);
    assert.equal(buildBudget(db, { budgetUsd: 0, cycleStartDay: 1 }), null);
  });

  // A fixed clock so cycle math + reliability thresholds are deterministic
  // regardless of the calendar day the suite runs on. Aug 15 with a day-1
  // cycle → 15 days elapsed in a 31-day cycle.
  const TODAY = '2026-08-15';

  test('sums usage_events + cursor within the current cycle only', () => {
    const db = new Database(':memory:'); runMigrations(db);
    // Cycle is [2026-08-01, 2026-09-01). Two in-cycle rows + one cursor day,
    // plus a July event that must be excluded.
    seedEvent(db, 'a', '2026-08-01', 10);
    seedEvent(db, 'b', TODAY, 5);
    seedCursorDay(db, TODAY, 3);
    seedEvent(db, 'old', '2026-07-31', 99);

    const b = buildBudget(db, { budgetUsd: 200, cycleStartDay: 1, today: TODAY })!;
    assert.ok(b);
    assert.equal(b.cycleStart, '2026-08-01');
    assert.equal(b.spentUsd, 18); // 10 + 5 + 3, the 99 excluded
    assert.equal(b.budgetUsd, 200);
    assert.equal(b.pctUsed, 9); // 18/200
  });

  test('projects run-rate to cycle end and flags the over state', () => {
    const db = new Database(':memory:'); runMigrations(db);
    // 15 days elapsed, $20/day → projected ≈ $620 over a $100 budget.
    const bounds = cycleBounds(TODAY, 1);
    assert.equal(bounds.daysElapsed, 15);
    seedEvent(db, 'a', TODAY, 20 * bounds.daysElapsed);
    const b = buildBudget(db, { budgetUsd: 100, cycleStartDay: 1, today: TODAY })!;
    assert.equal(b.projectionReliable, true);
    assert.ok(b.projectedUsd >= 20 * bounds.daysInCycle - 1);
    assert.equal(b.state, 'over');
  });

  test('run-rate at ~85% of budget reads as "warn"', () => {
    const db = new Database(':memory:'); runMigrations(db);
    const bounds = cycleBounds(TODAY, 1); // 15 elapsed / 31
    // Spend so the projection lands ~85% of budget: perDay*31 = 0.85*budget.
    const budgetUsd = 1000;
    const perDay = (0.85 * budgetUsd) / bounds.daysInCycle;
    seedEvent(db, 'a', TODAY, perDay * bounds.daysElapsed);
    const b = buildBudget(db, { budgetUsd, cycleStartDay: 1, today: TODAY })!;
    assert.equal(b.projectionReliable, true);
    assert.ok(b.projectedPct >= 80 && b.projectedPct <= 100, `projectedPct=${b.projectedPct}`);
    assert.equal(b.state, 'warn');
  });

  test('projection is unreliable in the first days; state ignores it', () => {
    const db = new Database(':memory:'); runMigrations(db);
    // Day 1 of the cycle: a single big day over budget. pctUsed drives state,
    // the wild ×31 projection is suppressed.
    seedEvent(db, 'a', '2026-08-01', 500);
    const b = buildBudget(db, { budgetUsd: 200, cycleStartDay: 1, today: '2026-08-01' })!;
    assert.equal(b.daysElapsed, 1);
    assert.equal(b.projectionReliable, false);
    assert.equal(b.state, 'over'); // from pctUsed alone (250%), not the projection
  });

  test('a single spendy first day does not read as "trending over"', () => {
    const db = new Database(':memory:'); runMigrations(db);
    // 60% of budget on day 1: projection would scream over, but actual is <80%.
    seedEvent(db, 'a', '2026-08-01', 120);
    const b = buildBudget(db, { budgetUsd: 200, cycleStartDay: 1, today: '2026-08-01' })!;
    assert.equal(b.projectionReliable, false);
    assert.equal(b.state, 'ok'); // 60% actual, projection ignored early
  });

  test('low steady spend stays in the ok state', () => {
    const db = new Database(':memory:'); runMigrations(db);
    const bounds = cycleBounds(TODAY, 1); // 15 elapsed, reliable
    // ~$1/day against a $1000 budget → projected ~$31, ~3% → ok.
    seedEvent(db, 'a', TODAY, 1 * bounds.daysElapsed);
    const b = buildBudget(db, { budgetUsd: 1000, cycleStartDay: 1, today: TODAY })!;
    assert.equal(b.projectionReliable, true);
    assert.equal(b.state, 'ok');
    assert.ok(b.projectedPct < 80);
  });
});
