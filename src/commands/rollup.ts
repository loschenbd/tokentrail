import { randomUUID } from 'node:crypto';
import { getDb } from '../db/db.js';
import { attribute } from '../lib/attribution.js';

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

  // Pull aggregated rows. Use date() on timestamp so SQLite returns
  // ISO-yyyy-mm-dd local-to-the-event date.
  const rows = db
    .prepare(
      `SELECT
         date(e.timestamp)                       AS date,
         COALESCE(e.repo, '')                    AS repo,
         COALESCE(e.branch, '')                  AS branch,
         w.feature_key                            AS feature_key,
         w.feature_name                           AS feature_name,
         SUM(e.input_tokens)                      AS in_tokens,
         SUM(e.output_tokens)                     AS out_tokens,
         SUM(e.estimated_cost_usd)                AS cost,
         COUNT(DISTINCT e.session_id)             AS sessions
       FROM usage_events e
       LEFT JOIN work_units w
         ON w.repo = e.repo AND w.branch = e.branch
       GROUP BY date(e.timestamp), e.repo, e.branch, w.feature_key, w.feature_name`
    )
    .all() as Array<{
    date: string;
    repo: string;
    branch: string;
    feature_key: string | null;
    feature_name: string | null;
    in_tokens: number;
    out_tokens: number;
    cost: number;
    sessions: number;
  }>;

  // Bucket by (date, feature_key). A feature can pull from multiple
  // (repo, branch) pairs in the same day.
  type Bucket = {
    date: string;
    featureKey: string;
    featureName: string;
    repos: Set<string>;
    branches: Set<string>;
    inTokens: number;
    outTokens: number;
    cost: number;
    sessions: number;
  };

  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    let key = r.feature_key;
    let name = r.feature_name;
    if (!key || !name) {
      // No work_units row — synthesize attribution so usage isn't dropped.
      // Untracked/unknown branches still get a row.
      if (r.branch && r.repo) {
        const a = attribute({ repo: r.repo, branch: r.branch });
        key = a.featureKey;
        name = a.featureName;
      } else {
        key = 'untracked';
        name = 'Untracked sessions';
      }
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
        inTokens: 0,
        outTokens: 0,
        cost: 0,
        sessions: 0,
      };
      buckets.set(id, b);
    }
    if (r.repo) b.repos.add(r.repo);
    if (r.branch) b.branches.add(r.branch);
    b.inTokens += r.in_tokens ?? 0;
    b.outTokens += r.out_tokens ?? 0;
    b.cost += r.cost ?? 0;
    // Approximation: sessions can be shared across repo/branch splits within
    // a day. We sum here; close enough for a rollup-level "sessions touched"
    // signal. If high precision needed, swap to a second query.
    b.sessions += r.sessions ?? 0;
  }

  const upsert = db.prepare(`
    INSERT INTO feature_rollups (
      id, date, feature_key, feature_name, repo, branches,
      total_input_tokens, total_output_tokens, total_cost_usd, sessions_count
    ) VALUES (
      @id, @date, @feature_key, @feature_name, @repo, @branches,
      @total_input_tokens, @total_output_tokens, @total_cost_usd, @sessions_count
    )
    ON CONFLICT(date, feature_key) DO UPDATE SET
      feature_name        = excluded.feature_name,
      repo                = excluded.repo,
      branches            = excluded.branches,
      total_input_tokens  = excluded.total_input_tokens,
      total_output_tokens = excluded.total_output_tokens,
      total_cost_usd      = excluded.total_cost_usd,
      sessions_count      = excluded.sessions_count,
      updated_at          = datetime('now')
  `);

  let rowsUpserted = 0;
  const tx = db.transaction(() => {
    for (const b of buckets.values()) {
      const reposCsv = [...b.repos].sort().join(',');
      const branchesCsv = [...b.branches].sort().join(',');
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
        sessions_count: b.sessions,
      });
      rowsUpserted++;
    }
  });
  tx();

  // Verification: rollup total should equal event-level total.
  const a = (db.prepare(`SELECT SUM(estimated_cost_usd) AS s FROM usage_events`).get() as { s: number | null }).s ?? 0;
  const b = (db.prepare(`SELECT SUM(total_cost_usd) AS s FROM feature_rollups`).get() as { s: number | null }).s ?? 0;
  console.log(
    `Rollup written: ${rowsUpserted} (date, feature) row${rowsUpserted === 1 ? '' : 's'}. ` +
      `Total: $${b.toFixed(2)} (events: $${a.toFixed(2)}; ` +
      `delta: $${Math.abs(b - a).toFixed(2)}).`
  );

  return { rowsUpserted };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
