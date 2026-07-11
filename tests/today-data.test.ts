import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildTodayVM } from '../src/dashboard/data/today.js';
import { buildOverview } from '../src/dashboard/data/overview.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

function makeDb(): DatabaseType.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

let eventSeq = 0;
/** ISO-UTC timestamp for local-today at local hour h (sqlite 'localtime' converts back). */
function todayAtLocalHour(h: number): string {
  const d = new Date();
  d.setHours(h, 30, 0, 0);
  return d.toISOString();
}
function daysAgoAtLocalHour(n: number, h: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, 30, 0, 0);
  return d.toISOString();
}
function seedEvent(
  db: DatabaseType.Database,
  { ts, usd, sessionId = 's1', projectDir = '/Users/b/Projects/demo', repo = null }: { ts: string; usd: number; sessionId?: string; projectDir?: string; repo?: string | null },
): void {
  db.prepare(
    `INSERT INTO usage_events (id, session_id, timestamp, model, estimated_cost_usd, repo)
     VALUES (?, ?, ?, 'claude-fable-5', ?, ?)`
  ).run(`e${++eventSeq}`, sessionId, ts, usd, repo);
  // Ensure session has project_dir so bucketing produces a project
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, project_dir)
     VALUES (?, ?)`
  ).run(sessionId, projectDir);
}

function seedSession(
  db: DatabaseType.Database,
  { id, title = null, projectDir = null }: { id: string; title?: string | null; projectDir?: string | null }
): void {
  db.prepare(`INSERT INTO sessions (session_id, title, project_dir) VALUES (?, ?, ?)`).run(id, title, projectDir);
}

describe('buildTodayVM hourly + pace', () => {
  test('hourly is 24 zero-filled buckets summing todays events', () => {
    const db = makeDb();
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 3 });
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 2 });
    seedEvent(db, { ts: todayAtLocalHour(14), usd: 4 });
    const vm = buildTodayVM(db, { nowHour: 15 });
    assert.equal(vm.hourly.length, 24);
    assert.equal(vm.hourly[9]!.usd, 5);
    assert.equal(vm.hourly[14]!.usd, 4);
    assert.equal(vm.hourly[0]!.usd, 0);
    assert.equal(vm.hourly[9]!.hour, 9);
  });

  test('pace is null with fewer than 7 days of history', () => {
    const db = makeDb();
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 5 });
    for (let n = 1; n <= 3; n++) seedEvent(db, { ts: daysAgoAtLocalHour(n, 9), usd: 10 });
    const vm = buildTodayVM(db, { nowHour: 10 });
    assert.equal(vm.paceUsd, null);
  });

  test('pace divides today by the historical share spent by nowHour', () => {
    const db = makeDb();
    // 8 history days: each day $10 at 09:xx and $10 at 18:xx → by hour 9 the
    // historical share is 50%, so today's $5 paces to $10.
    for (let n = 1; n <= 8; n++) {
      seedEvent(db, { ts: daysAgoAtLocalHour(n, 9), usd: 10 });
      seedEvent(db, { ts: daysAgoAtLocalHour(n, 18), usd: 10 });
    }
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 5 });
    // Seed rollups for today so todayUsd is populated
    const day = (n: number) => {
      const d = new Date();
      d.setDate(d.getDate() - n);
      return d.toLocaleDateString('sv-SE');
    };
    db.prepare(
      `INSERT INTO feature_rollups (id, date, feature_key, feature_name, total_cost_usd, sessions_count)
       VALUES (?, ?, 'f', 'F', ?, 1)`
    ).run('r-today', day(0), 5);
    const vm = buildTodayVM(db, { nowHour: 9 });
    assert.equal(vm.paceUsd, 10);
  });

  test('usualDayUsd averages the last 30 days of rollups', () => {
    const db = makeDb();
    const ins = db.prepare(
      `INSERT INTO feature_rollups (id, date, feature_key, feature_name, total_cost_usd, sessions_count)
       VALUES (?, ?, 'f', 'F', ?, 1)`
    );
    const day = (n: number) => {
      const d = new Date();
      d.setDate(d.getDate() - n);
      return d.toLocaleDateString('sv-SE'); // YYYY-MM-DD, local
    };
    ins.run(`r1`, day(1), 20);
    ins.run(`r2`, day(2), 30);
    const vm = buildTodayVM(db, { nowHour: 12 });
    assert.equal(vm.usualDayUsd, 25);
  });

  test('project colors match the 30-day overview palette', () => {
    const db = makeDb();
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 5 });
    // Seed rollup for today so topProjects is populated
    const day = (n: number) => {
      const d = new Date();
      d.setDate(d.getDate() - n);
      return d.toLocaleDateString('sv-SE');
    };
    db.prepare(
      `INSERT INTO feature_rollups (id, date, feature_key, feature_name, total_cost_usd, sessions_count)
       VALUES (?, ?, 'f', 'F', ?, 1)`
    ).run('r-today', day(0), 5);
    const vm = buildTodayVM(db, { nowHour: 10 });
    const ref = buildOverview({ db, days: 30 }).projectColors;
    assert.ok(vm.topProjects.length > 0, 'fixture must produce at least one project');
    for (const p of vm.topProjects) {
      assert.equal(p.color, ref[p.key]);
    }
  });
});

describe('buildTodayVM sessions', () => {
  test('aggregates per-session cost, time range, chronological order', () => {
    const db = makeDb();
    seedSession(db, { id: 'a', title: 'deep research', projectDir: '/Users/b/Research' });
    seedSession(db, { id: 'b', title: 'cover letter', projectDir: '/Users/b/Projects/job-search' });
    seedEvent(db, { ts: todayAtLocalHour(10), usd: 2, sessionId: 'b' });
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 3, sessionId: 'a' });
    seedEvent(db, { ts: todayAtLocalHour(11), usd: 4, sessionId: 'a' });
    const vm = buildTodayVM(db, { nowHour: 12 });
    assert.equal(vm.sessions.length, 2);
    assert.equal(vm.sessionsToday, 2);
    assert.equal(vm.sessions[0]!.sessionId, 'a'); // earliest first event first
    assert.equal(vm.sessions[0]!.usd, 7);
    assert.equal(vm.sessions[0]!.projectName, 'Research');
    assert.match(vm.sessions[0]!.startedAt, /^09:\d\d$/);
    assert.match(vm.sessions[0]!.endedAt, /^11:\d\d$/);
  });

  test('title falls back: title → feature name → project dir basename → Untitled', () => {
    const db = makeDb();
    seedSession(db, { id: 'x', title: null, projectDir: null });
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 1, sessionId: 'x' });
    const vm = buildTodayVM(db, { nowHour: 10 });
    assert.equal(vm.sessions[0]!.title, 'Untitled session');
  });

  test('sessions with no events today are excluded', () => {
    const db = makeDb();
    seedSession(db, { id: 'old' });
    seedEvent(db, { ts: daysAgoAtLocalHour(2, 9), usd: 9, sessionId: 'old' });
    const vm = buildTodayVM(db, { nowHour: 10 });
    assert.equal(vm.sessions.length, 0);
  });
});

describe('buildTodayVM shipped', () => {
  function seedCommit(db: DatabaseType.Database, sessionId: string, sha: string, subject: string, at: string) {
    db.prepare(
      `INSERT INTO session_commits (session_id, commit_sha, subject, authored_at) VALUES (?, ?, ?, ?)`
    ).run(sessionId, sha, subject, at);
  }
  function seedPr(
    db: DatabaseType.Database, sessionId: string, n: number,
    { state = 'open', mergedAt = null }: { state?: string; mergedAt?: string | null } = {}
  ) {
    db.prepare(
      `INSERT INTO session_prs (session_id, repo, pr_number, pr_title, pr_state, merged_at)
       VALUES (?, 'o/r', ?, ?, ?, ?)`
    ).run(sessionId, n, `PR ${n}`, state, mergedAt);
  }

  test('counts today-authored commits and today-merged or open PRs on today-active sessions', () => {
    const db = makeDb();
    seedSession(db, { id: 's1' });
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 1, sessionId: 's1' });
    seedCommit(db, 's1', 'sha1', 'fix: today page', todayAtLocalHour(10));
    seedCommit(db, 's1', 'sha2', 'old work', daysAgoAtLocalHour(3, 10)); // resumed-session rider: excluded
    seedPr(db, 's1', 12, { state: 'merged', mergedAt: todayAtLocalHour(11) });
    seedPr(db, 's1', 13, { state: 'open' });
    const vm = buildTodayVM(db, { nowHour: 12 });
    assert.equal(vm.shipped.commitCount, 1);
    assert.equal(vm.shipped.prCount, 2);
    assert.equal(vm.shipped.items[0]!.kind, 'pr');
    assert.ok(vm.shipped.items.some((i) => i.title === 'fix: today page'));
  });

  test('same commit attached to two sessions counts once', () => {
    const db = makeDb();
    seedSession(db, { id: 's1' });
    seedSession(db, { id: 's2' });
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 1, sessionId: 's1' });
    seedEvent(db, { ts: todayAtLocalHour(10), usd: 1, sessionId: 's2' });
    seedCommit(db, 's1', 'shaX', 'shared commit', todayAtLocalHour(9));
    seedCommit(db, 's2', 'shaX', 'shared commit', todayAtLocalHour(9));
    const vm = buildTodayVM(db, { nowHour: 12 });
    assert.equal(vm.shipped.commitCount, 1);
  });

  test('empty when nothing shipped', () => {
    const db = makeDb();
    seedSession(db, { id: 's1' });
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 1, sessionId: 's1' });
    const vm = buildTodayVM(db, { nowHour: 10 });
    assert.equal(vm.shipped.prCount, 0);
    assert.equal(vm.shipped.commitCount, 0);
    assert.equal(vm.shipped.items.length, 0);
  });
});

describe('buildTodayVM hourly project breakdown', () => {
  test('per-hour projects sum to the hour total, sorted desc', () => {
    const db = makeDb();
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 1, repo: 'ben/alpha' });
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 4, repo: 'ben/beta' });
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 2, repo: 'ben/beta' });
    const vm = buildTodayVM(db, { nowHour: 10 });
    const h9 = vm.hourly[9]!;
    assert.equal(h9.usd, 7);
    assert.equal(h9.projects.length, 2);
    assert.equal(h9.projects[0]!.name, 'beta');   // $6 first
    assert.equal(h9.projects[0]!.usd, 6);
    assert.equal(h9.projects[1]!.name, 'alpha');
    const rowSum = h9.projects.reduce((s, p) => s + p.usd, 0);
    assert.equal(Math.round(rowSum * 100) / 100, h9.usd);
    assert.ok(h9.projects.every((p) => /^#|^rgb/.test(p.color)));
  });

  test('zero-spend hours have empty projects arrays', () => {
    const db = makeDb();
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 1 });
    const vm = buildTodayVM(db, { nowHour: 10 });
    assert.deepEqual(vm.hourly[3]!.projects, []);
  });

  test('projectFeatureMix is passed through and keyed by topProjects keys', () => {
    const db = makeDb();
    seedEvent(db, { ts: todayAtLocalHour(9), usd: 5 });
    // topProjects derive from feature_rollups — seed one row for today
    // (match the existing color-palette test's fixture pattern in this file).
    db.prepare(
      `INSERT INTO feature_rollups (date, feature_key, feature_name, total_cost_usd, sessions_count)
       VALUES (date('now','localtime'), 'f', 'F', 5, 1)`
    ).run();
    const vm = buildTodayVM(db, { nowHour: 10 });
    assert.ok(Array.isArray(vm.projectFeatureMix));
    const mixKeys = new Set(vm.projectFeatureMix.map((m) => m.projectKey));
    for (const p of vm.topProjects) assert.ok(mixKeys.has(p.key), `mix missing ${p.key}`);
  });
});
