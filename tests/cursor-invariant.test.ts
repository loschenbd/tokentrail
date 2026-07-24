import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { renderCursorLane } from '../src/commands/report.js';

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
