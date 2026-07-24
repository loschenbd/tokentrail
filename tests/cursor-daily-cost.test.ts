import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';

describe('cursor_daily_cost schema', () => {
  test('table exists with date PK', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(cursor_daily_cost)`).all() as Array<{ name: string; pk: number }>;
    const names = cols.map((c) => c.name);
    assert.ok(names.includes('date'));
    assert.ok(names.includes('usd'));
    assert.ok(names.includes('updated_at'));
    assert.equal(cols.find((c) => c.name === 'date')?.pk, 1);
  });
});
