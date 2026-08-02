import type DatabaseType from 'better-sqlite3';
import { attribute } from './attribution.js';
import { bucketFromProjectDir } from './project-dir.js';

// A (date, feature) bucket aggregated from usage_events. This is the single
// source of truth for "usage_events → feature attribution", shared by the
// rollup writer (feature_rollups) and the source-scoped overview so the two
// can never disagree. Attribution precedence lives here and nowhere else:
// per-session override > inferred/work_units feature > repo+branch attribute()
// > project_dir bucket > untracked.
export type FeatureBucket = {
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

// Which harnesses map to which usage_events.source values. Claude Code writes
// both 'jsonl' (log tail) and 'hook' (session-end hook); Copilot writes
// 'copilot'. Cursor is NOT in usage_events (separate metered tables) and is
// handled by the scoped-rollup layer, not here.
export type UsageSource = 'claude' | 'copilot';
export const SOURCE_VALUES: Record<UsageSource, string[]> = {
  claude: ['jsonl', 'hook'],
  copilot: ['copilot'],
};

// Aggregate usage_events into (date, feature_key) buckets. Pass `source` to
// scope to a single harness; omit for all sources (the rollup writer's path).
export function aggregateFeatureBuckets(
  db: DatabaseType.Database,
  opts: { source?: UsageSource } = {}
): Map<string, FeatureBucket> {
  // Optional source filter. Interpolated from a fixed whitelist (never user
  // input), so no injection surface.
  let sourceClause = '';
  if (opts.source) {
    const vals = SOURCE_VALUES[opts.source].map((v) => `'${v}'`).join(', ');
    sourceClause = `WHERE e.source IN (${vals})`;
  }

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
       ${sourceClause}
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

  const buckets = new Map<string, FeatureBucket>();
  for (const r of rows) {
    let key: string;
    let name: string;
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
  return buckets;
}
