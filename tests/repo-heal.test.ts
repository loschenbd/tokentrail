import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { healLocalRepoIdentities, knownSlugForDir } from '../src/db/repo-heal.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

function makeDb(): DatabaseType.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seedEvent(
  db: DatabaseType.Database,
  opts: { id: string; repo: string | null; projectDir: string | null }
): void {
  // model is NOT NULL with no default — must be supplied.
  db.prepare(`
    INSERT INTO usage_events (id, session_id, timestamp, repo, branch, project_dir, model,
                              input_tokens, output_tokens, estimated_cost_usd)
    VALUES (@id, 's1', '2026-06-26T12:00:00Z', @repo, 'main', @projectDir, 'test-model', 10, 10, 0.01)
  `).run({ id: opts.id, repo: opts.repo, projectDir: opts.projectDir });
}

describe('healLocalRepoIdentities', () => {
  test('rewrites local/X to the slug sharing its project_dir, across tables', () => {
    const db = makeDb();
    const dir = '/Users/ben/Projects/mud';
    seedEvent(db, { id: 'e1', repo: 'local/mud', projectDir: dir });
    seedEvent(db, { id: 'e2', repo: 'owner/mud', projectDir: dir });
    db.prepare(`INSERT INTO session_commits (session_id, commit_sha, repo) VALUES ('s1', 'abc', 'local/mud')`).run();
    db.prepare(`
      INSERT INTO feature_rollups (id, date, feature_key, feature_name, repo, total_cost_usd)
      VALUES ('r1', '2026-06-26', 'f1', 'F1', 'local/mud,owner/mud', 5)
    `).run();

    const result = healLocalRepoIdentities(db);

    assert.deepEqual(result.healed, [{ from: 'local/mud', to: 'owner/mud' }]);
    assert.equal(result.ambiguous.length, 0);
    const repos = db.prepare(`SELECT DISTINCT repo FROM usage_events ORDER BY repo`).all() as Array<{ repo: string }>;
    assert.deepEqual(repos.map((r) => r.repo), ['owner/mud']);
    const commit = db.prepare(`SELECT repo FROM session_commits WHERE commit_sha = 'abc'`).get() as { repo: string };
    assert.equal(commit.repo, 'owner/mud');
    // CSV entry replaced AND deduped
    const rollup = db.prepare(`SELECT repo FROM feature_rollups WHERE id = 'r1'`).get() as { repo: string };
    assert.equal(rollup.repo, 'owner/mud');
  });

  test('leaves genuinely local-only repos untouched', () => {
    const db = makeDb();
    seedEvent(db, { id: 'e1', repo: 'local/writing-mentor', projectDir: '/Users/ben/Projects/writing-mentor' });

    const result = healLocalRepoIdentities(db);

    assert.equal(result.healed.length, 0);
    const row = db.prepare(`SELECT repo FROM usage_events WHERE id = 'e1'`).get() as { repo: string };
    assert.equal(row.repo, 'local/writing-mentor');
  });

  test('skips and reports ambiguous local repos (two slugs share the dir)', () => {
    const db = makeDb();
    const dir = '/Users/ben/Projects/x';
    seedEvent(db, { id: 'e1', repo: 'local/x', projectDir: dir });
    seedEvent(db, { id: 'e2', repo: 'owner/x', projectDir: dir });
    seedEvent(db, { id: 'e3', repo: 'other/x', projectDir: dir });

    const result = healLocalRepoIdentities(db);

    assert.equal(result.healed.length, 0);
    assert.deepEqual(result.ambiguous, ['local/x']);
    const row = db.prepare(`SELECT repo FROM usage_events WHERE id = 'e1'`).get() as { repo: string };
    assert.equal(row.repo, 'local/x');
  });

  test('resolves UNIQUE(repo, branch) collisions in work_units by keeping the slug row', () => {
    const db = makeDb();
    const dir = '/Users/ben/Projects/mud';
    seedEvent(db, { id: 'e1', repo: 'local/mud', projectDir: dir });
    seedEvent(db, { id: 'e2', repo: 'owner/mud', projectDir: dir });
    const insertWu = db.prepare(`
      INSERT INTO work_units (id, repo, branch, feature_key, feature_name, first_seen_at, last_seen_at)
      VALUES (@id, @repo, 'main', 'f1', 'F1', '2026-06-26', '2026-06-26')
    `);
    insertWu.run({ id: 'wu-local', repo: 'local/mud' });
    insertWu.run({ id: 'wu-slug', repo: 'owner/mud' });

    healLocalRepoIdentities(db);

    const wus = db.prepare(`SELECT id, repo FROM work_units`).all() as Array<{ id: string; repo: string }>;
    assert.equal(wus.length, 1);
    assert.equal(wus[0]!.id, 'wu-slug');
    assert.equal(wus[0]!.repo, 'owner/mud');
  });

  test('skips local/X when it appears on a dir with no slug sibling (multi-dir overreach guard)', () => {
    const db = makeDb();
    const dir1 = '/Users/ben/Projects/mud';
    const dir2 = '/Users/ben/Unrelated/mud';
    // dir1 has both local/mud and owner/mud — provable on this dir alone.
    seedEvent(db, { id: 'e1', repo: 'local/mud', projectDir: dir1 });
    seedEvent(db, { id: 'e2', repo: 'owner/mud', projectDir: dir1 });
    // dir2 only has local/mud, no slug sibling — rewriting all local/mud rows
    // would silently fold this unrelated project into owner/mud.
    seedEvent(db, { id: 'e3', repo: 'local/mud', projectDir: dir2 });

    const result = healLocalRepoIdentities(db);

    assert.equal(result.healed.length, 0, 'should not heal when a dir has no slug sibling');
    assert.deepEqual(result.ambiguous, ['local/mud']);
    // Both local/mud rows must be untouched.
    const rows = db.prepare(`SELECT repo FROM usage_events WHERE repo = 'local/mud' ORDER BY id`).all() as Array<{ repo: string }>;
    assert.equal(rows.length, 2, 'both local/mud rows should remain');
    const slugRow = db.prepare(`SELECT repo FROM usage_events WHERE id = 'e2'`).get() as { repo: string };
    assert.equal(slugRow.repo, 'owner/mud', 'slug row should be untouched');
  });

  test('is idempotent — second run heals nothing', () => {
    const db = makeDb();
    const dir = '/Users/ben/Projects/mud';
    seedEvent(db, { id: 'e1', repo: 'local/mud', projectDir: dir });
    seedEvent(db, { id: 'e2', repo: 'owner/mud', projectDir: dir });

    healLocalRepoIdentities(db);
    const second = healLocalRepoIdentities(db);

    assert.equal(second.healed.length, 0);
    assert.equal(second.ambiguous.length, 0);
  });
});

