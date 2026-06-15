import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { runMigrations } from './migrations.js';

const require = createRequire(import.meta.url);
// better-sqlite3 ships as CJS with no `exports` field; tsx's ESM resolver
// trips on it. Loading via createRequire sidesteps that.
const Database = require('better-sqlite3') as typeof DatabaseType;

let instance: DatabaseType.Database | null = null;

export function getDb(): DatabaseType.Database {
  if (instance) return instance;
  const path = resolve(process.env.TRACKER_DB_PATH ?? 'data/tracker.db');
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  runMigrations(db);
  instance = db;
  return db;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
