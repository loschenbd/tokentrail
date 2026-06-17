import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { refreshWorkUnits } from '../src/services/work-units.js';

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function insertEvent(db: Database.Database, params: { sessionId: string; repo: string; branch: string }) {
  db.prepare(
    `INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model)
     VALUES (?, ?, datetime('now'), ?, ?, 'sonnet')`
  ).run(`evt-${params.sessionId}`, params.sessionId, params.repo, params.branch);
}

function getWorkUnit(db: Database.Database, repo: string, branch: string) {
  return db.prepare(
    `SELECT feature_key, feature_name FROM work_units WHERE repo = ? AND branch = ?`
  ).get(repo, branch) as { feature_key: string; feature_name: string } | undefined;
}

describe('refreshWorkUnits', () => {
  test('overwrites stale legacy mainline-<branch> key even when github_enriched_at is set', () => {
    // Reproduces the bug where a pre-fix work_units row carrying the
    // global `mainline-main` key (no repo segment) and a stamped
    // github_enriched_at would never get rewritten to the new per-repo
    // key `mainline-<owner>-<repo>-<branch>` — leaving every repo's
    // main-branch spend collapsed into one bucket forever.
    const db = makeDb();
    insertEvent(db, { sessionId: 's1', repo: 'owner/foo', branch: 'main' });

    db.prepare(
      `INSERT INTO work_units (id, repo, branch, feature_key, feature_name,
         first_seen_at, last_seen_at, github_enriched_at, status)
       VALUES ('wu-stale', 'owner/foo', 'main', 'mainline-main', 'Mainline (main)',
         datetime('now'), datetime('now'), datetime('now'), 'active')`
    ).run();

    refreshWorkUnits(db);

    const wu = getWorkUnit(db, 'owner/foo', 'main');
    assert.equal(wu?.feature_key, 'mainline-owner-foo-main');
    assert.equal(wu?.feature_name, 'foo (main)');
  });

  test('preserves PR-derived feature_key/name when github_enriched_at is set (control)', () => {
    // The github_enriched_at guard's original purpose: don't clobber a
    // PR-derived name with raw branch attribution. This stays intact —
    // only the legacy mainline-<branch> shape gets the override.
    const db = makeDb();
    insertEvent(db, { sessionId: 's2', repo: 'owner/bar', branch: 'feat/add-thing' });

    db.prepare(
      `INSERT INTO work_units (id, repo, branch, feature_key, feature_name,
         first_seen_at, last_seen_at, github_enriched_at, status)
       VALUES ('wu-pr', 'owner/bar', 'feat/add-thing', 'pr-42-add-thing',
         'Add thing (PR #42)',
         datetime('now'), datetime('now'), datetime('now'), 'active')`
    ).run();

    refreshWorkUnits(db);

    const wu = getWorkUnit(db, 'owner/bar', 'feat/add-thing');
    assert.equal(wu?.feature_key, 'pr-42-add-thing');
    assert.equal(wu?.feature_name, 'Add thing (PR #42)');
  });

  test('leaves new-format per-repo mainline key alone when enriched (control)', () => {
    // Per-repo mainline keys (`mainline-<owner>-<repo>-<branch>`) are
    // already correct; the legacy-override should NOT touch them. Their
    // shape — three or more hyphen segments after `mainline-` — must not
    // match the legacy pattern.
    const db = makeDb();
    insertEvent(db, { sessionId: 's3', repo: 'owner/baz', branch: 'main' });

    db.prepare(
      `INSERT INTO work_units (id, repo, branch, feature_key, feature_name,
         first_seen_at, last_seen_at, github_enriched_at, status)
       VALUES ('wu-new', 'owner/baz', 'main', 'mainline-owner-baz-main',
         'Custom name from enrichment',
         datetime('now'), datetime('now'), datetime('now'), 'active')`
    ).run();

    refreshWorkUnits(db);

    const wu = getWorkUnit(db, 'owner/baz', 'main');
    // Name is preserved (enriched), key is unchanged (already per-repo).
    assert.equal(wu?.feature_key, 'mainline-owner-baz-main');
    assert.equal(wu?.feature_name, 'Custom name from enrichment');
  });

  test('inserts a new work_units row when none exists', () => {
    const db = makeDb();
    insertEvent(db, { sessionId: 's4', repo: 'owner/qux', branch: 'main' });

    refreshWorkUnits(db);

    const wu = getWorkUnit(db, 'owner/qux', 'main');
    assert.equal(wu?.feature_key, 'mainline-owner-qux-main');
    assert.equal(wu?.feature_name, 'qux (main)');
  });
});
