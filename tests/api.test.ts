import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildToday, type TodayResponse } from '../src/dashboard/data/api.js';
import { buildServer } from '../src/dashboard/server.js';
import { closeDb } from '../src/db/db.js';

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

function insertAnomaly(db: Database.Database, opts: { date: string; dismissed: boolean; featureKey?: string; amount?: number }) {
  // Vary feature_key so the (kind, date, feature_key, session_id) dedupe
  // index in src/db/schema.ts doesn't reject the 2nd/3rd insert.
  db.prepare(
    `INSERT INTO anomalies (kind, date, feature_key, session_id, amount, baseline, multiplier, reason, dismissed_at)
     VALUES ('feature_spike', ?, ?, NULL, ?, 1, 10, '10x baseline', ?)`
  ).run(opts.date, opts.featureKey ?? 'feat-x', opts.amount ?? 10, opts.dismissed ? "2026-06-16T00:00:00Z" : null);
}

describe('buildToday', () => {
  test('groups features under their projects, sorted by project total desc', () => {
    const db = makeDb();
    const today = (db.prepare(`SELECT date('now','localtime') AS d`).get() as { d: string }).d;

    // Two features in repo "loschenbd/alpha" (project total $1.90)
    insertRollup(db, { date: today, featureKey: 'alpha-a', featureName: 'Alpha A', repo: 'loschenbd/alpha', cost: 1.10, sessionIds: 'sA', sessions: 1 });
    insertRollup(db, { date: today, featureKey: 'alpha-b', featureName: 'Alpha B', repo: 'loschenbd/alpha', cost: 0.80, sessionIds: 'sB', sessions: 1 });
    // One feature in repo "loschenbd/beta" (project total $0.50)
    insertRollup(db, { date: today, featureKey: 'beta-a', featureName: 'Beta A', repo: 'loschenbd/beta', cost: 0.50, sessionIds: 'sC', sessions: 1 });

    insertAnomaly(db, { date: today, dismissed: false, featureKey: 'feat-anom-1' });
    insertAnomaly(db, { date: today, dismissed: true, featureKey: 'feat-anom-2' });   // dismissed → not counted

    const r = buildToday(db);

    assert.equal(r.todayUsd, 2.40);
    assert.equal(r.topProjects.length, 2);

    const alpha = r.topProjects[0]!;
    assert.equal(alpha.name, 'alpha');
    assert.equal(alpha.usd, 1.90);
    assert.equal(alpha.href, 'http://127.0.0.1:4920/project/repo%3Aloschenbd%2Falpha');
    assert.equal(alpha.features.length, 2);
    assert.equal(alpha.features[0]!.key, 'alpha-a');
    assert.equal(alpha.features[0]!.name, 'Alpha A');
    assert.equal(alpha.features[0]!.usd, 1.10);
    assert.equal(alpha.features[0]!.href, 'http://127.0.0.1:4920/feature/alpha-a');

    const beta = r.topProjects[1]!;
    assert.equal(beta.name, 'beta');
    assert.equal(beta.usd, 0.50);
    assert.equal(beta.features.length, 1);

    assert.equal(r.anomalyCount, 1);
    // No usage_events inserted, so lastEventAt is null.
    assert.equal(r.lastEventAt, null);
  });

  test('handles empty day: zero totals, empty array, zero anomalies', () => {
    const db = makeDb();
    const r = buildToday(db);

    assert.equal(r.todayUsd, 0);
    assert.equal(r.topProjects.length, 0);
    assert.equal(r.anomalyCount, 0);
  });

  test('caps at 3 projects and 5 features per project', () => {
    const db = makeDb();
    const today = (db.prepare(`SELECT date('now','localtime') AS d`).get() as { d: string }).d;

    // 4 distinct projects (one feature each) — only top 3 should appear.
    for (let i = 0; i < 4; i++) {
      insertRollup(db, { date: today, featureKey: `proj${i}-only`, featureName: `Proj${i} only`, repo: `loschenbd/proj${i}`, cost: 10 - i, sessionIds: `s${i}`, sessions: 1 });
    }
    // 6 features in a single project — only top 5 should appear nested.
    for (let i = 0; i < 6; i++) {
      insertRollup(db, { date: today, featureKey: `big-${i}`, featureName: `Big ${i}`, repo: 'loschenbd/big', cost: 100 + i, sessionIds: `b${i}`, sessions: 1 });
    }

    const r = buildToday(db);

    assert.equal(r.topProjects.length, 3);
    const big = r.topProjects[0]!;
    assert.equal(big.name, 'big');
    assert.equal(big.features.length, 5);
    // Highest-cost feature should sort first.
    assert.equal(big.features[0]!.key, 'big-5');
  });

  test('URL-encodes project and feature keys with slashes or unusual characters', () => {
    const db = makeDb();
    const today = (db.prepare(`SELECT date('now','localtime') AS d`).get() as { d: string }).d;
    // No repo → bucketProject uses `feature:<key>` as the project key.
    insertRollup(db, { date: today, featureKey: 'has/slash:colon', featureName: 'Has slash', repo: null, cost: 1, sessionIds: 's', sessions: 1 });

    const r = buildToday(db);

    assert.equal(r.topProjects[0]!.href, 'http://127.0.0.1:4920/project/feature%3Ahas%2Fslash%3Acolon');
    assert.equal(r.topProjects[0]!.features[0]!.href, 'http://127.0.0.1:4920/feature/has%2Fslash%3Acolon');
  });

  test('lastEventAt returns the most recent usage_events.timestamp', () => {
    const db = makeDb();
    const insertEvent = (id: string, ts: string) => db
      .prepare(`INSERT INTO usage_events (id, session_id, timestamp, model, estimated_cost_usd) VALUES (?, 's', ?, 'opus', 0)`)
      .run(id, ts);
    insertEvent('e1', '2026-06-15T10:00:00Z');
    insertEvent('e2', '2026-06-17T08:30:00Z');
    insertEvent('e3', '2026-06-16T22:00:00Z');

    const r = buildToday(db);
    assert.equal(r.lastEventAt, '2026-06-17T08:30:00Z');
  });
});

