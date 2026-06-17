import { randomUUID } from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import { attribute } from '../lib/attribution.js';

// Upsert a work_units row for each (repo, branch) seen in usage_events.
// Uses min(timestamp) / max(timestamp) from usage_events to set
// first_seen_at / last_seen_at, so the values stay accurate even when
// older events arrive in a later ingest.
//
// Attribution here uses ONLY repo+branch; PR-derived signals come in
// during Phase 3 enrich.
export function refreshWorkUnits(db: DatabaseType.Database): {
  inserted: number;
  updated: number;
} {
  const pairs = db
    .prepare(
      `SELECT
         repo,
         branch,
         MIN(timestamp) AS first_seen,
         MAX(timestamp) AS last_seen
       FROM usage_events
       WHERE repo IS NOT NULL AND repo != '' AND branch IS NOT NULL AND branch != ''
       GROUP BY repo, branch`
    )
    .all() as Array<{
    repo: string;
    branch: string;
    first_seen: string;
    last_seen: string;
  }>;

  const existing = db.prepare(
    `SELECT id, first_seen_at, last_seen_at, github_enriched_at
     FROM work_units WHERE repo = ? AND branch = ?`
  );

  const insertStmt = db.prepare(`
    INSERT INTO work_units (
      id, repo, branch, feature_key, feature_name,
      first_seen_at, last_seen_at, status
    ) VALUES (
      @id, @repo, @branch, @feature_key, @feature_name,
      @first_seen_at, @last_seen_at, 'active'
    )
  `);

  // Only overwrite feature_key/name if this row has NOT been GitHub-enriched.
  // Enrichment is a stronger signal; we don't want to clobber it from raw
  // branch-prefix attribution on every ingest.
  //
  // Exception: legacy global `mainline-<branch>` keys (no repo segment,
  // e.g. `mainline-main`) predate per-repo mainline attribution. They
  // collapse every repo's main-branch spend into one bucket, which is
  // always wrong. Override them even when enriched so they migrate to
  // `mainline-<owner>-<repo>-<branch>` on next ingest. GLOB pattern
  // matches `mainline-<x>` where <x> is one segment; the per-repo form
  // `mainline-<x>-<y>` has a hyphen inside and won't match.
  const updateStmt = db.prepare(`
    UPDATE work_units
    SET first_seen_at = MIN(first_seen_at, @first_seen_at),
        last_seen_at  = MAX(last_seen_at, @last_seen_at),
        feature_key   = CASE
          WHEN github_enriched_at IS NULL THEN @feature_key
          WHEN feature_key GLOB 'mainline-*' AND feature_key NOT GLOB 'mainline-*-*' THEN @feature_key
          ELSE feature_key
        END,
        feature_name  = CASE
          WHEN github_enriched_at IS NULL THEN @feature_name
          WHEN feature_key GLOB 'mainline-*' AND feature_key NOT GLOB 'mainline-*-*' THEN @feature_name
          ELSE feature_name
        END
    WHERE id = @id
  `);

  let inserted = 0;
  let updated = 0;

  const tx = db.transaction(() => {
    for (const p of pairs) {
      const attr = attribute({ repo: p.repo, branch: p.branch });
      const row = existing.get(p.repo, p.branch) as
        | { id: string }
        | undefined;
      if (row) {
        updateStmt.run({
          id: row.id,
          first_seen_at: p.first_seen,
          last_seen_at: p.last_seen,
          feature_key: attr.featureKey,
          feature_name: attr.featureName,
        });
        updated++;
      } else {
        insertStmt.run({
          id: randomUUID(),
          repo: p.repo,
          branch: p.branch,
          feature_key: attr.featureKey,
          feature_name: attr.featureName,
          first_seen_at: p.first_seen,
          last_seen_at: p.last_seen,
        });
        inserted++;
      }
    }
  });
  tx();

  return { inserted, updated };
}
