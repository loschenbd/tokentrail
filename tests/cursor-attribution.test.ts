import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitExistsIn } from '../src/services/git.js';

function makeRepoWithCommit(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tt-git-'));
  const run = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  run(['init', '-q']);
  run(['config', 'user.email', 't@t.co']);
  run(['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'f.txt'), 'hi');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);
  const sha = run(['rev-parse', 'HEAD']);
  return { dir, sha };
}

describe('commitExistsIn', () => {
  test('true for a sha in the repo, false otherwise', () => {
    const { dir, sha } = makeRepoWithCommit();
    assert.equal(commitExistsIn(dir, sha), true);
    assert.equal(commitExistsIn(dir, 'deadbeef00000000000000000000000000000000'), false);
  });

  test('false for a non-repo dir, no throw', () => {
    assert.equal(commitExistsIn('/tmp', 'deadbeef'), false);
  });
});

import { resolveCommitRepo } from '../src/commands/cursor.js';

describe('resolveCommitRepo', () => {
  test('returns the local/<base> slug of the repo containing the sha', () => {
    const { dir, sha } = makeRepoWithCommit();
    const cache = new Map<string, string | null>();
    const repo = resolveCommitRepo(sha, [dir], cache);
    // no remote configured -> local/<basename>
    assert.ok(repo && repo.startsWith('local/'));
  });

  test('caches misses so repeat lookups do not re-shell git', () => {
    const cache = new Map<string, string | null>();
    const r1 = resolveCommitRepo('deadbeef', ['/tmp'], cache);
    assert.equal(r1, null);
    assert.equal(cache.has('deadbeef'), true);
  });
});

import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { runCursorIngest, knownProjectDirs, reresolveParkedCommits } from '../src/commands/cursor.js';
import { cursorTrackingDbPath } from '../src/services/cursor-tracking-reader.js';
import { getConfig, resetConfigCache } from '../src/lib/config.js';

test('runCursorIngest stores rows, resolving repo where a commit is known', async () => {
  const { dir, sha } = makeRepoWithCommit();
  // fixture cursor db with one scored commit matching the real sha.
  // Use a fresh temp dir (not a fixed /tmp path) so a leftover file from a
  // prior run can't make `CREATE TABLE scored_commits` fail as "already exists"
  // — that made the suite pass once, then fail on every re-run.
  const curPath = join(mkdtempSync(join(tmpdir(), 'tt-cursor-ingest-')), 'ct.db');
  const cur = new Database(curPath);
  cur.exec(`CREATE TABLE scored_commits (commitHash TEXT, branchName TEXT, scoredAt INTEGER,
    composerLinesAdded INTEGER, tabLinesAdded INTEGER, humanLinesAdded INTEGER,
    v2AiPercentage TEXT, commitMessage TEXT, commitDate TEXT,
    PRIMARY KEY (commitHash, branchName));`);
  cur.prepare(`INSERT INTO scored_commits VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(sha, 'main', 1234, 10, 0, 0, '100.00', 'm', 'd');
  cur.close();

  const db = new Database(':memory:');
  runMigrations(db);
  // seed a session whose project_dir is the real repo so knownProjectDirs finds it
  db.prepare(`INSERT INTO sessions (session_id, project_dir, first_seen_at, last_seen_at)
    VALUES ('s1', ?, '2026-01-01', '2026-01-01')`).run(dir);

  // point config at the fixture cursor db
  resetConfigCache();
  (getConfig() as any).cursorTrackingDbPath = curPath;

  const res = await runCursorIngest(db);
  assert.equal(res.inserted, 1);
  const row: any = db.prepare('SELECT * FROM cursor_code_attribution WHERE commit_hash=?').get(sha);
  assert.ok(row.repo && row.repo.startsWith('local/'));
  assert.equal(row.ai_lines, 10);
  assert.equal(row.branch, 'main');
});

test('reresolveParkedCommits fills repo once the dir is known', () => {
  const { dir, sha } = makeRepoWithCommit();
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`INSERT INTO cursor_code_attribution
    (commit_hash, repo, branch, ai_lines, composer_lines, tab_lines, human_lines, scored_at)
    VALUES (?, NULL, 'main', 5, 5, 0, 0, 1)`).run(sha);
  db.prepare(`INSERT INTO sessions (session_id, project_dir, first_seen_at, last_seen_at)
    VALUES ('s', ?, '2026-01-01','2026-01-01')`).run(dir);
  const n = reresolveParkedCommits(db);
  assert.equal(n, 1);
  const row: any = db.prepare('SELECT repo FROM cursor_code_attribution WHERE commit_hash=?').get(sha);
  assert.ok(row.repo.startsWith('local/'));
});

test('runCursorIngest re-resolves parked commits even when there are zero new scored commits', async () => {
  const { dir, sha } = makeRepoWithCommit();
  const db = new Database(':memory:');
  runMigrations(db);
  // A previously-parked row (repo unknown at the time) whose sha lives in a
  // dir that IS now known via a session.
  db.prepare(`INSERT INTO cursor_code_attribution
    (commit_hash, repo, branch, ai_lines, composer_lines, tab_lines, human_lines, scored_at)
    VALUES (?, NULL, 'main', 5, 5, 0, 0, 1)`).run(sha);
  db.prepare(`INSERT INTO sessions (session_id, project_dir, first_seen_at, last_seen_at)
    VALUES ('s', ?, '2026-01-01','2026-01-01')`).run(dir);

  // Point at a missing cursor tracking db -> readScoredCommits returns [],
  // i.e. zero new scored commits this run.
  resetConfigCache();
  (getConfig() as any).cursorTrackingDbPath = '/no/such/cursor-tracking.db';

  const res = await runCursorIngest(db);
  assert.equal(res.scanned, 0);
  assert.equal(res.inserted, 0);

  const row: any = db.prepare('SELECT repo FROM cursor_code_attribution WHERE commit_hash=?').get(sha);
  assert.ok(row.repo && row.repo.startsWith('local/'));
});