describe('GET /api/today', () => {
  test('returns 200 with JSON content-type and TodayResponse shape', async () => {
    // Isolate from the dev DB at data/tracker.db — getDb() reads TRACKER_DB_PATH
    // on first call, so set it before buildServer() touches the singleton.
    const originalPath = process.env.TRACKER_DB_PATH;
    const tmpDir = mkdtempSync(join(tmpdir(), 'tokentrail-api-test-'));
    process.env.TRACKER_DB_PATH = join(tmpDir, 'test.db');

    const app = buildServer({ defaultDays: 30 });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/today' });
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'] as string, /^application\/json/);
      const body = res.json() as TodayResponse;
      assert.equal(typeof body.todayUsd, 'number');
      assert.ok(Array.isArray(body.topProjects));
      assert.equal(typeof body.anomalyCount, 'number');
      // Empty DB — no events ingested yet, so lastEventAt is null.
      assert.equal(body.lastEventAt, null);
    } finally {
      await app.close();
      closeDb();
      if (originalPath === undefined) delete process.env.TRACKER_DB_PATH;
      else process.env.TRACKER_DB_PATH = originalPath;
    }
  });
});

describe('buildToday — menubar summary', () => {
  test('sparkline includes 14 days oldest-first with today as the last cell', () => {
    const db = makeDb();
    const offsets: Array<[number, number]> = [[-5, 5], [-2, 20], [-1, 10], [0, 7]];
    offsets.forEach(([offset, cost], i) => {
      const date = (db.prepare(`SELECT date('now', '${offset} days', 'localtime') AS d`).get() as { d: string }).d;
      insertRollup(db, { date, featureKey: `f-${i}`, featureName: `F ${i}`, repo: 'x/y', cost, sessionIds: `s-${i}`, sessions: 1 });
    });
    const res = buildToday(db);
    assert.equal(res.menubar.sparkline.length, 14);
    assert.equal(res.menubar.sparkline[13], 7);
    assert.equal(res.menubar.sparkline[12], 10);
    assert.equal(res.menubar.sparkline[10], 0);
  });

  test('last7Usd and last30Usd sum the correct windows', () => {
    const db = makeDb();
    const samples: Array<[number, number]> = [[-35, 100], [-20, 30], [-3, 5], [0, 7]];
    samples.forEach(([offset, cost], i) => {
      const date = (db.prepare(`SELECT date('now', '${offset} days', 'localtime') AS d`).get() as { d: string }).d;
      insertRollup(db, { date, featureKey: `f-${i}`, featureName: `F ${i}`, repo: 'x/y', cost, sessionIds: `s-${i}`, sessions: 1 });
    });
    const res = buildToday(db);
    assert.equal(res.menubar.last7Usd, 12);
    assert.equal(res.menubar.last30Usd, 42);
  });

  test('deltaVsYesterday is signed percent vs yesterday total', () => {
    const db = makeDb();
    const today = (db.prepare(`SELECT date('now','localtime') AS d`).get() as { d: string }).d;
    const yest = (db.prepare(`SELECT date('now','-1 days','localtime') AS d`).get() as { d: string }).d;
    insertRollup(db, { date: yest, featureKey: 'a', featureName: 'A', repo: 'x/y', cost: 10, sessionIds: 's1', sessions: 1 });
    insertRollup(db, { date: today, featureKey: 'b', featureName: 'B', repo: 'x/y', cost: 25, sessionIds: 's2', sessions: 1 });
    const res = buildToday(db);
    assert.equal(res.menubar.yesterdayUsd, 10);
    assert.equal(res.menubar.deltaVsYesterday, 150);
  });

  test('first-day case: yesterday=0, today>0 returns Infinity for delta', () => {
    const db = makeDb();
    const today = (db.prepare(`SELECT date('now','localtime') AS d`).get() as { d: string }).d;
    insertRollup(db, { date: today, featureKey: 'a', featureName: 'A', repo: 'x/y', cost: 10, sessionIds: 's1', sessions: 1 });
    const res = buildToday(db);
    assert.equal(res.menubar.yesterdayUsd, 0);
    assert.equal(res.menubar.deltaVsYesterday, Infinity);
  });

  test('empty: all menubar fields zero, sparkline is 14 zeros', () => {
    const db = makeDb();
    const res = buildToday(db);
    assert.deepEqual(res.menubar.sparkline, Array(14).fill(0));
    assert.equal(res.menubar.last7Usd, 0);
    assert.equal(res.menubar.last30Usd, 0);
    assert.equal(res.menubar.yesterdayUsd, 0);
    assert.equal(res.menubar.deltaVsYesterday, 0);
  });

  test('trend carries 30 days of per-project bands with colors and stack order', () => {
    const db = makeDb();
    const offsets: Array<[number, string, number]> = [
      [-5, 'loschenbd/alpha', 12],
      [-5, 'loschenbd/beta', 3],
      [0, 'loschenbd/alpha', 7],
    ];
    offsets.forEach(([offset, repo, cost], i) => {
      const date = (db.prepare(`SELECT date('now', '${offset} days', 'localtime') AS d`).get() as { d: string }).d;
      insertRollup(db, { date, featureKey: `f-${i}`, featureName: `F ${i}`, repo, cost, sessionIds: `s-${i}`, sessions: 1 });
    });
    const res = buildToday(db);
    const trend = res.menubar.trend;

    assert.equal(trend.days.length, 30);
    // alpha ($19) outspends beta ($3) → bottom of the stack.
    assert.equal(trend.projects.length, 2);
    const alpha = trend.projects.find((p) => p.key === 'repo:loschenbd/alpha')!;
    const beta = trend.projects.find((p) => p.key === 'repo:loschenbd/beta')!;
    assert.equal(alpha.stackPosition, 0);
    assert.equal(beta.stackPosition, 1);
    assert.equal(alpha.name, 'alpha');
    assert.match(alpha.color, /^#[0-9a-f]{6}$/i);

    const day5 = trend.days.find((d) => d.bands['repo:loschenbd/beta'] === 3)!;
    assert.equal(day5.bands['repo:loschenbd/alpha'], 12);
    const today = trend.days[trend.days.length - 1]!;
    assert.equal(today.bands['repo:loschenbd/alpha'], 7);
  });

  test('trend.others itemizes tail projects (rank 7+) behind the Other band', () => {
    const db = makeDb();
    const today = (db.prepare(`SELECT date('now','localtime') AS d`).get() as { d: string }).d;
    // 8 projects, descending spend — top 6 get bands, 2 land in the tail.
    for (let i = 0; i < 8; i++) {
      insertRollup(db, { date: today, featureKey: `p${i}-f`, featureName: `P${i} F`, repo: `loschenbd/proj${i}`, cost: 80 - i * 10, sessionIds: `s${i}`, sessions: 1 });
    }
    const trend = buildToday(db).menubar.trend;
    assert.equal(trend.projects.length, 7); // top 6 + __other__
    assert.ok(trend.projects.some((p) => p.key === '__other__'));
    assert.equal(trend.others.length, 2);
    assert.equal(trend.others[0]!.name, 'proj6');   // $20 > $10 — sorted desc
    assert.equal(trend.others[0]!.totalUsd, 20);
    assert.equal(trend.others[1]!.name, 'proj7');
    // Identity colors ride along so the menubar legend can match the
    // dashboard burn-paths swatches instead of falling back to gray.
    assert.match(trend.others[0]!.color, /^#[0-9a-f]{6}$/i);
    assert.match(trend.others[1]!.color, /^#[0-9a-f]{6}$/i);
  });

  test('trend on an empty DB: 30 zeroed days, no projects', () => {
    const db = makeDb();
    const res = buildToday(db);
    assert.equal(res.menubar.trend.days.length, 30);
    assert.equal(res.menubar.trend.projects.length, 0);
  });

  test('topAnomaly is the largest active anomaly; dismissed ones excluded', () => {
    const db = makeDb();
    const today = (db.prepare(`SELECT date('now','localtime') AS d`).get() as { d: string }).d;
    insertAnomaly(db, { date: today, dismissed: false, featureKey: 'a1', amount: 12 });
    insertAnomaly(db, { date: today, dismissed: false, featureKey: 'a2', amount: 399 });
    insertAnomaly(db, { date: today, dismissed: true, featureKey: 'a3', amount: 900 }); // dismissed → ignored
    const res = buildToday(db);
    assert.equal(res.anomalyCount, 2);
    assert.equal(res.topAnomaly!.amount, 399);
    assert.equal(res.topAnomaly!.reason, '10x baseline');
  });

  test('topAnomaly is null when nothing is active', () => {
    const db = makeDb();
    const res = buildToday(db);
    assert.equal(res.topAnomaly, null);
  });

  test('anomalies on hidden projects are excluded from count + topAnomaly (matches worth-a-look)', () => {
    const db = makeDb();
    const today = (db.prepare(`SELECT date('now','localtime') AS d`).get() as { d: string }).d;
    // A feature_rollup lets hiddenFeatureKeys() resolve the pattern → feature_key.
    insertRollup(db, { date: today, featureKey: 'outside:projects-cfa', featureName: 'CFA', repo: null, cost: 52, sessionIds: 'sCfa', sessions: 1 });
    insertAnomaly(db, { date: today, dismissed: false, featureKey: 'outside:projects-cfa', amount: 52 });
    insertAnomaly(db, { date: today, dismissed: false, featureKey: 'visible-feat', amount: 12 });

    const res = buildToday(db, { hidden: ['cfa'] });
    // Only the visible anomaly counts; the hidden one is dropped just like on
    // the dashboard's Worth a look page.
    assert.equal(res.anomalyCount, 1);
    assert.equal(res.topAnomaly!.amount, 12);
  });
});
