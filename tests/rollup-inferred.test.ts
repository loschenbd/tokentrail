import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';

describe('runRollup COALESCE', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    // setDb so runRollup uses our in-memory connection.
    const dbModule = await import('../src/db/db.js');
    (dbModule as any)._setDbForTest?.(db);
  });

  afterEach(async () => {
    // Reset the seam so future tests are not polluted.
    const dbModule = await import('../src/db/db.js');
    (dbModule as any)._setDbForTest?.(null);
  });

  test('inferred_feature_key wins over work_units.feature_key', async () => {
    db.exec(`
      INSERT INTO work_units (id, repo, branch, feature_key, feature_name, first_seen_at, last_seen_at)
      VALUES ('w','octo/x','main','mainline-octo-x-main','x (main)','2026-06-29T09:00:00Z','2026-06-29T10:00:00Z');
      INSERT INTO sessions (session_id, title, first_seen_at, last_seen_at)
      VALUES ('s','t','2026-06-29T09:00:00Z','2026-06-29T10:00:00Z');
      INSERT INTO usage_events
        (id, session_id, timestamp, repo, branch, model, estimated_cost_usd, inferred_feature_key, inferred_feature_name)
      VALUES
        ('e','s','2026-06-29T09:30:00Z','octo/x','main','m',0.5,'menubar','Menubar');
    `);

    const { runRollup } = await import('../src/commands/rollup.js');
    await runRollup();

    const row = db.prepare(`SELECT feature_key, feature_name, total_cost_usd FROM feature_rollups`).get() as any;
    assert.equal(row.feature_key, 'menubar');
    assert.equal(row.feature_name, 'Menubar');
  });
});
