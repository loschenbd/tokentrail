import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildBranchGraph } from '../src/dashboard/data/branches.js';

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function insertEvent(db: Database.Database, opts: {
  id: string; sessionId: string; timestamp: string;
  repo: string | null; branch: string | null; cost?: number;
}) {
  db.prepare(
    `INSERT INTO usage_events
       (id, session_id, timestamp, repo, branch, model, estimated_cost_usd)
     VALUES (?, ?, ?, ?, ?, 'opus', ?)`
  ).run(opts.id, opts.sessionId, opts.timestamp, opts.repo, opts.branch, opts.cost ?? 0);
}

describe('buildBranchGraph — skeleton', () => {
  test('returns null when no events for the project at all', () => {
    const db = makeDb();
    const r = buildBranchGraph(db, { projectKey: 'repo:owner/empty', days: 30 });
    assert.equal(r, null);
  });

  test('returns null when only mainline branches exist (no feature branches)', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'master', cost: 5 });
    insertEvent(db, { id: 'e2', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'main', cost: 3 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 });
    assert.equal(r, null);
  });

  test('lifecycle reflects MIN and MAX timestamps for each non-mainline branch', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-10T10:00:00Z', repo: 'o/r', branch: 'feat/x', cost: 5 });
    insertEvent(db, { id: 'e2', sessionId: 's1', timestamp: '2026-06-14T11:00:00Z', repo: 'o/r', branch: 'feat/x', cost: 3 });
    insertEvent(db, { id: 'e3', sessionId: 's1', timestamp: '2026-06-12T08:00:00Z', repo: 'o/r', branch: 'feat/x', cost: 2 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.branches.length, 1);
    const b = r.branches[0]!;
    assert.equal(b.branch, 'feat/x');
    assert.equal(b.firstEventAt, '2026-06-10T10:00:00Z');
    assert.equal(b.lastEventAt, '2026-06-14T11:00:00Z');
  });

  test('mainline trunk detected — picks the branch with most events among master/main/trunk', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'main', cost: 1 });
    insertEvent(db, { id: 'e2', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'main', cost: 1 });
    insertEvent(db, { id: 'e3', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'master', cost: 1 });
    insertEvent(db, { id: 'e4', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 1 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.trunk, 'main');  // 2 events on main vs 1 on master
  });

  test('branches sorted by firstEventAt ascending', () => {
    const db = makeDb();
    insertEvent(db, { id: 'a', sessionId: 's1', timestamp: '2026-06-15T00:00:00Z', repo: 'o/r', branch: 'feat/b', cost: 1 });
    insertEvent(db, { id: 'b', sessionId: 's2', timestamp: '2026-06-10T00:00:00Z', repo: 'o/r', branch: 'feat/a', cost: 1 });
    insertEvent(db, { id: 'c', sessionId: 's3', timestamp: '2026-06-12T00:00:00Z', repo: 'o/r', branch: 'feat/c', cost: 1 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.deepEqual(r.branches.map((b) => b.branch), ['feat/a', 'feat/c', 'feat/b']);
  });
});

function nowIso(): string {
  return new Date().toISOString();
}

function insertPr(db: Database.Database, opts: {
  sessionId: string; repo: string; prNumber: number;
  headBranch: string; state?: string; mergedAt?: string | null;
  url?: string | null; title?: string | null;
}) {
  db.prepare(
    `INSERT INTO session_prs
       (session_id, repo, pr_number, pr_title, pr_url, pr_state, head_branch, merged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.sessionId, opts.repo, opts.prNumber,
    opts.title ?? null,
    opts.url ?? `https://github.com/${opts.repo}/pull/${opts.prNumber}`,
    opts.state ?? 'merged',
    opts.headBranch,
    opts.mergedAt ?? null,
  );
}

