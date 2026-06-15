import type Database from 'better-sqlite3';
import { SCHEMA_STATEMENTS } from './schema.js';

export function runMigrations(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const tx = db.transaction(() => {
    for (const stmt of SCHEMA_STATEMENTS) {
      db.exec(stmt);
    }
  });
  tx();
}
