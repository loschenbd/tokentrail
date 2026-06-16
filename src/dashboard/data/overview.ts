import type DatabaseType from 'better-sqlite3';

export type OverviewVM = {
  windowDays: number;
  totalUsd: number;
  priorUsd: number;
  deltaPct: number;
  weekUsd: number;
  weekSessions: number;
  topFeatures: Array<{ featureKey: string; featureName: string; totalUsd: number }>;
  topProjects: Array<{
    projectKey: string;
    projectName: string;
    totalUsd: number;
    features: Array<{ featureKey: string; featureName: string; totalUsd: number }>;
  }>;
  dailySeries: Array<{ date: string; total: number; commits: number; prs: number }>;
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
  // All date arithmetic uses the server's local time so the dashboard
  // matches the user's calendar — same machine, same timezone.
  const startExpr = `date('now', '-${days - 1} days', 'localtime')`;
  const priorStartExpr = `date('now', '-${days * 2 - 1} days', 'localtime')`;
  const priorEndExpr = `date('now', '-${days} days', 'localtime')`;

  const totalRow = db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM feature_rollups WHERE date >= ${startExpr}`)
    .get() as { total: number };
  const priorRow = db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM feature_rollups WHERE date >= ${priorStartExpr} AND date <= ${priorEndExpr}`)
    .get() as { total: number };
  const weekRow = db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total, COALESCE(SUM(sessions_count), 0) AS sessions FROM feature_rollups WHERE date >= date('now', '-6 days', 'localtime')`)
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

  // Project grouping: a project is the repo (e.g. loschenbd/archi → "archi")
  // when a feature has one, otherwise the feature itself is its own project
  // (so "outside:" buckets like Anamnesis stand on their own). MAX(repo)
  // collapses the CSV reasonably for single-repo features; mixed-repo
  // features get the lexicographically-first repo.
  const projectRows = db
    .prepare(`
      SELECT feature_key AS featureKey,
             MAX(feature_name) AS featureName,
             MAX(repo) AS repo,
             ROUND(SUM(total_cost_usd), 2) AS totalUsd
      FROM feature_rollups
      WHERE date >= ${startExpr}
      GROUP BY feature_key
    `)
    .all() as Array<{ featureKey: string; featureName: string; repo: string | null; totalUsd: number }>;

  const projectMap = new Map<string, OverviewVM['topProjects'][number]>();
  for (const r of projectRows) {
    const { projectKey, projectName } = bucketProject(r);
    let p = projectMap.get(projectKey);
    if (!p) {
      p = { projectKey, projectName, totalUsd: 0, features: [] };
      projectMap.set(projectKey, p);
    }
    p.totalUsd = round2(p.totalUsd + r.totalUsd);
    p.features.push({
      featureKey: r.featureKey,
      featureName: r.featureName,
      totalUsd: r.totalUsd,
    });
  }
  const topProjects = [...projectMap.values()]
    .map((p) => ({
      ...p,
      features: p.features.sort((a, b) => b.totalUsd - a.totalUsd),
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, 12);

  // Daily series — one row per day in window, zero-filled.
  const observed = db
    .prepare(`SELECT date, SUM(total_cost_usd) AS total FROM feature_rollups WHERE date >= ${startExpr} GROUP BY date`)
    .all() as Array<{ date: string; total: number }>;
  const observedMap = new Map(observed.map((r) => [r.date, r.total]));
  const commitsByDay = db
    .prepare(`SELECT date(authored_at, 'localtime') AS d, COUNT(*) AS n FROM session_commits WHERE authored_at IS NOT NULL AND date(authored_at, 'localtime') >= ${startExpr} GROUP BY date(authored_at, 'localtime')`)
    .all() as Array<{ d: string; n: number }>;
  const commitsMap = new Map(commitsByDay.map((r) => [r.d, r.n]));
  const prsByDay = db
    .prepare(`SELECT date(merged_at, 'localtime') AS d, COUNT(*) AS n FROM session_prs WHERE merged_at IS NOT NULL AND date(merged_at, 'localtime') >= ${startExpr} GROUP BY date(merged_at, 'localtime')`)
    .all() as Array<{ d: string; n: number }>;
  const prsMap = new Map(prsByDay.map((r) => [r.d, r.n]));
  const dailySeries: OverviewVM['dailySeries'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = db.prepare(`SELECT date('now', '-${i} days', 'localtime') AS d`).get() as { d: string };
    dailySeries.push({
      date: date.d,
      total: observedMap.get(date.d) ?? 0,
      commits: commitsMap.get(date.d) ?? 0,
      prs: prsMap.get(date.d) ?? 0,
    });
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
      SELECT commit_sha AS sha, subject, repo, authored_at AS authoredAt
      FROM session_commits
      WHERE authored_at IS NOT NULL
      ORDER BY authored_at DESC
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
    topProjects,
    dailySeries,
    anomalies,
    recentCommits,
  };
}

function bucketProject(r: { featureKey: string; featureName: string; repo: string | null }): { projectKey: string; projectName: string } {
  if (r.repo && r.repo.trim()) {
    // CSV-resilient: take the first non-empty repo string.
    const firstRepo = r.repo.split(',').map((s) => s.trim()).find((s) => s.length > 0) ?? r.repo;
    const owner = firstRepo.includes('/') ? firstRepo.split('/')[0] : '';
    const name = firstRepo.split('/').pop() ?? firstRepo;
    // local/<basename> reads better as just the basename; GitHub-style
    // slugs keep the owner stripped so the eye lands on the project.
    return {
      projectKey: owner === 'local' ? `local:${name}` : `repo:${firstRepo}`,
      projectName: name,
    };
  }
  // No repo: the feature itself is its own project. Strip the "outside:"
  // prefix from the key so the URL stays human-readable.
  return {
    projectKey: `feature:${r.featureKey}`,
    projectName: r.featureName || r.featureKey,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
