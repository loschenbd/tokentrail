import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildToday } from '../src/dashboard/data/api.js';

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function insertRollup(db: Database.Database, params: {
  date: string;
  featureKey: string;
  featureName: string;
  repo: string | null;
  cost: number;
  sessionIds: string;
  sessions: number;
}) {
  db.prepare(
    `INSERT INTO feature_rollups (id, date, feature_key, feature_name, repo, total_input_tokens, total_output_tokens, total_cost_usd, sessions_count, session_ids)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
  ).run(
    `${params.date}::${params.featureKey}`,
    params.date,
    params.featureKey,
    params.featureName,
    params.repo,
    params.cost,
    params.sessions,
    params.sessionIds,
  );
}

function insertAnomaly(db: Database.Database, opts: { date: string; dismissed: boolean; featureKey?: string }) {
  // Vary feature_key so the (kind, date, feature_key, session_id) dedupe
  // index in src/db/schema.ts doesn't reject the 2nd/3rd insert.
  db.prepare(
    `INSERT INTO anomalies (kind, date, feature_key, session_id, amount, baseline, multiplier, reason, dismissed_at)
     VALUES ('feature_spike', ?, ?, NULL, 10, 1, 10, '10x baseline', ?)`
  ).run(opts.date, opts.featureKey ?? 'feat-x', opts.dismissed ? "2026-06-16T00:00:00Z" : null);
}

describe('buildToday', () => {
  test('returns today total, top 3 features (with hrefs), and open anomaly count', () => {
    const db = makeDb();
    const today = (db.prepare(`SELECT date('now','localtime') AS d`).get() as { d: string }).d;

    insertRollup(db, { date: today, featureKey: 'feat-a', featureName: 'Feature A', repo: 'owner/repo', cost: 1.10, sessionIds: 'sA', sessions: 1 });
    insertRollup(db, { date: today, featureKey: 'feat-b', featureName: 'Feature B', repo: 'owner/repo', cost: 0.80, sessionIds: 'sB', sessions: 1 });
    insertRollup(db, { date: today, featureKey: 'feat-c', featureName: 'Feature C', repo: 'owner/repo', cost: 0.50, sessionIds: 'sC', sessions: 1 });
    insertRollup(db, { date: today, featureKey: 'feat-d', featureName: 'Feature D', repo: 'owner/repo', cost: 0.20, sessionIds: 'sD', sessions: 1 });

    insertAnomaly(db, { date: today, dismissed: false, featureKey: 'feat-anom-1' });
    insertAnomaly(db, { date: today, dismissed: false, featureKey: 'feat-anom-2' });
    insertAnomaly(db, { date: today, dismissed: true, featureKey: 'feat-anom-3' });   // dismissed → not counted

    const r = buildToday(db);

    assert.equal(r.todayUsd, 2.60);
    assert.equal(r.topFeatures.length, 3);
    assert.equal(r.topFeatures[0]!.key, 'feat-a');
    assert.equal(r.topFeatures[0]!.name, 'Feature A');
    assert.equal(r.topFeatures[0]!.usd, 1.10);
    assert.equal(r.topFeatures[0]!.href, 'http://127.0.0.1:4920/feature/feat-a');
    assert.equal(r.anomalyCount, 2);
    assert.match(r.asOf, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('handles empty day: zero totals, empty array, zero anomalies', () => {
    const db = makeDb();
    const r = buildToday(db);

    assert.equal(r.todayUsd, 0);
    assert.equal(r.topFeatures.length, 0);
    assert.equal(r.anomalyCount, 0);
  });

  test('URL-encodes feature keys with slashes or unusual characters', () => {
    const db = makeDb();
    const today = (db.prepare(`SELECT date('now','localtime') AS d`).get() as { d: string }).d;
    insertRollup(db, { date: today, featureKey: 'repo:owner/name', featureName: 'Has slash', repo: null, cost: 1, sessionIds: 's', sessions: 1 });

    const r = buildToday(db);

    assert.equal(r.topFeatures[0]!.href, 'http://127.0.0.1:4920/feature/repo%3Aowner%2Fname');
  });
});