describe('buildBranchGraph — PR matching', () => {
  test('merged PR populates mergedAt, prNumber, prUrl, status=merged', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-10T10:00:00Z', repo: 'o/r', branch: 'feat/x', cost: 5 });
    insertPr(db, { sessionId: 's1', repo: 'o/r', prNumber: 42, headBranch: 'feat/x', state: 'merged', mergedAt: '2026-06-14T12:00:00Z' });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    const b = r.branches.find((x) => x.branch === 'feat/x')!;
    assert.equal(b.status, 'merged');
    assert.equal(b.mergedAt, '2026-06-14T12:00:00Z');
    assert.equal(b.prNumber, 42);
    assert.equal(b.prUrl, 'https://github.com/o/r/pull/42');
  });

  test('PR with origin/ prefix on head_branch matches a usage_event branch without the prefix', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-10T10:00:00Z', repo: 'o/r', branch: 'feat/y', cost: 5 });
    insertPr(db, { sessionId: 's1', repo: 'o/r', prNumber: 7, headBranch: 'origin/feat/y', state: 'merged', mergedAt: '2026-06-14T00:00:00Z' });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    const b = r.branches.find((x) => x.branch === 'feat/y')!;
    assert.equal(b.status, 'merged');
    assert.equal(b.mergedAt, '2026-06-14T00:00:00Z');
  });

  test('open PR (pr_state != merged) does NOT set mergedAt', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-10T10:00:00Z', repo: 'o/r', branch: 'feat/z', cost: 5 });
    insertPr(db, { sessionId: 's1', repo: 'o/r', prNumber: 9, headBranch: 'feat/z', state: 'open', mergedAt: null });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    const b = r.branches.find((x) => x.branch === 'feat/z')!;
    assert.equal(b.mergedAt, null);
    assert.notEqual(b.status, 'merged');
    // prNumber/prUrl still populated — useful for the click-through.
    assert.equal(b.prNumber, 9);
  });
});

function insertRollup(db: Database.Database, opts: {
  date: string; featureKey: string; repo: string | null;
  branches: string;
  cost?: number; sessions?: number; sessionIds?: string;
}) {
  db.prepare(
    `INSERT INTO feature_rollups
       (id, date, feature_key, feature_name, repo, branches,
        total_input_tokens, total_output_tokens, total_cost_usd,
        sessions_count, session_ids)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
  ).run(
    `${opts.date}::${opts.featureKey}`,
    opts.date, opts.featureKey, opts.featureKey, opts.repo,
    opts.branches, opts.cost ?? 1, opts.sessions ?? 1, opts.sessionIds ?? 's1',
  );
}

describe('buildBranchGraph — featureKey lookup', () => {
  test('featureKey populated when feature_rollups.branches contains the branch', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 5 });
    insertRollup(db, {
      date: todayLocal(db), featureKey: 'feat-x', repo: 'o/r',
      branches: 'feat/x,origin/feat/x',
    });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.branches[0]!.featureKey, 'feat-x');
  });

  test('featureKey is null when no feature_rollups row contains the branch', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/orphan', cost: 5 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.branches[0]!.featureKey, null);
  });

  test('substring match on branches CSV does not produce false positives (comma sentinels)', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 5 });
    insertRollup(db, {
      date: todayLocal(db), featureKey: 'feat-xy', repo: 'o/r',
      branches: 'feat/xy-but-not-feat/x',
    });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.branches[0]!.featureKey, null);
  });
});

function todayLocal(db: Database.Database): string {
  return (db.prepare(`SELECT date('now', 'localtime') AS d`).get() as { d: string }).d;
}

describe('buildBranchGraph — status, cost, session count', () => {
  test('open status when no merge and lastEvent is within 7 days', () => {
    const db = makeDb();
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: twoDaysAgo, repo: 'o/r', branch: 'feat/recent', cost: 5 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.branches[0]!.status, 'open');
  });

  test('stale status when no merge and lastEvent is older than 7 days', () => {
    const db = makeDb();
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: tenDaysAgo, repo: 'o/r', branch: 'feat/old', cost: 5 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.branches[0]!.status, 'stale');
  });

  test('totalUsd sums all events on the branch', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 5.50 });
    insertEvent(db, { id: 'e2', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 3.25 });
    insertEvent(db, { id: 'e3', sessionId: 's2', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 1.00 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.branches[0]!.totalUsd, 9.75);
  });

  test('sessionCount is distinct count of session_ids on the branch', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 1 });
    insertEvent(db, { id: 'e2', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 1 });
    insertEvent(db, { id: 'e3', sessionId: 's2', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 1 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.branches[0]!.sessionCount, 2);
  });

  test('totalUsd at the graph level sums all non-trunk branches', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/a', cost: 10 });
    insertEvent(db, { id: 'e2', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/b', cost: 7 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.totalUsd, 17);
    assert.equal(r.totalBranches, 2);
  });

  test('window filter excludes events older than days window', () => {
    const db = makeDb();
    const oldTimestamp = new Date(Date.now() - 60 * 86400000).toISOString();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: oldTimestamp, repo: 'o/r', branch: 'feat/ancient', cost: 5 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 });
    assert.equal(r, null);
  });
});
