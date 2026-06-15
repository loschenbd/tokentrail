import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { SCHEMA_STATEMENTS } from '../src/db/schema.js';
import { buildOverview } from '../src/dashboard/data/overview.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

function makeDb(): DatabaseType.Database {
  const db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  return db;
}

describe('buildOverview', () => {
  test('returns zeroed view-model when DB is empty', () => {
    const db = makeDb();
    const vm = buildOverview(db, { days: 30 });
    assert.equal(vm.totalUsd, 0);
    assert.equal(vm.topFeatures.length, 0);
    assert.equal(vm.dailySeries.length, 30);  // zero-filled
    assert.equal(vm.recentCommits.length, 0);
    assert.equal(vm.anomalies.length, 0);
  });

  test('computes total + delta vs prior period of same length', () => {
    const db = makeDb();
    // 4 days inside window @ $10 each = $40; 4 days outside (15-18 days ago) @ $5 = $20.
    seedRollups(db, [
      { date: daysAgo(1), cost: 10 },
      { date: daysAgo(2), cost: 10 },
      { date: daysAgo(3), cost: 10 },
      { date: daysAgo(4), cost: 10 },
      { date: daysAgo(16), cost: 5 },
      { date: daysAgo(17), cost: 5 },
      { date: daysAgo(18), cost: 5 },
      { date: daysAgo(19), cost: 5 },
    ]);
    const vm = buildOverview(db, { days: 14 });
    assert.equal(vm.totalUsd, 40);
    assert.equal(vm.priorUsd, 20);
    assert.equal(vm.deltaPct, 100);
  });

  test('groups top features by total cost descending', () => {
    const db = makeDb();
    seedRollups(db, [
      { date: daysAgo(1), cost: 50, feature_key: 'rag', feature_name: 'Local RAG' },
      { date: daysAgo(2), cost: 80, feature_key: 'archi', feature_name: 'Archi homepage' },
      { date: daysAgo(3), cost: 10, feature_key: 'rag', feature_name: 'Local RAG' },
    ]);
    const vm = buildOverview(db, { days: 30 });
    const [first, second] = vm.topFeatures;
    assert.equal(first!.featureKey, 'archi');
    assert.equal(first!.totalUsd, 80);
    assert.equal(second!.featureKey, 'rag');
    assert.equal(second!.totalUsd, 60);
  });

  test('dailySeries returns one entry per day in window, zero-filled', () => {
    const db = makeDb();
    seedRollups(db, [
      { date: daysAgo(1), cost: 10 },
      { date: daysAgo(3), cost: 20 },
    ]);
    const vm = buildOverview(db, { days: 7 });
    assert.equal(vm.dailySeries.length, 7);
    const totals = vm.dailySeries.map((d) => d.total);
    assert.ok(totals.includes(10));
    assert.ok(totals.includes(20));
    assert.equal(totals.filter((t) => t === 0).length, 5);
  });
});

// The `date` placeholder is resolved inside seedRollups using SQLite's
// date('now', '-N days') — ensures test data uses the same "today" reference
// as buildOverview's SQL.
function daysAgo(n: number): string {
  return `__${n}__`;
}

function seedRollups(
  db: DatabaseType.Database,
  rows: Array<{ date: string; cost: number; feature_key?: string; feature_name?: string }>
): void {
  const insert = db.prepare(`
    INSERT INTO feature_rollups (id, date, feature_key, feature_name, total_cost_usd, sessions_count)
    VALUES (@id, date('now', @offset), @key, @name, @cost, 1)
  `);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const offsetMatch = /^__(\d+)__$/.exec(r.date);
    const offset = offsetMatch ? `-${offsetMatch[1]} days` : '+0 days';
    insert.run({
      id: `t-${i}`,
      offset,
      key: r.feature_key ?? `feat-${i}`,
      name: r.feature_name ?? `Feature ${i}`,
      cost: r.cost,
    });
  }
}
