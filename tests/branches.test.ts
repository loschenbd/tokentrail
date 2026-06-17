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
