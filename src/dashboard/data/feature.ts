import type DatabaseType from 'better-sqlite3';

export type FeatureDetailVM = {
  featureKey: string;
  featureName: string;
  totalUsd: number;
  deltaPct: number;
  sessionCount: number;
  branches: string[];
  dailySeries: Array<{ date: string; total: number }>;
  sessions: Array<{
    sessionId: string;
    title: string | null;
    date: string | null;
    cost: number;
    commits: Array<{ sha: string; subject: string; repo: string | null }>;
    prs: Array<{ repo: string; prNumber: number; title: string; url: string; state: string }>;
  }>;
};

export function buildFeatureDetail(
  db: DatabaseType.Database,
  opts: { featureKey: string; days: number }
): FeatureDetailVM | null {
  const days = Math.max(1, opts.days);
  const startExpr = `date('now', '-${days - 1} days')`;
  const priorStartExpr = `date('now', '-${days * 2 - 1} days')`;
  const priorEndExpr = `date('now', '-${days} days')`;

  const head = db
    .prepare(`
      SELECT MAX(feature_name) AS featureName,
             COALESCE(SUM(total_cost_usd), 0) AS totalUsd,
             COALESCE(SUM(sessions_count), 0) AS sessionCount,
             GROUP_CONCAT(DISTINCT branches) AS branches,
             GROUP_CONCAT(DISTINCT session_ids) AS sessionIds
      FROM feature_rollups
      WHERE feature_key = @key AND date >= ${startExpr}
    `)
    .get({ key: opts.featureKey }) as {
      featureName: string | null;
      totalUsd: number;
      sessionCount: number;
      branches: string | null;
      sessionIds: string | null;
    };
  if (head.totalUsd === 0 && !head.featureName) return null;

  const prior = (db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM feature_rollups WHERE feature_key = @key AND date >= ${priorStartExpr} AND date <= ${priorEndExpr}`)
    .get({ key: opts.featureKey }) as { total: number }).total;
  const deltaPct = prior > 0 ? Math.round(((head.totalUsd - prior) / prior) * 100) : (head.totalUsd > 0 ? 100 : 0);

  const dailySeries = db
    .prepare(`SELECT date, SUM(total_cost_usd) AS total FROM feature_rollups WHERE feature_key = @key AND date >= ${startExpr} GROUP BY date ORDER BY date`)
    .all({ key: opts.featureKey }) as Array<{ date: string; total: number }>;

  const branches = (head.branches ?? '')
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  const uniqueBranches = [...new Set(branches)].sort();

  const sessionIds = uniqueSessionIds(head.sessionIds);
  const sessionRows = sessionIds.length === 0
    ? []
    : db
      .prepare(`
        SELECT s.session_id AS sessionId,
               s.title       AS title,
               date(s.first_seen_at) AS date,
               COALESCE((SELECT SUM(e.estimated_cost_usd) FROM usage_events e WHERE e.session_id = s.session_id), 0) AS cost
        FROM sessions s
        WHERE s.session_id IN (SELECT value FROM json_each(?))
        ORDER BY cost DESC
      `)
      .all(JSON.stringify(sessionIds)) as Array<{
        sessionId: string;
        title: string | null;
        date: string | null;
        cost: number;
      }>;

  const commitStmt = db.prepare(`SELECT commit_sha AS sha, subject, repo FROM session_commits WHERE session_id = ? ORDER BY authored_at`);
  const prStmt = db.prepare(`SELECT repo, pr_number AS prNumber, pr_title AS title, pr_url AS url, pr_state AS state FROM session_prs WHERE session_id = ? ORDER BY repo, pr_number`);

  const sessions = sessionRows.map((s) => ({
    sessionId: s.sessionId,
    title: s.title,
    date: s.date,
    cost: round2(s.cost),
    commits: commitStmt.all(s.sessionId) as FeatureDetailVM['sessions'][number]['commits'],
    prs: prStmt.all(s.sessionId) as FeatureDetailVM['sessions'][number]['prs'],
  }));

  return {
    featureKey: opts.featureKey,
    featureName: head.featureName ?? opts.featureKey,
    totalUsd: round2(head.totalUsd),
    deltaPct,
    sessionCount: head.sessionCount,
    branches: uniqueBranches,
    dailySeries,
    sessions,
  };
}

function uniqueSessionIds(csvOrNull: string | null): string[] {
  if (!csvOrNull) return [];
  const set = new Set<string>();
  for (const chunk of csvOrNull.split(',')) {
    const s = chunk.trim();
    if (s) set.add(s);
  }
  return [...set];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
