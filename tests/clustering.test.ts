import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';

// We test the deterministic plumbing: schema is wired, the dashboard view
// reads clusters out of the DB and filters them to the window's session set.
// The LLM call itself is covered manually via `tokentrail cluster`.

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('feature_clusters schema', () => {
  test('feature_clusters and feature_cluster_runs tables exist', () => {
    const db = makeDb();
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    assert.ok(tables.includes('feature_clusters'));
    assert.ok(tables.includes('feature_cluster_runs'));
  });

  test('clusters survive insert + readback', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO feature_clusters
         (id, feature_key, cluster_name, session_ids, session_count, total_usd, rank)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('id1', 'foo', 'Sidebar redesign', 'sess-a,sess-b', 2, 120.5, 0);
    const row = db
      .prepare(`SELECT * FROM feature_clusters WHERE feature_key = ?`)
      .get('foo') as { cluster_name: string; session_count: number; total_usd: number };
    assert.equal(row.cluster_name, 'Sidebar redesign');
    assert.equal(row.session_count, 2);
    assert.equal(row.total_usd, 120.5);
  });
});

describe('buildFeatureDetail integrates clusters', () => {
  test('clusters appear in VM and are filtered to in-window sessions', async () => {
    const db = makeDb();

    // Two sessions in the window, one out.
    const inSessions = ['sess-in-a', 'sess-in-b'];
    db.prepare(
      `INSERT INTO sessions (session_id, project_dir, first_seen_at, last_seen_at, title)
       VALUES (?, ?, datetime('now','-1 day'), datetime('now','-1 day'), ?)`
    ).run(inSessions[0], '/tmp/x', 'in-a');
    db.prepare(
      `INSERT INTO sessions (session_id, project_dir, first_seen_at, last_seen_at, title)
       VALUES (?, ?, datetime('now','-1 day'), datetime('now','-1 day'), ?)`
    ).run(inSessions[1], '/tmp/x', 'in-b');
    // A "stale" cluster member that's not in this window's session set.
    db.prepare(
      `INSERT INTO sessions (session_id, project_dir, first_seen_at, last_seen_at, title)
       VALUES (?, ?, datetime('now','-90 day'), datetime('now','-90 day'), ?)`
    ).run('sess-stale', '/tmp/x', 'stale');

    // Minimal usage event so cost > 0 isn't strictly required.
    db.prepare(
      `INSERT INTO feature_rollups (id, date, feature_key, feature_name, total_input_tokens, total_output_tokens, total_cost_usd, sessions_count, session_ids)
       VALUES ('r1', date('now','-1 day','localtime'), 'foo', 'Foo', 0, 0, 50, 2, ?)`
    ).run(inSessions.join(','));

    db.prepare(
      `INSERT INTO feature_clusters (id, feature_key, cluster_name, session_ids, session_count, total_usd, rank)
       VALUES ('c1', 'foo', 'Sidebar redesign', ?, 3, 30, 0)`
    ).run([...inSessions, 'sess-stale'].join(','));

    const { buildFeatureDetail } = await import('../src/dashboard/data/feature.js');
    const vm = buildFeatureDetail(db, { featureKey: 'foo', days: 7 });
    assert.ok(vm, 'vm should not be null');
    assert.equal(vm.clusters.length, 1);
    const cluster = vm.clusters[0]!;
    assert.equal(cluster.name, 'Sidebar redesign');
    // sess-stale is dropped because it's not in the window's session set.
    assert.equal(cluster.sessionCount, 2);
    assert.deepEqual(cluster.sessionIds.slice().sort(), inSessions.slice().sort());
  });
});