describe('knownSlugForDir', () => {
  test('returns the slug when exactly one non-local repo was seen on the dir', () => {
    const db = makeDb();
    seedEvent(db, { id: 'e1', repo: 'owner/mud', projectDir: '/p/mud' });
    assert.equal(knownSlugForDir(db, '/p/mud'), 'owner/mud');
  });

  test('returns null when zero or multiple slugs were seen', () => {
    const db = makeDb();
    assert.equal(knownSlugForDir(db, '/p/none'), null);
    seedEvent(db, { id: 'e1', repo: 'owner/x', projectDir: '/p/x' });
    seedEvent(db, { id: 'e2', repo: 'other/x', projectDir: '/p/x' });
    assert.equal(knownSlugForDir(db, '/p/x'), null);
  });
});

describe('runMigrations integration', () => {
  test('startup migration heals fragmented identities', () => {
    const db = new Database(':memory:');
    runMigrations(db);  // schema only, empty tables — must not throw
    const dir = '/Users/ben/Projects/mud';
    db.prepare(`
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, project_dir, model,
                                input_tokens, output_tokens, estimated_cost_usd)
      VALUES ('e1', 's1', '2026-06-26T12:00:00Z', 'local/mud', 'main', @dir, 'test-model', 10, 10, 0.01)
    `).run({ dir });
    db.prepare(`
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, project_dir, model,
                                input_tokens, output_tokens, estimated_cost_usd)
      VALUES ('e2', 's1', '2026-06-26T12:01:00Z', 'owner/mud', 'main', @dir, 'test-model', 10, 10, 0.01)
    `).run({ dir });

    runMigrations(db);  // second startup — heal fires

    const repos = db.prepare(`SELECT DISTINCT repo FROM usage_events ORDER BY repo`).all() as Array<{ repo: string }>;
    assert.deepEqual(repos.map((r) => r.repo), ['owner/mud']);
  });
});
