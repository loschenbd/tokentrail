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

  // Stub remaining fields — later tasks populate PR data, status,
  // featureKey, cost rollup, and session count.
  const branches: BranchLifecycle[] = rows.map((r) => ({
    branch: r.branch,
    firstEventAt: r.firstEventAt,
    lastEventAt: r.lastEventAt,
    mergedAt: null,
    status: 'open' as const,
    totalUsd: 0,
    sessionCount: 0,
    prNumber: null,
    prUrl: null,
    featureKey: null,
  }));

  return {
    trunk,
    windowStart,
    windowEnd,
    branches,
    totalBranches: branches.length,
    totalUsd: 0,
  };
}
