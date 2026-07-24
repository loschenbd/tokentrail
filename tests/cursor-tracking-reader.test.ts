import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';

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
