import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { _setDbForTest, closeDb } from '../src/db/db.js';
import { runCursor } from '../src/commands/cursor.js';
import { resetConfigCache, getConfig } from '../src/lib/config.js';

test('runCursor with no cursor data is a clean no-op', async () => {
  const db = new Database(':memory:'); runMigrations(db);
  _setDbForTest(db);
  resetConfigCache();
  (getConfig() as any).cursorTrackingDbPath = '/no/such.db';
  (getConfig() as any).cursorCloudSpend = false;
  await assert.doesNotReject(runCursor({ ingest: true, spend: true }));
  _setDbForTest(null);
});
