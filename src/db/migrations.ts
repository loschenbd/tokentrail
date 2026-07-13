import type Database from 'better-sqlite3';
import { SCHEMA_STATEMENTS } from './schema.js';
import { healLocalRepoIdentities } from './repo-heal.js';

export function runMigrations(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // The dashboard daemon and the scheduled pipeline share this DB from
  // separate processes — wait out short write locks instead of throwing
  // SQLITE_BUSY immediately.
  db.pragma('busy_timeout = 5000');
  // Default autocheckpoint (1000 pages ≈ 4 MB) let the WAL sit near 5 MB
  // under the per-minute pipeline. Checkpoint more eagerly; writes are
  // small and bursty, so the extra fsyncs are cheap.
  db.pragma('wal_autocheckpoint = 256');
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
    addColumnIfMissing(db, 'feature_rollups', 'project_key', 'TEXT');
    // Expression-based unique index for project_key; matches ON CONFLICT in rollup.ts.
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_rollups_unique
      ON feature_rollups (date, COALESCE(project_key, ''), feature_key)`);
    // Legacy unique index will remain on old DBs; new index provides project-aware dedup.
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
    // Cluster failure backoff: a feature whose LLM call keeps failing on
    // the same session-set fingerprint retries on an exponential schedule
    // instead of every rollup (which kept the local model loaded 24/7).
    addColumnIfMissing(db, 'feature_cluster_runs', 'failed_hash', 'TEXT');
    addColumnIfMissing(db, 'feature_cluster_runs', 'fail_count', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'feature_cluster_runs', 'last_failed_at', 'TEXT');
    // Mainline feature inference columns (2026-06-29 spec)
    addColumnIfMissing(db, 'usage_events', 'inferred_feature_key', 'TEXT');
    addColumnIfMissing(db, 'usage_events', 'inferred_feature_name', 'TEXT');
    addColumnIfMissing(db, 'usage_events', 'inference_source', 'TEXT');
    // Create index after columns exist
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_events_inferred_feature
      ON usage_events (inferred_feature_key)`);
  });
  tx();
  try {
    const healResult = db.transaction(() => healLocalRepoIdentities(db))();
    if (healResult.healed.length > 0) {
      const detail = healResult.healed.map((h) => `${h.from} -> ${h.to}`).join(', ');
      console.log(`Merged ${healResult.healed.length} local repo identit${healResult.healed.length === 1 ? 'y' : 'ies'}: ${detail}`);
    }
    for (const a of healResult.ambiguous) {
      console.log(`Skipped ${a}: could not prove a single remote identity; left as-is.`);
    }
  } catch (err) {
    console.error(`Repo identity heal skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
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
