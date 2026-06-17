import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildWorthALook } from '../src/dashboard/data/worth-a-look.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

function makeDb(): DatabaseType.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seed(db: DatabaseType.Database, rows: Array<{ kind: string; date: string; featureKey: string; reason: string; multiplier: number; dismissed: boolean }>): void {
  const stmt = db.prepare(
    `INSERT INTO anomalies (kind, date, feature_key, session_id, amount, baseline, multiplier, reason, dismissed_at)
     VALUES (?, ?, ?, NULL, 100, 30, ?, ?, ?)`
  );
  for (const r of rows) {
    stmt.run(r.kind, r.date, r.featureKey, r.multiplier, r.reason, r.dismissed ? '2026-06-15T00:00:00Z' : null);
  }
}

describe('buildWorthALook', () => {
  test('default: returns only active anomalies', () => {
    const db = makeDb();
    seed(db, [
      { kind: 'spike_day', date: '2026-06-02', featureKey: 'f1', reason: 'active 1', multiplier: 3.1, dismissed: false },
      { kind: 'spike_day', date: '2026-06-01', featureKey: 'f2', reason: 'dismissed 1', multiplier: 4.0, dismissed: true },
    ]);

    const vm = buildWorthALook(db, { showDismissed: false });

    assert.equal(vm.showDismissed, false);
    assert.equal(vm.dismissedCount, 1);
    assert.equal(vm.items.length, 1);
    assert.equal(vm.items[0]!.reason, 'active 1');
    assert.equal(vm.items[0]!.dismissed, false);
  });

  test('showDismissed=true: returns both, active first', () => {
    const db = makeDb();
    seed(db, [
      { kind: 'spike_day', date: '2026-06-01', featureKey: 'f1', reason: 'dismissed old', multiplier: 5.0, dismissed: true },
      { kind: 'spike_day', date: '2026-06-02', featureKey: 'f2', reason: 'active newer', multiplier: 3.1, dismissed: false },
    ]);

    const vm = buildWorthALook(db, { showDismissed: true });

    assert.equal(vm.showDismissed, true);
    assert.equal(vm.dismissedCount, 1);
    assert.equal(vm.items.length, 2);
    // Active first regardless of date.
    assert.equal(vm.items[0]!.dismissed, false);
    assert.equal(vm.items[1]!.dismissed, true);
  });

  test('empty: counts are zero', () => {
    const db = makeDb();
    const vm = buildWorthALook(db, { showDismissed: true });
    assert.equal(vm.items.length, 0);
    assert.equal(vm.dismissedCount, 0);
  });
});
