import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildOverview } from '../src/dashboard/data/overview.js';
import { buildFeatureDetail } from '../src/dashboard/data/feature.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

function makeDb(): DatabaseType.Database {
  const db = new Database(':memory:');
  runMigrations(db);   // runs SCHEMA_STATEMENTS internally, then idempotent ALTER TABLE additions
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

describe('buildFeatureDetail', () => {
  test('returns null when feature has no rollups', () => {
    const db = makeDb();
    const vm = buildFeatureDetail(db, { featureKey: 'missing', days: 30 });
    assert.equal(vm, null);
  });

  test('aggregates rollups, sessions, commits, PRs for a feature', () => {
    const db = makeDb();
    db.exec(`
      INSERT INTO feature_rollups (id, date, feature_key, feature_name, total_cost_usd, sessions_count, session_ids, branches)
      VALUES ('r1', date('now','-1 days'), 'rag', 'Local RAG', 100, 1, 's1', 'feat/rag');
      INSERT INTO sessions (session_id, title, project_dir, first_seen_at, last_seen_at)
      VALUES ('s1', 'Build the RAG', '/repo/rag', date('now','-1 days'), date('now','-1 days'));
      INSERT INTO usage_events (id, session_id, timestamp, model, estimated_cost_usd)
      VALUES ('e1', 's1', datetime('now','-1 days'), 'opus', 100);
      INSERT INTO session_commits (session_id, commit_sha, subject, authored_at, repo)
      VALUES ('s1', 'abcdef0', 'Add retriever', datetime('now','-1 days'), 'me/rag');
      INSERT INTO session_prs (session_id, repo, pr_number, pr_title, pr_url, pr_state, head_branch)
      VALUES ('s1', 'me/rag', 7, 'Add retriever', 'https://github.com/me/rag/pull/7', 'open', 'feat/rag');
    `);
    const vm = buildFeatureDetail(db, { featureKey: 'rag', days: 30 });
    assert.ok(vm);
    assert.equal(vm!.featureKey, 'rag');
    assert.equal(vm!.totalUsd, 100);
    assert.equal(vm!.sessions.length, 1);
    assert.equal(vm!.sessions[0]!.commits.length, 1);
    assert.equal(vm!.sessions[0]!.prs.length, 1);
    assert.equal(vm!.sessions[0]!.prs[0]!.prNumber, 7);
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
