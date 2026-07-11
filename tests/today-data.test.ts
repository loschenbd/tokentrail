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
  { ts, usd, sessionId = 's1', projectDir = '/Users/b/Projects/demo' }: { ts: string; usd: number; sessionId?: string; projectDir?: string },
): void {
  db.prepare(
    `INSERT INTO usage_events (id, session_id, timestamp, model, estimated_cost_usd)
     VALUES (?, ?, ?, 'claude-fable-5', ?)`
  ).run(`e${++eventSeq}`, sessionId, ts, usd);
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
