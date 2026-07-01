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

  test('avgUsdPerDay equals totalUsd / days', () => {
    const db = makeDb();
    const today = db.prepare(`SELECT date('now','-1 day','localtime') AS d`).get() as { d: string };
    insertRollup(db, { date: today.d, featureKey: 'archi-a', featureName: 'A', repo: 'loschenbd/archi', cost: 70, sessionIds: 'sess-a', sessions: 1 });
    const vm = buildProjectDetail(db, { projectKey: 'repo:loschenbd/archi', days: 7 })!;
    assert.equal(vm.avgUsdPerDay, 10);
  });

  test('weekStats totals + deltas over a 30d window with three explicit weeks', () => {
    const db = makeDb();
    const day = (n: number) => (db.prepare(`SELECT date('now','-${n} days','localtime') AS d`).get() as { d: string }).d;
    // This week (days 0..6): $200 across two days
    insertRollup(db, { date: day(0), featureKey: 'f1', featureName: 'F1', repo: 'loschenbd/archi', cost: 120, sessionIds: 'sA', sessions: 1 });
    insertRollup(db, { date: day(3), featureKey: 'f1', featureName: 'F1', repo: 'loschenbd/archi', cost: 80, sessionIds: 'sB', sessions: 1 });
    // Last week (days 7..13): $100
    insertRollup(db, { date: day(10), featureKey: 'f1', featureName: 'F1', repo: 'loschenbd/archi', cost: 100, sessionIds: 'sC', sessions: 1 });
    // Prior week (days 14..20): $50
    insertRollup(db, { date: day(17), featureKey: 'f1', featureName: 'F1', repo: 'loschenbd/archi', cost: 50, sessionIds: 'sD', sessions: 1 });

    const vm = buildProjectDetail(db, { projectKey: 'repo:loschenbd/archi', days: 30 })!;
    assert.equal(vm.weekStats.thisWeekUsd, 200);
    assert.equal(vm.weekStats.lastWeekUsd, 100);
    assert.equal(vm.weekStats.priorWeekUsd, 50);
    assert.equal(vm.weekStats.thisVsLastPct, 100);   // (200-100)/100
    assert.equal(vm.weekStats.lastVsPriorPct, 100);  // (100-50)/50
  });

  test('weekStats deltas handle a zero denominator', () => {
    const db = makeDb();
    const day = (n: number) => (db.prepare(`SELECT date('now','-${n} days','localtime') AS d`).get() as { d: string }).d;
    insertRollup(db, { date: day(0), featureKey: 'f', featureName: 'F', repo: 'loschenbd/archi', cost: 40, sessionIds: 's', sessions: 1 });
    const vm = buildProjectDetail(db, { projectKey: 'repo:loschenbd/archi', days: 30 })!;
    // Only this week has spend; lastWeek = priorWeek = 0
    assert.equal(vm.weekStats.thisWeekUsd, 40);
    assert.equal(vm.weekStats.lastWeekUsd, 0);
    assert.equal(vm.weekStats.priorWeekUsd, 0);
    assert.equal(vm.weekStats.thisVsLastPct, 100);   // 0 denom + nonzero num → 100
    assert.equal(vm.weekStats.lastVsPriorPct, 0);    // 0 denom + zero num → 0
  });

  test('peakDay is the highest-spend day with the top feature that day', () => {
    const db = makeDb();
    const day = (n: number) => (db.prepare(`SELECT date('now','-${n} days','localtime') AS d`).get() as { d: string }).d;
    insertRollup(db, { date: day(1), featureKey: 'small', featureName: 'Small feat', repo: 'loschenbd/archi', cost: 10, sessionIds: 'sA', sessions: 1 });
    insertRollup(db, { date: day(2), featureKey: 'big',   featureName: 'Big feat',   repo: 'loschenbd/archi', cost: 300, sessionIds: 'sB', sessions: 1 });
    insertRollup(db, { date: day(2), featureKey: 'tiny',  featureName: 'Tiny feat',  repo: 'loschenbd/archi', cost: 5,   sessionIds: 'sC', sessions: 1 });
    const vm = buildProjectDetail(db, { projectKey: 'repo:loschenbd/archi', days: 7 })!;
    assert.ok(vm.peakDay);
    assert.equal(vm.peakDay!.date, day(2));
    assert.equal(vm.peakDay!.totalUsd, 305);
    assert.equal(vm.peakDay!.featureKey, 'big');
    assert.equal(vm.peakDay!.featureName, 'Big feat');
  });

  test('peakDay is null when the project has no spend in-window', () => {
    // buildProjectDetail returns null for a zero-spend project; verify
    // that when there IS at least one rollup but it landed outside the
    // window, the resulting VM is null (existing contract) rather than
    // returning a broken peakDay.
    const db = makeDb();
    const day30 = (db.prepare(`SELECT date('now','-40 days','localtime') AS d`).get() as { d: string }).d;
    insertRollup(db, { date: day30, featureKey: 'old', featureName: 'Old', repo: 'loschenbd/archi', cost: 10, sessionIds: 'sX', sessions: 1 });
    const vm = buildProjectDetail(db, { projectKey: 'repo:loschenbd/archi', days: 30 });
    assert.equal(vm, null);
  });
});
