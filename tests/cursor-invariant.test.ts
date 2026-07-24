import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { renderCursorLane } from '../src/commands/report.js';
import { runCursorIngest } from '../src/commands/cursor.js';
import { resetConfigCache, getConfig } from '../src/lib/config.js';

test('renderCursorLane shows lines and account usage, never mixed', () => {
  const db = new Database(':memory:'); runMigrations(db);
  db.prepare(`INSERT INTO cursor_code_attribution
    (commit_hash, repo, branch, ai_lines, composer_lines, tab_lines, human_lines, ai_pct, scored_at)
    VALUES ('h','local/proj','main', 100, 90, 10, 5, 95.2, 1)`).run();
  db.prepare(`INSERT INTO cursor_usage
    (id, membership_type, plan_pct_used, metered_usd, truncated, fetched_at, stale)
    VALUES (1, 'pro', 0.6, 41.2, 0, '2026-07-24', 0)`).run();
  const out = renderCursorLane(db);
  assert.match(out, /Cursor/);
  assert.match(out, /100/);            // ai lines shown
  assert.match(out, /\$41\.20/);       // metered dollars shown
  assert.match(out, /account-wide/);   // dollars labeled non-attributable
  assert.match(out, /estimated/);      // rule #3
});

test('empty cursor data renders nothing', () => {
  const db = new Database(':memory:'); runMigrations(db);
  assert.equal(renderCursorLane(db), '');
});

test('cursor ingest never writes to usage_events / never changes USD totals', async () => {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`INSERT INTO usage_events (id, session_id, timestamp, model, estimated_cost_usd)
    VALUES ('e1','s','2026-07-01T00:00:00Z','opus', 3.50)`).run();
  const before = (db.prepare('SELECT SUM(estimated_cost_usd) AS t FROM usage_events').get() as any).t;
  const beforeCount = (db.prepare('SELECT COUNT(*) AS c FROM usage_events').get() as any).c;

  // empty cursor db -> ingest is a no-op, but even a populated one must not touch usage_events
  resetConfigCache();
  (getConfig() as any).cursorTrackingDbPath = '/no/such.db';
  await runCursorIngest(db);

  const after = (db.prepare('SELECT SUM(estimated_cost_usd) AS t FROM usage_events').get() as any).t;
  const afterCount = (db.prepare('SELECT COUNT(*) AS c FROM usage_events').get() as any).c;
  assert.equal(after, before);
  assert.equal(afterCount, beforeCount);
});
