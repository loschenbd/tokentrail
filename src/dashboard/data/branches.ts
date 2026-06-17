import type DatabaseType from 'better-sqlite3';

export type BranchLifecycle = {
  branch: string;
  firstEventAt: string;
  lastEventAt: string;
  mergedAt: string | null;
  status: 'merged' | 'open' | 'stale';
  totalUsd: number;
  sessionCount: number;
  prNumber: number | null;
  prUrl: string | null;
  featureKey: string | null;
};

export type BranchGraphVM = {
  trunk: string;
  windowStart: string;
  windowEnd: string;
  branches: BranchLifecycle[];
  totalBranches: number;
  totalUsd: number;
};

// Parses repo: / local: / feature: project keys. Returns null for feature:
// projects since branch lifecycle is a per-repo concept; feature-bucket
// projects have no repo and therefore no branch graph.
function parseRepoFromProjectKey(projectKey: string): string | null {
  if (projectKey.startsWith('repo:')) return projectKey.slice(5);
  if (projectKey.startsWith('local:')) return 'local/' + projectKey.slice(6);
  return null;
}

export function buildBranchGraph(
  db: DatabaseType.Database,
  opts: { projectKey: string; days: number }
): BranchGraphVM | null {
  const repo = parseRepoFromProjectKey(opts.projectKey);
  if (!repo) return null;

  const days = Math.max(1, opts.days);
  const windowStart = (db
    .prepare(`SELECT date('now', '-${days - 1} days', 'localtime') AS d`)
    .get() as { d: string }).d;
  const windowEnd = (db
    .prepare(`SELECT date('now', 'localtime') AS d`)
    .get() as { d: string }).d;

  // Detect trunk: among master/main/trunk, pick whichever has the most
  // events for this repo. Default master if none seen.
  const trunkRow = db
    .prepare(
      `SELECT branch, COUNT(*) AS n FROM usage_events
        WHERE repo = ? AND branch IN ('master','main','trunk')
        GROUP BY branch ORDER BY n DESC LIMIT 1`
    )
    .get(repo) as { branch: string; n: number } | undefined;
  const trunk = trunkRow?.branch ?? 'master';

  // Per-branch lifecycle aggregate from usage_events. lastEventAt filter
  // implements the window: branches with no recent activity drop out.
  const rows = db
    .prepare(
      `SELECT branch,
              MIN(timestamp) AS firstEventAt,
              MAX(timestamp) AS lastEventAt
         FROM usage_events
        WHERE repo = ?
          AND branch IS NOT NULL
          AND branch != ''
          AND branch NOT IN ('master','main','trunk')
          AND date(timestamp, 'localtime') >= ?
        GROUP BY branch
        ORDER BY firstEventAt ASC`
    )
    .all(repo, windowStart) as Array<{
      branch: string;
      firstEventAt: string;
      lastEventAt: string;
    }>;

  if (rows.length === 0) return null;

  // PR matching: for each unique branch, find a matching session_prs row
  // by (repo, head_branch). Tolerate 'origin/' prefix on either side.
  // Prefer merged PRs; if multiple match, the lowest pr_number wins.
  const branchNames = rows.map((r) => r.branch);
  const prRows = branchNames.length === 0
    ? []
    : db
      .prepare(
        `SELECT pr.repo, pr.pr_number AS prNumber, pr.pr_url AS prUrl,
                pr.pr_state AS prState, pr.head_branch AS headBranch,
                pr.merged_at AS mergedAt
           FROM session_prs pr
          WHERE pr.repo = ?
            AND (pr.head_branch IN (SELECT value FROM json_each(?))
                 OR pr.head_branch IN (SELECT 'origin/' || value FROM json_each(?))
                 OR REPLACE(pr.head_branch, 'origin/', '') IN (SELECT value FROM json_each(?)))`
      )
      .all(
        repo,
        JSON.stringify(branchNames),
        JSON.stringify(branchNames),
        JSON.stringify(branchNames),
      ) as Array<{
        repo: string;
        prNumber: number;
        prUrl: string | null;
        prState: string | null;
        headBranch: string;
        mergedAt: string | null;
      }>;

  // Index PRs by the normalized branch name (strip origin/).
  type PrMatch = { prNumber: number; prUrl: string | null; mergedAt: string | null };
  const prByBranch = new Map<string, PrMatch>();
  for (const pr of prRows) {
    const key = pr.headBranch.replace(/^origin\//, '');
    const isMerged = pr.prState === 'merged' && pr.mergedAt !== null;
    const existing = prByBranch.get(key);
    // Prefer merged PRs over open; among same status, prefer lower pr_number.
    if (!existing) {
      prByBranch.set(key, { prNumber: pr.prNumber, prUrl: pr.prUrl, mergedAt: isMerged ? pr.mergedAt : null });
      continue;
    }
    const existingMerged = existing.mergedAt !== null;
    if (isMerged && !existingMerged) {
      prByBranch.set(key, { prNumber: pr.prNumber, prUrl: pr.prUrl, mergedAt: pr.mergedAt });
    } else if (isMerged === existingMerged && pr.prNumber < existing.prNumber) {
      prByBranch.set(key, { prNumber: pr.prNumber, prUrl: pr.prUrl, mergedAt: isMerged ? pr.mergedAt : null });
    }
  }

  // Cost + session aggregates per branch, single query for all branches.
  const aggRows = branchNames.length === 0
    ? []
    : db
      .prepare(
        `SELECT branch,
                ROUND(SUM(estimated_cost_usd), 2) AS totalUsd,
                COUNT(DISTINCT session_id) AS sessionCount
           FROM usage_events
          WHERE repo = ?
            AND branch IN (SELECT value FROM json_each(?))
          GROUP BY branch`
      )
      .all(repo, JSON.stringify(branchNames)) as Array<{
        branch: string;
        totalUsd: number;
        sessionCount: number;
      }>;
  const aggByBranch = new Map(aggRows.map((r) => [r.branch, r]));

  const STALE_THRESHOLD_MS = 7 * 86400000;
  const now = Date.now();

  // featureKey lookup: scan feature_rollups in the same window for rows
  // whose `branches` CSV contains any of our branch names. Use comma
  // sentinels to avoid substring false positives (e.g. 'feat/x' should
  // NOT match a CSV containing 'feat/xy').
  const featureKeyByBranch = new Map<string, string>();
  if (branchNames.length > 0) {
    const fkRows = db
      .prepare(
        `SELECT feature_key AS featureKey, branches
           FROM feature_rollups
          WHERE repo = ? AND date >= ?`
      )
      .all(repo, windowStart) as Array<{ featureKey: string; branches: string | null }>;
    for (const row of fkRows) {
      if (!row.branches) continue;
      const sentinel = ',' + row.branches + ',';
      for (const name of branchNames) {
        if (featureKeyByBranch.has(name)) continue;
        if (sentinel.includes(',' + name + ',')) {
          featureKeyByBranch.set(name, row.featureKey);
        }
      }
    }
  }

  const branches: BranchLifecycle[] = rows.map((r) => {
    const pr = prByBranch.get(r.branch);
    const mergedAt = pr?.mergedAt ?? null;
    const agg = aggByBranch.get(r.branch);
    const ageMs = now - new Date(r.lastEventAt).getTime();
    let status: 'merged' | 'open' | 'stale';
    if (mergedAt !== null) status = 'merged';
    else if (ageMs > STALE_THRESHOLD_MS) status = 'stale';
    else status = 'open';
    return {
      branch: r.branch,
      firstEventAt: r.firstEventAt,
      lastEventAt: r.lastEventAt,
      mergedAt,
      status,
      totalUsd: agg?.totalUsd ?? 0,
      sessionCount: agg?.sessionCount ?? 0,
      prNumber: pr?.prNumber ?? null,
      prUrl: pr?.prUrl ?? null,
      featureKey: featureKeyByBranch.get(r.branch) ?? null,
    };
  });

  const totalUsd = Math.round(branches.reduce((sum, b) => sum + b.totalUsd, 0) * 100) / 100;

  return {
    trunk,
    windowStart,
    windowEnd,
    branches,
    totalBranches: branches.length,
    totalUsd,
  };
}
