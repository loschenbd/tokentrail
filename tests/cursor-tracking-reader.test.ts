import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { getConfig, resetConfigCache } from '../src/lib/config.js';
import { readScoredCommits } from '../src/services/cursor-tracking-reader.js';

describe('cursor schema', () => {
  test('creates cursor tables', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    assert.ok(names.includes('cursor_code_attribution'));
    assert.ok(names.includes('cursor_usage'));
    assert.ok(names.includes('cursor_ingest_state'));
  });
});

describe('cursor config defaults', () => {
  test('cloud spend enabled by default, paths null', () => {
    resetConfigCache();
    const c = getConfig();
    assert.equal(c.cursorCloudSpend, true);
    assert.equal(c.cursorTrackingDbPath, null);
    assert.equal(c.cursorStateDbPath, null);
    assert.equal(c.cursorSessionCookie, null);
  });
});

// Builds a real on-disk fixture DB mimicking Cursor's `ai-code-tracking.db`
// scored_commits table. Written directly to a file path (rather than
// :memory: + .backup()) because better-sqlite3's .backup() is async and
// the simpler direct-file approach reliably produces a real file that can
// be reopened readonly.
function makeCursorDb(path: string) {
  const db = new Database(path);
  db.exec(`CREATE TABLE scored_commits (
    commitHash TEXT NOT NULL, branchName TEXT NOT NULL, scoredAt INTEGER NOT NULL,
    linesAdded INTEGER, linesDeleted INTEGER, tabLinesAdded INTEGER, tabLinesDeleted INTEGER,
    composerLinesAdded INTEGER, composerLinesDeleted INTEGER, humanLinesAdded INTEGER,
    humanLinesDeleted INTEGER, blankLinesAdded INTEGER, blankLinesDeleted INTEGER,
    commitMessage TEXT, commitDate TEXT, v1AiPercentage TEXT, v2AiPercentage TEXT,
    PRIMARY KEY (commitHash, branchName));`);
  db.prepare(`INSERT INTO scored_commits
    (commitHash, branchName, scoredAt, composerLinesAdded, tabLinesAdded, humanLinesAdded, v2AiPercentage, commitMessage, commitDate)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    'abc123', 'main', 1000, 20, 5, 3, '89.29', 'do a thing', 'Wed May 20 13:01:13 2026 -0700');
  db.prepare(`INSERT INTO scored_commits
    (commitHash, branchName, scoredAt, composerLinesAdded, tabLinesAdded, humanLinesAdded, v2AiPercentage)
    VALUES (?,?,?,?,?,?,?)`).run('old999', 'dev', 500, 1, 0, 0, '100.00');
  db.close();
}

describe('readScoredCommits', () => {
  test('maps rows and filters by scoredAt watermark', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokentrail-cursor-reader-'));
    const tmp = join(dir, 'tt-cursor-fixture.db');
    makeCursorDb(tmp); // real on-disk fixture so it can be reopened readonly
    const rows = readScoredCommits(tmp, 999);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    assert.equal(row.commitHash, 'abc123');
    assert.equal(row.aiLines, 25); // composer 20 + tab 5
    assert.equal(row.humanLines, 3);
    assert.equal(row.aiPct, 89.29);
    assert.equal(row.branch, 'main');
  });

  test('missing db returns empty, no throw', () => {
    assert.deepEqual(readScoredCommits('/no/such.db', 0), []);
  });
});
