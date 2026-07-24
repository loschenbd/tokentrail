import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { runCursorUsage } from '../src/commands/cursor.js';

describe('cursor_daily_cost schema', () => {
  test('table exists with date PK', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(cursor_daily_cost)`).all() as Array<{ name: string; pk: number }>;
    const names = cols.map((c) => c.name);
    assert.ok(names.includes('date'));
    assert.ok(names.includes('usd'));
    assert.ok(names.includes('updated_at'));
    assert.equal(cols.find((c) => c.name === 'date')?.pk, 1);
  });
});

const UTIL = { cycleStart: '2026-07-01T00:00:00Z', cycleEnd: 'b', membershipType: 'pro',
  planUsed: 1, planLimit: 10, planPctUsed: 10, ondemandEnabled: false, ondemandUsed: 0 };

test('runCursorUsage upserts per-day rows from metered.byDay', async () => {
  const db = new Database(':memory:'); runMigrations(db);
  await runCursorUsage(db, { cookie: 'c', util: UTIL as any, metered: {
    usd: 5, byDay: { '2026-07-10': 3, '2026-07-11': 2 }, eventsScanned: 2, eventsTotal: 2, truncated: false } });
  const rows = db.prepare('SELECT date, usd FROM cursor_daily_cost ORDER BY date').all();
  assert.deepEqual(rows, [{ date: '2026-07-10', usd: 3 }, { date: '2026-07-11', usd: 2 }]);
});

test('partial run (metered null) leaves existing daily rows intact', async () => {
  const db = new Database(':memory:'); runMigrations(db);
  await runCursorUsage(db, { cookie: 'c', util: UTIL as any, metered: {
    usd: 5, byDay: { '2026-07-10': 3 }, eventsScanned: 1, eventsTotal: 1, truncated: false } });
  // second run: util present, metered failed (null) -> stale, daily rows untouched
  const r = await runCursorUsage(db, { cookie: 'c', util: UTIL as any, metered: null });
  assert.equal(r, 'stale');
  const rows = db.prepare('SELECT date, usd FROM cursor_daily_cost').all();
  assert.deepEqual(rows, [{ date: '2026-07-10', usd: 3 }]);
});
