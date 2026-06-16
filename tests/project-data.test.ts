import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildProjectDetail } from '../src/dashboard/data/project.js';

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

describe('buildProjectDetail', () => {
  test('repo:* key aggregates every feature whose repo matches', () => {
    const db = makeDb();
    const today = db.prepare(`SELECT date('now','-1 day','localtime') AS d`).get() as { d: string };
    insertRollup(db, { date: today.d, featureKey: 'mainline-loschenbd-archi-main', featureName: 'archi (main)', repo: 'loschenbd/archi', cost: 100, sessionIds: 'sess-a', sessions: 1 });
    insertRollup(db, { date: today.d, featureKey: 'archi-onboarding', featureName: 'Archi onboarding', repo: 'loschenbd/archi', cost: 40, sessionIds: 'sess-b', sessions: 1 });
    insertRollup(db, { date: today.d, featureKey: 'other-feat', featureName: 'Other', repo: 'loschenbd/elsewhere', cost: 999, sessionIds: 'sess-c', sessions: 1 });

    const vm = buildProjectDetail(db, { projectKey: 'repo:loschenbd/archi', days: 7 });
    assert.ok(vm, 'vm should not be null');
    assert.equal(vm.projectName, 'archi');
    assert.equal(vm.totalUsd, 140);
    assert.equal(vm.featureCount, 2);
    assert.equal(vm.features[0]!.featureKey, 'mainline-loschenbd-archi-main');
    assert.equal(vm.features[1]!.featureKey, 'archi-onboarding');
  });

  test('local:* key maps to local/<basename> repos', () => {
    const db = makeDb();
    const today = db.prepare(`SELECT date('now','-1 day','localtime') AS d`).get() as { d: string };
    insertRollup(db, { date: today.d, featureKey: 'mainline-local-pm-os-main', featureName: 'pm-os (main)', repo: 'local/pm-os', cost: 25, sessionIds: 'sess-1', sessions: 1 });

    const vm = buildProjectDetail(db, { projectKey: 'local:pm-os', days: 7 });
    assert.ok(vm);
    assert.equal(vm.projectName, 'pm-os');
    assert.equal(vm.totalUsd, 25);
  });

  test('feature:* key returns the single feature as a project', () => {
    const db = makeDb();
    const today = db.prepare(`SELECT date('now','-1 day','localtime') AS d`).get() as { d: string };
    insertRollup(db, { date: today.d, featureKey: 'outside:projects-anamnesis', featureName: 'Anamnesis', repo: null, cost: 70, sessionIds: 'sess-x', sessions: 1 });

    const vm = buildProjectDetail(db, { projectKey: 'feature:outside:projects-anamnesis', days: 7 });
    assert.ok(vm);
    assert.equal(vm.projectName, 'Anamnesis');
    assert.equal(vm.totalUsd, 70);
    assert.equal(vm.featureCount, 1);
  });

  test('unknown project key returns null', () => {
    const db = makeDb();
    const vm = buildProjectDetail(db, { projectKey: 'repo:nonexistent/repo', days: 7 });
    assert.equal(vm, null);
  });

  test('repo CSV needle does not partial-match a different repo', () => {
    const db = makeDb();
    const today = db.prepare(`SELECT date('now','-1 day','localtime') AS d`).get() as { d: string };
    // Two repos that share a substring — the CSV-sentinel match must
    // keep them separate.
    insertRollup(db, { date: today.d, featureKey: 'f1', featureName: 'F1', repo: 'loschenbd/archi-old', cost: 9999, sessionIds: 'a', sessions: 1 });
    insertRollup(db, { date: today.d, featureKey: 'f2', featureName: 'F2', repo: 'loschenbd/archi', cost: 50, sessionIds: 'b', sessions: 1 });

    const vm = buildProjectDetail(db, { projectKey: 'repo:loschenbd/archi', days: 7 });
    assert.ok(vm);
    assert.equal(vm.totalUsd, 50);
    assert.equal(vm.featureCount, 1);
  });
});
