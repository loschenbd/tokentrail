import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { findPrCandidateTuples } from '../src/commands/prs.js';

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function insertEvent(db: Database.Database, opts: {
  id: string; sessionId: string; timestamp: string;
  repo: string | null; branch: string | null;
}) {
  db.prepare(
    `INSERT INTO usage_events
       (id, session_id, timestamp, repo, branch, model, estimated_cost_usd)
     VALUES (?, ?, ?, ?, ?, 'opus', 0)`
  ).run(opts.id, opts.sessionId, opts.timestamp, opts.repo, opts.branch);
}

function insertCommit(db: Database.Database, opts: {
  sessionId: string; sha: string; repo: string | null;
  branch: string | null; authoredAt?: string;
}) {
  db.prepare(
    `INSERT INTO session_commits
       (session_id, commit_sha, subject, repo, branch, authored_at)
     VALUES (?, ?, 'subj', ?, ?, ?)`
  ).run(
    opts.sessionId,
    opts.sha,
    opts.repo,
    opts.branch,
    opts.authoredAt ?? '2026-06-15T10:00:00Z'
  );
}

function insertPr(db: Database.Database, opts: {
  sessionId: string; repo: string; prNumber: number; headBranch: string; merged?: boolean;
}) {
  db.prepare(
    `INSERT INTO session_prs
       (session_id, repo, pr_number, pr_title, pr_url, pr_state, head_branch, merged_at)
     VALUES (?, ?, ?, 't', 'u', ?, ?, ?)`
  ).run(
    opts.sessionId, opts.repo, opts.prNumber,
    opts.merged ? 'merged' : 'open',
    opts.headBranch,
    opts.merged ? '2026-06-16T00:00:00Z' : null,
  );
}

describe('findPrCandidateTuples', () => {
  test('returns empty when no events and no commits', () => {
    const db = makeDb();
    assert.deepEqual(findPrCandidateTuples(db), []);
  });

  test('derives tuple from usage_events.branch when session_commits.branch is empty', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-15T10:00:00Z', repo: 'o/r', branch: 'feat/x' });
    insertCommit(db, { sessionId: 's1', sha: 'aaa', repo: 'o/r', branch: '' });
    const tuples = findPrCandidateTuples(db);
    assert.equal(tuples.length, 1);
    assert.deepEqual(tuples[0], { sessionId: 's1', repo: 'o/r', branch: 'feat/x' });
  });

  test('filters mainline branches in usage_events', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-15T10:00:00Z', repo: 'o/r', branch: 'master' });
    insertEvent(db, { id: 'e2', sessionId: 's1', timestamp: '2026-06-15T10:00:00Z', repo: 'o/r', branch: 'main' });
    insertEvent(db, { id: 'e3', sessionId: 's1', timestamp: '2026-06-15T10:00:00Z', repo: 'o/r', branch: 'develop' });
    insertEvent(db, { id: 'e4', sessionId: 's1', timestamp: '2026-06-15T10:00:00Z', repo: 'o/r', branch: 'staging' });
    assert.deepEqual(findPrCandidateTuples(db), []);
  });

  test('filters local/* repos', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-15T10:00:00Z', repo: 'local/mything', branch: 'feat/x' });
    insertCommit(db, { sessionId: 's1', sha: 'aaa', repo: 'local/mything', branch: 'feat/x' });
    assert.deepEqual(findPrCandidateTuples(db), []);
  });

  test('expands git decoration in session_commits.branch', () => {
    const db = makeDb();
    insertCommit(db, {
      sessionId: 's1', sha: 'aaa', repo: 'o/r',
      branch: 'HEAD -> feat/x, origin/feat/x',
    });
    const tuples = findPrCandidateTuples(db);
    assert.equal(tuples.length, 1);
    assert.deepEqual(tuples[0], { sessionId: 's1', repo: 'o/r', branch: 'feat/x' });
  });

  test('dedupes tuples present in both sources', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-15T10:00:00Z', repo: 'o/r', branch: 'feat/x' });
    insertCommit(db, { sessionId: 's1', sha: 'aaa', repo: 'o/r', branch: 'feat/x' });
    const tuples = findPrCandidateTuples(db);
    assert.equal(tuples.length, 1);
    assert.deepEqual(tuples[0], { sessionId: 's1', repo: 'o/r', branch: 'feat/x' });
  });

  test('returns both branches when usage_events and session_commits differ', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-15T10:00:00Z', repo: 'o/r', branch: 'feat/checked-out' });
    insertCommit(db, { sessionId: 's1', sha: 'aaa', repo: 'o/r', branch: 'feat/merged-in' });
    const tuples = findPrCandidateTuples(db).sort((a, b) => a.branch.localeCompare(b.branch));
    assert.deepEqual(tuples, [
      { sessionId: 's1', repo: 'o/r', branch: 'feat/checked-out' },
      { sessionId: 's1', repo: 'o/r', branch: 'feat/merged-in' },
    ]);
  });

  test('re-scans sessions with an open PR (to catch a later merge), skips settled merged ones unless force', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-15T10:00:00Z', repo: 'o/r', branch: 'feat/open' });
    insertEvent(db, { id: 'e2', sessionId: 's2', timestamp: '2026-06-15T10:00:00Z', repo: 'o/r', branch: 'feat/merged' });
    insertPr(db, { sessionId: 's1', repo: 'o/r', prNumber: 1, headBranch: 'feat/open' });                // still open
    insertPr(db, { sessionId: 's2', repo: 'o/r', prNumber: 2, headBranch: 'feat/merged', merged: true }); // settled
    // s1's PR could still merge later, so it stays a candidate; s2 is done → skipped.
    assert.deepEqual(findPrCandidateTuples(db), [{ sessionId: 's1', repo: 'o/r', branch: 'feat/open' }]);
    // force re-scans everything, merged or not.
    assert.equal(findPrCandidateTuples(db, { force: true }).length, 2);
  });

  test('multiple non-mainline branches in one session produce multiple tuples', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-15T10:00:00Z', repo: 'o/r', branch: 'feat/a' });
    insertEvent(db, { id: 'e2', sessionId: 's1', timestamp: '2026-06-15T11:00:00Z', repo: 'o/r', branch: 'feat/b' });
    const tuples = findPrCandidateTuples(db).sort((a, b) => a.branch.localeCompare(b.branch));
    assert.deepEqual(tuples, [
      { sessionId: 's1', repo: 'o/r', branch: 'feat/a' },
      { sessionId: 's1', repo: 'o/r', branch: 'feat/b' },
    ]);
  });
});
