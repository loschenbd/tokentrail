import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { restoreAnomaly, dismissAnomaly } from '../src/commands/anomaly.js';
import { closeDb, getDb } from '../src/db/db.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

// The CLI functions call getDb() internally (a process-wide singleton that
// resolves TRACKER_DB_PATH on first use). To exercise them in tests we must
// point that env var at a real file path *before* getDb() is first invoked,
// and reuse the singleton's connection for our inserts/asserts so we're
// reading and writing the same DB.
let tmpDir: string;
let originalPath: string | undefined;

function makeDb(): DatabaseType.Database {
  closeDb();
  originalPath = process.env.TRACKER_DB_PATH;
  tmpDir = mkdtempSync(join(tmpdir(), 'tokentrail-anomaly-cli-'));
  process.env.TRACKER_DB_PATH = join(tmpDir, 'test.db');
  const db = getDb();
  runMigrations(db);
  return db;
}

function cleanupDb(): void {
  closeDb();
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  if (originalPath === undefined) delete process.env.TRACKER_DB_PATH;
  else process.env.TRACKER_DB_PATH = originalPath;
}

function insertAnomaly(db: DatabaseType.Database, opts: { dismissed: boolean }): number {
  // The (kind, date, feature_key, session_id) unique index requires non-null
  // feature_key when session_id is null, so vary feature_key per call.
  const r = db.prepare(
    `INSERT INTO anomalies (kind, date, feature_key, session_id, amount, baseline, multiplier, reason, dismissed_at)
     VALUES ('spike_day', '2026-06-01', 'feat-' || (abs(random()) % 1000000), NULL, 100, 30, 3.3, '$100 — 3.3×', ?)`
  ).run(opts.dismissed ? '2026-06-15T00:00:00Z' : null);
  return r.lastInsertRowid as number;
}

describe('restoreAnomaly', () => {
  let exitCode: number | undefined;
  let errorOutput: string[] = [];
  let logOutput: string[] = [];

  beforeEach(() => {
    exitCode = process.exitCode;
    process.exitCode = undefined;
    errorOutput = [];
    logOutput = [];
    const origErr = console.error;
    const origLog = console.log;
    console.error = (msg: string) => { errorOutput.push(String(msg)); };
    console.log = (msg: string) => { logOutput.push(String(msg)); };
    (globalThis as any).__restoreConsole = () => {
      console.error = origErr;
      console.log = origLog;
    };
  });

  afterEach(() => {
    (globalThis as any).__restoreConsole?.();
    process.exitCode = exitCode;
    cleanupDb();
  });

  test('clears dismissed_at on a dismissed anomaly', () => {
    const db = makeDb();
    const id = insertAnomaly(db, { dismissed: true });

    restoreAnomaly(id);

    const row = db.prepare('SELECT dismissed_at FROM anomalies WHERE id = ?').get(id) as { dismissed_at: string | null };
    assert.equal(row.dismissed_at, null);
    assert.equal(process.exitCode, undefined);
    assert.ok(logOutput.some((l) => l.includes(`Restored anomaly ${id}.`)));
  });

  test('errors with exit code 1 on unknown id', () => {
    makeDb();

    restoreAnomaly(999999);

    assert.equal(process.exitCode, 1);
    assert.ok(errorOutput.some((l) => l.includes('No dismissed anomaly with id 999999.')));
  });

  test('errors with exit code 1 on already-active anomaly', () => {
    const db = makeDb();
    const id = insertAnomaly(db, { dismissed: false });

    restoreAnomaly(id);

    assert.equal(process.exitCode, 1);
    assert.ok(errorOutput.some((l) => l.includes(`No dismissed anomaly with id ${id}.`)));
  });
});
