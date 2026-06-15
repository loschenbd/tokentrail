import type DatabaseType from 'better-sqlite3';

export type OverviewVM = {
  windowDays: number;
  totalUsd: number;
  priorUsd: number;
  deltaPct: number;
  weekUsd: number;
  weekSessions: number;
  topFeatures: Array<{ featureKey: string; featureName: string; totalUsd: number }>;
  dailySeries: Array<{ date: string; total: number }>;
  anomalies: Array<{
    id: number;
    kind: string;
    date: string;
    featureKey: string | null;
    sessionId: string | null;
    amount: number;
    reason: string;
  }>;
  recentCommits: Array<{ sha: string; subject: string; repo: string | null; authoredAt: string | null }>;
};

export function buildOverview(
  db: DatabaseType.Database,
  opts: { days: number }
): OverviewVM {
  const days = Math.max(1, opts.days);
  const startExpr = `date('now', '-${days - 1} days')`;
  const priorStartExpr = `date('now', '-${days * 2 - 1} days')`;
  const priorEndExpr = `date('now', '-${days} days')`;

  const totalRow = db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM feature_rollups WHERE date >= ${startExpr}`)
    .get() as { total: number };
  const priorRow = db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM feature_rollups WHERE date >= ${priorStartExpr} AND date <= ${priorEndExpr}`)
    .get() as { total: number };
  const weekRow = db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total, COALESCE(SUM(sessions_count), 0) AS sessions FROM feature_rollups WHERE date >= date('now', '-6 days')`)
    .get() as { total: number; sessions: number };

  const topFeatures = db
    .prepare(`
      SELECT feature_key AS featureKey,
             MAX(feature_name) AS featureName,
             ROUND(SUM(total_cost_usd), 2) AS totalUsd
      FROM feature_rollups
      WHERE date >= ${startExpr}
      GROUP BY feature_key
      ORDER BY totalUsd DESC
      LIMIT 10
    `)
    .all() as OverviewVM['topFeatures'];

  // Daily series — one row per day in window, zero-filled.
  const observed = db
    .prepare(`SELECT date, SUM(total_cost_usd) AS total FROM feature_rollups WHERE date >= ${startExpr} GROUP BY date`)
    .all() as Array<{ date: string; total: number }>;
  const observedMap = new Map(observed.map((r) => [r.date, r.total]));
  const dailySeries: OverviewVM['dailySeries'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = db.prepare(`SELECT date('now', '-${i} days') AS d`).get() as { d: string };
    dailySeries.push({ date: date.d, total: observedMap.get(date.d) ?? 0 });
  }

  const anomalies = db
    .prepare(`
      SELECT id, kind, date, feature_key AS featureKey, session_id AS sessionId,
             ROUND(amount, 2) AS amount, reason
      FROM anomalies
      WHERE dismissed_at IS NULL AND date >= ${startExpr}
      ORDER BY multiplier DESC, date DESC
      LIMIT 5
    `)
    .all() as OverviewVM['anomalies'];

  const recentCommits = db
    .prepare(`
      SELECT sc.commit_sha AS sha, sc.subject,
             sp.repo,
             sc.authored_at AS authoredAt
      FROM session_commits sc
      LEFT JOIN (
        SELECT session_id, MIN(repo) AS repo
        FROM session_prs
        GROUP BY session_id
      ) sp ON sp.session_id = sc.session_id
      WHERE sc.authored_at IS NOT NULL
      ORDER BY sc.authored_at DESC
      LIMIT 10
    `)
    .all() as OverviewVM['recentCommits'];

  const total = round2(totalRow.total);
  const prior = round2(priorRow.total);
  const deltaPct = prior > 0 ? Math.round(((total - prior) / prior) * 100) : (total > 0 ? 100 : 0);

  return {
    windowDays: days,
    totalUsd: total,
    priorUsd: prior,
    deltaPct,
    weekUsd: round2(weekRow.total),
    weekSessions: weekRow.sessions,
    topFeatures,
    dailySeries,
    anomalies,
    recentCommits,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
