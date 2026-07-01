import type DatabaseType from 'better-sqlite3';
import {
  colorFor,
  OTHER_KEY,
  OTHER_NAME,
  OTHER_COLOR,
  UNCATEGORIZED_KEY,
} from '../lib/feature-colors.js';

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
  features: Array<{
    key: string;
    name: string;
    color: string;
    totalUsd: number;
    clickable: boolean;
    stackPosition: number;
  }>;
  days: Array<{
    date: string;
    total: number;
    bands: Record<string, number>;
    commits: number;
    prs: number;
  }>;
  anomalies: Array<{ id: number; kind: string; date: string; featureKey: string | null; sessionId: string | null; amount: number; reason: string }>;
  recentCommits: Array<{ sha: string; subject: string; repo: string | null; authoredAt: string | null }>;
};

export function buildOverview(
  db: DatabaseType.Database,
  opts: { days: number }
): OverviewVM {
  const windowDays = Math.max(1, opts.days);
  // All date arithmetic uses the server's local time so the dashboard
  // matches the user's calendar — same machine, same timezone.
  const startExpr = `date('now', '-${windowDays - 1} days', 'localtime')`;
  const priorStartExpr = `date('now', '-${windowDays * 2 - 1} days', 'localtime')`;
  const priorEndExpr = `date('now', '-${windowDays} days', 'localtime')`;

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

  // Daily totals / commits / PRs — shared by both old dailySeries and new days array.
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

  // --- features array (top 6 + Other + uncategorized-mainline) ---
  type FeatureAgg = { key: string; name: string; totalUsd: number };
  const allFeatureRows = db
    .prepare(`
      SELECT feature_key AS key,
             MAX(feature_name) AS name,
             ROUND(SUM(total_cost_usd), 2) AS totalUsd
      FROM feature_rollups
      WHERE date >= ${startExpr}
      GROUP BY feature_key
      ORDER BY totalUsd DESC
    `)
    .all() as FeatureAgg[];

  const uncat = allFeatureRows.find((f) => f.key === UNCATEGORIZED_KEY);
  const realFeatures = allFeatureRows.filter((f) => f.key !== UNCATEGORIZED_KEY);
  const top6 = realFeatures.slice(0, 6);
  const tail = realFeatures.slice(6);
  const otherTotal = round2(tail.reduce((s, f) => s + f.totalUsd, 0));

  // Built bottom-up in stack order (largest real first → Other → uncategorized).
  // The render layer re-sorts for the legend.
  // `stackPosition` is assigned bottom-up: largest real feature = 0;
  // uncategorized = highest position.
  const features: OverviewVM['features'] = [];
  // Stack from bottom (largest real first), increasing position.
  top6.forEach((f, i) => {
    features.push({
      key: f.key,
      name: f.name,
      color: colorFor(f.key),
      totalUsd: f.totalUsd,
      clickable: true,
      stackPosition: i,                  // 0 = bottom
    });
  });
  let nextPos = top6.length;
  if (otherTotal > 0) {
    features.push({
      key: OTHER_KEY,
      name: OTHER_NAME,
      color: OTHER_COLOR,
      totalUsd: otherTotal,
      clickable: false,
      stackPosition: nextPos++,
    });
  }
  if (uncat) {
    features.push({
      key: UNCATEGORIZED_KEY,
      name: uncat.name || UNCATEGORIZED_KEY,
      color: colorFor(UNCATEGORIZED_KEY),
      totalUsd: uncat.totalUsd,
      clickable: false,
      stackPosition: nextPos++,
    });
  }

  // --- days array: per-day per-feature breakdown ---
  const includedKeys = new Set(features.map((f) => f.key));
  const perDayRows = db
    .prepare(`
      SELECT date,
             feature_key AS featureKey,
             ROUND(SUM(total_cost_usd), 2) AS usd
      FROM feature_rollups
      WHERE date >= ${startExpr}
      GROUP BY date, feature_key
    `)
    .all() as Array<{ date: string; featureKey: string; usd: number }>;

  // Pre-build empty day rows (zero-filled).
  const days: OverviewVM['days'] = [];
  const dayIndex = new Map<string, OverviewVM['days'][number]>();
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = (db.prepare(`SELECT date('now', '-${i} days', 'localtime') AS d`).get() as { d: string }).d;
    const row = {
      date: d,
      total: observedMap.get(d) ?? 0,
      bands: {} as Record<string, number>,
      commits: commitsMap.get(d) ?? 0,
      prs: prsMap.get(d) ?? 0,
    };
    days.push(row);
    dayIndex.set(d, row);
  }

  for (const r of perDayRows) {
    const row = dayIndex.get(r.date);
    if (!row) continue;
    const key = includedKeys.has(r.featureKey) ? r.featureKey : OTHER_KEY;
    row.bands[key] = round2((row.bands[key] ?? 0) + r.usd);
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
    windowDays: windowDays,
    totalUsd: total,
    priorUsd: prior,
    deltaPct,
    weekUsd: round2(weekRow.total),
    weekSessions: weekRow.sessions,
    topFeatures,
    topProjects,
    features,
    days,
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
