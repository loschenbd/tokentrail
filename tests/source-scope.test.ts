import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { aggregateFeatureBuckets } from '../src/lib/feature-aggregate.js';
import {
  materializeScopedRollup,
  presentScopes,
  isSourceScope,
} from '../src/dashboard/data/scoped-rollup.js';
import { buildOverview } from '../src/dashboard/data/overview.js';

// Seed a usage_event with an explicit source + inferred feature so attribution
// is deterministic (no work_units/sessions joins needed). Today's date so it
// lands inside every window.
let seq = 0;
function seedEvent(
  db: Database.Database,
  opts: { source: string; repo: string; feature: string; usd: number; date?: string }
) {
  const id = `e${seq++}`;
  const ts = `${opts.date ?? todayOf(db)}T12:00:00.000Z`;
  db.prepare(
    `INSERT INTO usage_events
       (id, session_id, timestamp, repo, branch, model,
        estimated_cost_usd, source, inferred_feature_key, inferred_feature_name)
     VALUES (?, ?, ?, ?, 'main', 'm', ?, ?, ?, ?)`
  ).run(id, `s${id}`, ts, opts.repo, opts.usd, opts.source, opts.feature, opts.feature);
}
function todayOf(db: Database.Database): string {
  return (db.prepare(`SELECT date('now','localtime') AS d`).get() as { d: string }).d;
}
function tableSum(db: Database.Database, table: string): number {
  return (
    (db.prepare(`SELECT COALESCE(SUM(total_cost_usd),0) AS u FROM ${table}`).get() as { u: number }).u
  );
}

describe('isSourceScope', () => {
  test('accepts known scopes, rejects junk', () => {
    for (const s of ['all', 'claude', 'copilot', 'cursor']) assert.equal(isSourceScope(s), true);
    for (const s of ['', 'jsonl', 'hook', 'CLAUDE', 42, null, undefined]) {
      assert.equal(isSourceScope(s as unknown), false);
    }
  });
});

describe('aggregateFeatureBuckets source filter', () => {
  test('claude filter excludes copilot events and vice versa', () => {
    const db = new Database(':memory:'); runMigrations(db);
    seedEvent(db, { source: 'jsonl', repo: 'local/a', feature: 'feat-a', usd: 10 });
    seedEvent(db, { source: 'hook', repo: 'local/a', feature: 'feat-a', usd: 5 });
    seedEvent(db, { source: 'copilot', repo: 'local/a', feature: 'feat-a', usd: 3 });

    const claude = aggregateFeatureBuckets(db, { source: 'claude' });
    const copilot = aggregateFeatureBuckets(db, { source: 'copilot' });
    const all = aggregateFeatureBuckets(db);

    const sum = (m: Map<string, { cost: number }>) =>
      [...m.values()].reduce((s, b) => s + b.cost, 0);
    assert.equal(sum(claude), 15); // jsonl + hook
    assert.equal(sum(copilot), 3); // copilot only
    assert.equal(sum(all), 18);    // everything
  });
});

describe('materializeScopedRollup', () => {
  test("'all' returns the real feature_rollups table untouched", () => {
    const db = new Database(':memory:'); runMigrations(db);
    assert.equal(materializeScopedRollup(db, 'all'), 'feature_rollups');
  });

  test('claude / copilot temp tables carry only that source', () => {
    const db = new Database(':memory:'); runMigrations(db);
    seedEvent(db, { source: 'jsonl', repo: 'local/a', feature: 'feat-a', usd: 10 });
    seedEvent(db, { source: 'copilot', repo: 'local/a', feature: 'feat-a', usd: 4 });

    const claudeTable = materializeScopedRollup(db, 'claude');
    assert.equal(tableSum(db, claudeTable), 10);

    // Re-materializing for a different scope replaces the same temp table.
    const copilotTable = materializeScopedRollup(db, 'copilot');
    assert.equal(copilotTable, claudeTable); // same fixed temp table name
    assert.equal(tableSum(db, copilotTable), 4);
  });

  test('cursor scope pulls the metered daily cost as a single band', () => {
    const db = new Database(':memory:'); runMigrations(db);
    const today = todayOf(db);
    db.prepare(`INSERT INTO cursor_daily_cost (date, usd, updated_at) VALUES (?, ?, '2026-08-01')`)
      .run(today, 7.5);
    db.prepare(`INSERT INTO cursor_daily_cost (date, usd, updated_at) VALUES ('2026-07-01', 0, '2026-08-01')`)
      .run(); // zero-cost day excluded

    const table = materializeScopedRollup(db, 'cursor');
    assert.equal(tableSum(db, table), 7.5);
    const rows = db.prepare(`SELECT feature_name FROM ${table}`).all() as Array<{ feature_name: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.feature_name, 'Cursor (metered)');
  });
});

describe('presentScopes', () => {
  test('always includes all; adds sources only when they have data', () => {
    const db = new Database(':memory:'); runMigrations(db);
    assert.deepEqual(presentScopes(db), ['all']); // empty DB

    seedEvent(db, { source: 'jsonl', repo: 'local/a', feature: 'feat-a', usd: 1 });
    assert.deepEqual(presentScopes(db), ['all', 'claude']);

    seedEvent(db, { source: 'copilot', repo: 'local/a', feature: 'feat-a', usd: 1 });
    db.prepare(`INSERT INTO cursor_daily_cost (date, usd, updated_at) VALUES (date('now'), 2, 'x')`).run();
    assert.deepEqual(presentScopes(db), ['all', 'claude', 'copilot', 'cursor']);
  });
});

describe('buildOverview scoped by source', () => {
  test('a scoped overview totals only that harness', () => {
    const db = new Database(':memory:'); runMigrations(db);
    seedEvent(db, { source: 'jsonl', repo: 'local/a', feature: 'feat-a', usd: 20 });
    seedEvent(db, { source: 'copilot', repo: 'local/b', feature: 'feat-b', usd: 6 });

    const claudeTable = materializeScopedRollup(db, 'claude');
    const claudeVM = buildOverview({ db, days: 30, rollupTable: claudeTable });
    assert.equal(claudeVM.totalUsd, 20);

    const copilotTable = materializeScopedRollup(db, 'copilot');
    const copilotVM = buildOverview({ db, days: 30, rollupTable: copilotTable });
    assert.equal(copilotVM.totalUsd, 6);
  });

  test('rejects an unsafe rollup table name', () => {
    const db = new Database(':memory:'); runMigrations(db);
    assert.throws(
      () => buildOverview({ db, days: 30, rollupTable: 'feature_rollups; DROP TABLE x' }),
      /Unsafe rollup table name/
    );
  });
});
