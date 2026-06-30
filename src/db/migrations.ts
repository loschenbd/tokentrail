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
    addColumnIfMissing(db, 'feature_rollups', 'commit_summary', 'TEXT');
    addColumnIfMissing(db, 'session_commits', 'repo', 'TEXT');
    addColumnIfMissing(db, 'feature_rollups', 'body_synced_at', 'TEXT');
    addColumnIfMissing(db, 'feature_rollups', 'session_ids', 'TEXT');
    // Idempotent backfill: early-version session_commits rows landed with
    // repo=NULL because the commits-backfill code path predated the
    // local/<basename> fallback. Borrow repo from the most-frequent
    // usage_events.repo for the same session_id. Re-running is a no-op
    // since the WHERE filters out non-NULL rows.
    db.exec(`
      UPDATE session_commits
      SET repo = (
        SELECT repo FROM usage_events ue
        WHERE ue.session_id = session_commits.session_id
          AND ue.repo IS NOT NULL
        GROUP BY ue.repo
        ORDER BY COUNT(*) DESC
        LIMIT 1
      )
      WHERE repo IS NULL
        AND EXISTS (
          SELECT 1 FROM usage_events ue
          WHERE ue.session_id = session_commits.session_id
            AND ue.repo IS NOT NULL
        )
    `);
    // Mainline feature inference columns (2026-06-29 spec)
    addColumnIfMissing(db, 'usage_events', 'inferred_feature_key', 'TEXT');
    addColumnIfMissing(db, 'usage_events', 'inferred_feature_name', 'TEXT');
    addColumnIfMissing(db, 'usage_events', 'inference_source', 'TEXT');
    // Create index after columns exist
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_events_inferred_feature
      ON usage_events (inferred_feature_key)`);
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
