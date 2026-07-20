import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import {
  findMergeCandidates,
  isMergedIntoMain,
} from '../src/commands/merges.js';
import { buildBranchGraph } from '../src/dashboard/data/branches.js';

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

// buildBranchGraph's window is relative to now, so events must be dated
// relative to now — fixed calendar dates age out of the window and make these
// tests fail as time passes. Pin the time so assertions stay exact.
function daysAgo(n: number, hhmm = '10:00'): string {
  const day = new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  return `${day}T${hhmm}:00.000Z`;
}

function insertEvent(db: Database.Database, opts: {
  id: string; sessionId: string; timestamp: string;
  repo: string; branch: string;
}) {
  db.prepare(
    `INSERT INTO usage_events
       (id, session_id, timestamp, repo, branch, model, estimated_cost_usd)
     VALUES (?, ?, ?, ?, ?, 'opus', 1)`
  ).run(opts.id, opts.sessionId, opts.timestamp, opts.repo, opts.branch);
}

function insertCommit(db: Database.Database, opts: {
  sessionId: string; sha: string; repo: string;
  branch: string; authoredAt: string;
}) {
  db.prepare(
    `INSERT INTO session_commits
       (session_id, commit_sha, subject, repo, branch, authored_at)
     VALUES (?, ?, 'subj', ?, ?, ?)`
  ).run(opts.sessionId, opts.sha, opts.repo, opts.branch, opts.authoredAt);
}

function insertBranchMerge(db: Database.Database, opts: {
  repo: string; branch: string; mergedAt: string | null; sourceSha?: string;
}) {
  db.prepare(
    `INSERT INTO branch_merges (repo, branch, merged_at, source_sha)
     VALUES (?, ?, ?, ?)`
  ).run(opts.repo, opts.branch, opts.mergedAt, opts.sourceSha ?? 'sha1');
}

