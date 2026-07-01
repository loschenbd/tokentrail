import { randomUUID } from 'node:crypto';
import { getDb } from '../db/db.js';
import { attribute } from '../lib/attribution.js';
import { bucketFromProjectDir } from '../lib/project-dir.js';
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
// Re-running is safe: rollups are upserted by (date, feature_key) and
// updated_at is stamped each run.
export async function runRollup(): Promise<RollupSummary> {
  const db = getDb();

  // Pull aggregated rows. Bucket events by their LOCAL date so the daily
  // series matches the user's calendar (events at 11pm don't slip into
  // "tomorrow" the way a UTC date() would).
  const rows = db
    .prepare(
      `SELECT
         date(e.timestamp, 'localtime')          AS date,
         COALESCE(e.repo, '')                    AS repo,
         COALESCE(e.branch, '')                  AS branch,
         COALESCE(e.project_dir, '')             AS project_dir,
         COALESCE(e.inferred_feature_key, w.feature_key)   AS feature_key,
         COALESCE(e.inferred_feature_name, w.feature_name) AS feature_name,
         s.feature_override                       AS override_key,
         s.feature_override_name                  AS override_name,
         SUM(e.input_tokens)                      AS in_tokens,
         SUM(e.output_tokens)                     AS out_tokens,
         SUM(e.estimated_cost_usd)                AS cost,
         COUNT(DISTINCT e.session_id)             AS sessions,
         GROUP_CONCAT(DISTINCT e.session_id)       AS session_ids
       FROM usage_events e
       LEFT JOIN work_units w
         ON w.repo = e.repo AND w.branch = e.branch
       LEFT JOIN sessions s
         ON s.session_id = e.session_id
       GROUP BY date(e.timestamp, 'localtime'), e.repo, e.branch, e.project_dir,
                COALESCE(e.inferred_feature_key, w.feature_key),
                COALESCE(e.inferred_feature_name, w.feature_name),
                s.feature_override, s.feature_override_name`
    )
    .all() as Array<{
    date: string;
    repo: string;
    branch: string;
    project_dir: string;
    feature_key: string | null;
    feature_name: string | null;
    override_key: string | null;
    override_name: string | null;
    in_tokens: number;
    out_tokens: number;
    cost: number;
    sessions: number;
    session_ids: string | null;
  }>;

  // Bucket by (date, feature_key). A feature can pull from multiple
  // (repo, branch) pairs in the same day.
  type Bucket = {
    date: string;
    featureKey: string;
    featureName: string;
    repos: Set<string>;
    branches: Set<string>;
    sessionIds: Set<string>;
    inTokens: number;
    outTokens: number;
    cost: number;
  };

  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    let key: string | null;
    let name: string | null;
    // Per-session override beats everything else. This is how you label
    // sessions that don't map cleanly to repo+branch — e.g. exploratory
    // work outside any git repo, or a feature you didn't branch for.
    if (r.override_key) {
      key = r.override_key;
      name = r.override_name ?? r.override_key;
    } else if (r.feature_key && r.feature_name) {
      key = r.feature_key;
      name = r.feature_name;
    } else if (r.branch && r.repo) {
      const a = attribute({ repo: r.repo, branch: r.branch });
      key = a.featureKey;
      name = a.featureName;
    } else if (r.project_dir) {
      const b = bucketFromProjectDir(r.project_dir);
      key = b.featureKey;
      name = b.featureName;
    } else {
      key = 'untracked';
      name = 'Untracked sessions';
    }
    const id = `${r.date}::${key}`;
    let b = buckets.get(id);
    if (!b) {
      b = {
        date: r.date,
        featureKey: key,
        featureName: name,
        repos: new Set(),
        branches: new Set(),
        sessionIds: new Set(),
        inTokens: 0,
        outTokens: 0,
        cost: 0,
      };
      buckets.set(id, b);
    }
    if (r.repo) b.repos.add(r.repo);
    if (r.branch) b.branches.add(r.branch);
    if (r.session_ids) {
      for (const sid of r.session_ids.split(',')) {
        if (sid) b.sessionIds.add(sid);
      }
    }
    b.inTokens += r.in_tokens ?? 0;
    b.outTokens += r.out_tokens ?? 0;
    b.cost += r.cost ?? 0;
  }

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

  const allExisting = db
    .prepare(`SELECT id, date, feature_key FROM feature_rollups`)
    .all() as Array<{ id: string; date: string; feature_key: string }>;
  const deleteStmt = db.prepare(`DELETE FROM feature_rollups WHERE id = ?`);

  let rowsUpserted = 0;
  let rowsDeleted = 0;
  const tx = db.transaction(() => {
    for (const existing of allExisting) {
      if (!aliveKeys.has(`${existing.date}::${existing.feature_key}`)) {
        deleteStmt.run(existing.id);
        rowsDeleted++;
      }
    }
    for (const b of buckets.values()) {
      const reposCsv = [...b.repos].sort().join(',');
      const branchesCsv = [...b.branches].sort().join(',');
      const commitSummary = buildCommitSummary(
        commitsForSessions.all(JSON.stringify([...b.sessionIds])) as Array<{
          subject: string;
          authored_at: string;
        }>
      );
      upsert.run({
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
      rowsUpserted++;
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
  // feature on session-set fingerprint), so it's safe to run on every rollup.
  try {
    const clusters = await recomputeClusters(db);
    if (clusters.featuresConsidered > 0) {
      console.log(
        `Clusters: ${clusters.featuresClustered} feature${clusters.featuresClustered === 1 ? '' : 's'} re-clustered, ` +
          `${clusters.featuresSkipped} unchanged` +
          (clusters.featuresFailed > 0 ? `, ${clusters.featuresFailed} failed` : '') +
          ` (${clusters.llmCalls} LLM call${clusters.llmCalls === 1 ? '' : 's'}).`
      );
    }
  } catch (err) {
    console.error(
      'Cluster step failed (rollup itself still wrote):',
      err instanceof Error ? err.message : err
    );
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
