import { randomUUID } from 'node:crypto';
import { getDb } from '../db/db.js';
import { aggregateFeatureBuckets } from '../lib/feature-aggregate.js';
import { computeAndPersistAnomalies } from '../services/anomalies-db.js';
import { recomputeClusters } from '../services/clustering.js';

export type RollupSummary = {
  rowsUpserted: number;
};

// Aggregate usage_events into feature_rollups grouped by (date, feature_key).
//
// Join strategy:
//   - Events with a known (repo, branch) join to work_units for the
//     authoritative feature_key/feature_name.
//   - Events without a work_units row fall back to a synthetic attribution
//     derived from (repo|null, branch|null) so usage never silently disappears.
//
// Re-running is safe: rollups are upserted by (date, feature_key). The
// upsert's WHERE clause skips rows whose values are unchanged, so
// updated_at moves only when the numbers actually moved — which is also
// what keeps `sync` from re-pushing untouched rows to Notion.
// `cluster` gates the LLM-backed topic clustering step. It defaults to true
// so the explicit paths (run-all, the `rollup` CLI, the infer-mainline SSE)
// keep clustering. The dashboard's passive freshen loop passes false: that
// path fires on every menubar poll (~60s), and clustering there would mean a
// menubar tick could trigger an LLM call — pinning a local Ollama model in
// memory once the backend is set to ollama. Clustering is not time-sensitive,
// so it belongs only on the explicit/manual refresh paths.
export async function runRollup(opts: { cluster?: boolean } = {}): Promise<RollupSummary> {
  const shouldCluster = opts.cluster ?? true;
  const db = getDb();

  // Aggregate usage_events → (date, feature) buckets. Shared with the
  // source-scoped overview so attribution can never diverge between the two.
  // All sources here; the overview passes a source filter.
  const buckets = aggregateFeatureBuckets(db);

  const upsert = db.prepare(`
    INSERT INTO feature_rollups (
      id, date, feature_key, feature_name, repo, branches,
      total_input_tokens, total_output_tokens, total_cost_usd, sessions_count,
      commit_summary, session_ids
    ) VALUES (
      @id, @date, @feature_key, @feature_name, @repo, @branches,
      @total_input_tokens, @total_output_tokens, @total_cost_usd, @sessions_count,
      @commit_summary, @session_ids
    )
    ON CONFLICT(date, COALESCE(project_key, ''), feature_key) DO UPDATE SET
      feature_name        = excluded.feature_name,
      repo                = excluded.repo,
      branches            = excluded.branches,
      total_input_tokens  = excluded.total_input_tokens,
      total_output_tokens = excluded.total_output_tokens,
      total_cost_usd      = excluded.total_cost_usd,
      sessions_count      = excluded.sessions_count,
      commit_summary      = excluded.commit_summary,
      session_ids         = excluded.session_ids,
      updated_at          = datetime('now')
    WHERE feature_rollups.feature_name        IS NOT excluded.feature_name
       OR feature_rollups.repo                IS NOT excluded.repo
       OR feature_rollups.branches            IS NOT excluded.branches
       OR feature_rollups.total_input_tokens  IS NOT excluded.total_input_tokens
       OR feature_rollups.total_output_tokens IS NOT excluded.total_output_tokens
       OR feature_rollups.total_cost_usd      IS NOT excluded.total_cost_usd
       OR feature_rollups.sessions_count      IS NOT excluded.sessions_count
       OR feature_rollups.commit_summary      IS NOT excluded.commit_summary
       OR feature_rollups.session_ids         IS NOT excluded.session_ids
  `);

  const commitsForSessions = db.prepare(
    `SELECT c.subject, c.authored_at FROM session_commits c
     WHERE c.session_id IN (SELECT value FROM json_each(?))
     ORDER BY c.authored_at`
  );

  // Delete any rollup whose (date, feature_key) no longer appears in this
  // run — handles attribution-rule changes that move past usage from one
  // bucket to another (e.g. an event re-bucketed from "untracked" to
  // "outside:foo"). We keep upsert semantics so notion_page_id and
  // synced_to_notion_at survive on rows that still exist.
  const aliveKeys = new Set<string>();
  for (const b of buckets.values()) aliveKeys.add(`${b.date}::${b.featureKey}`);

  // Single SQL anti-join instead of loading the whole table into JS and
  // issuing per-row DELETEs.
  const deleteStale = db.prepare(`
    DELETE FROM feature_rollups
    WHERE (date || '::' || feature_key) NOT IN (SELECT value FROM json_each(?))
  `);

  let rowsUpserted = 0;
  let rowsDeleted = 0;
  const tx = db.transaction(() => {
    rowsDeleted = deleteStale.run(JSON.stringify([...aliveKeys])).changes;
    for (const b of buckets.values()) {
      const reposCsv = [...b.repos].sort().join(',');
      const branchesCsv = [...b.branches].sort().join(',');
      const commitSummary = buildCommitSummary(
        commitsForSessions.all(JSON.stringify([...b.sessionIds])) as Array<{
          subject: string;
          authored_at: string;
        }>
      );
      const result = upsert.run({
        id: randomUUID(),
        date: b.date,
        feature_key: b.featureKey,
        feature_name: b.featureName,
        repo: reposCsv || null,
        branches: branchesCsv,
        total_input_tokens: b.inTokens,
        total_output_tokens: b.outTokens,
        total_cost_usd: round2(b.cost),
        sessions_count: b.sessionIds.size,
        commit_summary: commitSummary,
        session_ids: [...b.sessionIds].sort().join(','),
      });
      if (result.changes > 0) rowsUpserted++;
    }
  });
  tx();

  // Verification: rollup total should equal event-level total.
  const a = (db.prepare(`SELECT SUM(estimated_cost_usd) AS s FROM usage_events`).get() as { s: number | null }).s ?? 0;
  const b = (db.prepare(`SELECT SUM(total_cost_usd) AS s FROM feature_rollups`).get() as { s: number | null }).s ?? 0;
  const deletedSuffix = rowsDeleted > 0 ? `, ${rowsDeleted} stale removed` : '';
  console.log(
    `Rollup written: ${rowsUpserted} (date, feature) row${rowsUpserted === 1 ? '' : 's'}` +
      `${deletedSuffix}. ` +
      `Total: $${b.toFixed(2)} (events: $${a.toFixed(2)}; ` +
      `delta: $${Math.abs(b - a).toFixed(2)}).`
  );

  const anomalyResult = computeAndPersistAnomalies(db);
  console.log(
    `Anomalies: ${anomalyResult.active} active` +
      (anomalyResult.preserved > 0 ? `, ${anomalyResult.preserved} dismissed preserved` : '') +
      '.'
  );

  // Topic clustering: cheap when nothing has changed (it short-circuits per
  // feature on session-set fingerprint), so it's safe to run on every explicit
  // rollup. Skipped on the passive freshen path (cluster=false) so a menubar
  // poll never triggers an LLM call — see the note on runRollup's signature.
  if (shouldCluster) {
    try {
      const clusters = await recomputeClusters(db);
      if (clusters.featuresConsidered > 0) {
        console.log(
          `Clusters: ${clusters.featuresClustered} feature${clusters.featuresClustered === 1 ? '' : 's'} re-clustered, ` +
            `${clusters.featuresSkipped} unchanged` +
            (clusters.featuresFailed > 0 ? `, ${clusters.featuresFailed} failed` : '') +
            (clusters.featuresBackedOff > 0 ? `, ${clusters.featuresBackedOff} backing off` : '') +
            ` (${clusters.llmCalls} LLM call${clusters.llmCalls === 1 ? '' : 's'}).`
        );
      }
    } catch (err) {
      console.error(
        'Cluster step failed (rollup itself still wrote):',
        err instanceof Error ? err.message : err
      );
    }
  }

  return { rowsUpserted };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Build a compact commit summary for a rollup bucket. Dedupe subjects
// (sessions in the same bucket often share commits across resume points),
// cap at 5 + "N more" suffix, total ~1000 chars to stay under Notion's
// Rich Text per-block limits.
function buildCommitSummary(
  commits: Array<{ subject: string; authored_at: string }>
): string | null {
  if (commits.length === 0) return null;
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const c of commits) {
    const s = c.subject?.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    unique.push(s);
  }
  if (unique.length === 0) return null;
  const shown = unique.slice(0, 5);
  const tail = unique.length > shown.length ? ` … (+${unique.length - shown.length} more)` : '';
  let out = shown.map((s) => `• ${s}`).join('\n') + tail;
  if (out.length > 1800) out = out.slice(0, 1797) + '…';
  return out;
}