describe('findMergeCandidates', () => {
  test('returns nothing when no events / commits exist', () => {
    const db = makeDb();
    assert.deepEqual(findMergeCandidates(db), []);
  });

  test('returns (repo, branch) from usage_events', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-15T10:00:00Z', repo: 'o/r', branch: 'feat/x' });
    assert.deepEqual(findMergeCandidates(db), [{ repo: 'o/r', branch: 'feat/x' }]);
  });

  test('filters mainline and local/*', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-15T10:00:00Z', repo: 'o/r', branch: 'main' });
    insertEvent(db, { id: 'e2', sessionId: 's1', timestamp: '2026-06-15T10:00:00Z', repo: 'local/x', branch: 'feat/y' });
    assert.deepEqual(findMergeCandidates(db), []);
  });

  test('skips pairs already in branch_merges unless force', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-15T10:00:00Z', repo: 'o/r', branch: 'feat/x' });
    insertBranchMerge(db, { repo: 'o/r', branch: 'feat/x', mergedAt: '2026-06-15T11:00:00Z' });
    assert.deepEqual(findMergeCandidates(db), []);
    assert.deepEqual(findMergeCandidates(db, { force: true }), [{ repo: 'o/r', branch: 'feat/x' }]);
  });

  test('unions usage_events and session_commits sources', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-15T10:00:00Z', repo: 'o/r', branch: 'feat/a' });
    insertCommit(db, { sessionId: 's2', sha: 'aaa', repo: 'o/r', branch: 'feat/b', authoredAt: '2026-06-15T10:00:00Z' });
    const rows = findMergeCandidates(db).sort((a, b) => a.branch.localeCompare(b.branch));
    assert.deepEqual(rows, [
      { repo: 'o/r', branch: 'feat/a' },
      { repo: 'o/r', branch: 'feat/b' },
    ]);
  });

  test('expands git decoration in session_commits.branch to clean names', () => {
    const db = makeDb();
    insertCommit(db, {
      sessionId: 's1', sha: 'aaa', repo: 'o/r',
      branch: 'HEAD -> feat/x, origin/feat/x',
      authoredAt: '2026-06-15T10:00:00Z',
    });
    const rows = findMergeCandidates(db);
    assert.equal(rows.length, 1, 'decoration should expand to a single clean branch');
    assert.deepEqual(rows[0], { repo: 'o/r', branch: 'feat/x' });
  });

  test('drops mainline from decorated session_commits branches', () => {
    const db = makeDb();
    insertCommit(db, {
      sessionId: 's1', sha: 'aaa', repo: 'o/r',
      branch: 'HEAD -> main, origin/main',
      authoredAt: '2026-06-15T10:00:00Z',
    });
    assert.deepEqual(findMergeCandidates(db), []);
  });

  test('includes branches known only via session_prs.head_branch', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO session_prs
         (session_id, repo, pr_number, pr_title, pr_url, pr_state, head_branch, merged_at)
       VALUES (?, ?, ?, 't', 'u', 'merged', ?, ?)`
    ).run('s1', 'o/r', 1, 'origin/feat/from-pr', '2026-06-15T11:00:00Z');
    const rows = findMergeCandidates(db);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { repo: 'o/r', branch: 'feat/from-pr' });
  });
});

describe('isMergedIntoMain (with stub git runner)', () => {
  test('returns merged + ancestry ref when is-ancestor exits 0 on origin/main', () => {
    const stub = (_: string, args: string[]): number | string => {
      if (args[0] === 'merge-base' && args[3] === 'origin/main') return 0;
      if (args[0] === 'log') return '2026-06-15T11:00:00+00:00';
      return 1;
    };
    const r = isMergedIntoMain('/repo', 'abc', stub);
    assert.equal(r.merged, true);
    if (r.merged) {
      assert.equal(r.trunkRef, 'origin/main');
      assert.equal(r.mergedAt, '2026-06-15T11:00:00+00:00');
    }
  });

  test('falls through trunk refs in order; uses origin/master when origin/main missing', () => {
    const stub = (_: string, args: string[]): number | string => {
      if (args[0] === 'merge-base' && args[3] === 'origin/main') return 128;
      if (args[0] === 'merge-base' && args[3] === 'origin/master') return 0;
      if (args[0] === 'log') return '2026-06-15T11:00:00+00:00';
      return 1;
    };
    const r = isMergedIntoMain('/repo', 'abc', stub);
    assert.equal(r.merged, true);
    if (r.merged) assert.equal(r.trunkRef, 'origin/master');
  });

  test('returns not-merged when no trunk ref contains the sha', () => {
    const stub = (_: string, _args: string[]): number | string => 1;
    const r = isMergedIntoMain('/repo', 'abc', stub);
    assert.equal(r.merged, false);
  });
});

describe('branch graph reads branch_merges as merged_at fallback', () => {
  test('branch with branch_merges row but no session_prs row is classified merged', () => {
    const db = makeDb();
    const mergedAt = daysAgo(11, '11:00');
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: daysAgo(15), repo: 'o/r', branch: 'feat/x' });
    insertBranchMerge(db, { repo: 'o/r', branch: 'feat/x', mergedAt });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    const b = r.branches[0]!;
    assert.equal(b.status, 'merged');
    assert.equal(b.mergedAt, mergedAt);
  });

  test('branch_merges row with null merged_at does NOT mark merged', () => {
    const db = makeDb();
    // Within window, but >7 days old so status would be 'stale' (not 'merged').
    const oldTs = new Date(Date.now() - 10 * 86400000).toISOString();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: oldTs, repo: 'o/r', branch: 'feat/x' });
    insertBranchMerge(db, { repo: 'o/r', branch: 'feat/x', mergedAt: null });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    const b = r.branches[0]!;
    assert.equal(b.status, 'stale');
    assert.equal(b.mergedAt, null);
  });

  test('session_prs merged_at takes precedence over branch_merges', () => {
    const db = makeDb();
    const prMergedAt = daysAgo(11, '12:00');
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: daysAgo(15), repo: 'o/r', branch: 'feat/x' });
    db.prepare(
      `INSERT INTO session_prs
         (session_id, repo, pr_number, pr_title, pr_url, pr_state, head_branch, merged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('s1', 'o/r', 99, 't', 'u', 'merged', 'feat/x', prMergedAt);
    insertBranchMerge(db, { repo: 'o/r', branch: 'feat/x', mergedAt: daysAgo(11, '11:00') });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    const b = r.branches[0]!;
    assert.equal(b.status, 'merged');
    assert.equal(b.mergedAt, prMergedAt, 'PR mergedAt should win over branch_merges');
  });
});
