import type Database from 'better-sqlite3';
import { SCHEMA_STATEMENTS } from './schema.js';

export function runMigrations(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const tx = db.transaction(() => {
    for (const stmt of SCHEMA_STATEMENTS) {
      db.exec(stmt);
    }
    // Idempotent ALTER TABLE — SQLite doesn't support ADD COLUMN IF NOT
    // EXISTS, so we probe pragma_table_info and skip when present.
    addColumnIfMissing(db, 'usage_events', 'project_dir', 'TEXT');
    addColumnIfMissing(db, 'sessions', 'feature_override_name', 'TEXT');
  });
  tx();
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  type: string
): void {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
