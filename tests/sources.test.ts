import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildSources } from '../src/dashboard/data/sources.js';

function seedCursorDay(db: Database.Database, date: string, usd: number) {
  db.prepare(`INSERT INTO cursor_daily_cost (date, usd, updated_at) VALUES (?, ?, '2026-07-24')`).run(date, usd);
}

describe('buildSources', () => {
  test('combines claude (passed in) + cursor (daily rollup); lines only in extra', () => {
    const db = new Database(':memory:'); runMigrations(db);
    const today = (db.prepare(`SELECT date('now','localtime') AS d`).get() as { d: string }).d;
    seedCursorDay(db, today, 4.5);
    db.prepare(`INSERT INTO cursor_code_attribution
      (commit_hash, repo, branch, ai_lines, composer_lines, tab_lines, human_lines, scored_at)
      VALUES ('h','local/p','main', 900, 900, 0, 10, 1)`).run();

    const out = buildSources(db, { days: 1, claudeUsd: 9 });
    assert.equal(out.totalUsd, 13.5);                 // 9 + 4.5, dollars only
    const cursor = out.sources.find((s) => s.key === 'cursor')!;
    assert.equal(cursor.usd, 4.5);
    assert.equal(cursor.extra?.aiLines, 900);         // lines in extra, NOT in totalUsd
    const claude = out.sources.find((s) => s.key === 'claude')!;
    assert.equal(claude.usd, 9);
  });

  test('omits cursor entry when there is no cursor data', () => {
    const db = new Database(':memory:'); runMigrations(db);
    const out = buildSources(db, { days: 30, claudeUsd: 12 });
    assert.equal(out.sources.length, 1);
    assert.equal(out.sources[0]!.key, 'claude');
    assert.equal(out.totalUsd, 12);
  });
});
