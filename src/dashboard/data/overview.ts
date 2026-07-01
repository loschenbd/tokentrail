import type DatabaseType from 'better-sqlite3';
import {
  colorFor,
  colorForProject,
  OTHER_KEY,
  OTHER_NAME,
  OTHER_COLOR,
  UNCATEGORIZED_KEY,
  STRIPED_SENTINEL,
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
    key: string;
    name: string;
    totalUsd: number;
    pct: number;
    featureCount: number;
    sessionCount: number;
  }>;

  // NEW: project-first trend chart bands.
  projects: Array<{
    key: string;
    name: string;
    color: string;
    totalUsd: number;
    clickable: boolean;
    stackPosition: number;   // 0 = bottom (largest real project); 6 = Other
  }>;

  /**
   * Per-day breakdown.
   *
   * Invariant: `sum(days[i].bands) + days[i].unattributedTotal === days[i].total`.
   *
   * For rows where `project_key IS NOT NULL` the unattributed portion is dissolved
   * into its project's band, so `unattributedTotal` is 0 and `sum(bands) === total`.
   *
   * For legacy rows with `project_key IS NULL` and `feature_key === 'uncategorized-mainline'`
   * (old-format data before schema migration), the spend contributes to `total` and
   * `unattributedTotal` but NOT to `bands` — there is no project to attribute it to.
   * The chart renderer should use `sum(bands)` as the stack height and rely on the
   * unattributed sidebar card to surface the excluded amount.
   */
  days: Array<{
    date: string;
    total: number;
    bands: Record<string, number>;                            // projectKey -> $ for this day
    featureBands: Record<string, Record<string, number>>;    // projectKey -> featureKey|"__unattributed__" -> $
    unattributedTotal: number;
    commits: number;
    prs: number;
  }>;

  // NEW: per-project feature mix for burn-paths sub-bars (window totals).
  projectFeatureMix: Array<{
    projectKey: string;
    features: Array<{
      key: string;
      name: string;
      color: string;
      totalUsd: number;
    }>;
  }>;

  // NEW: null when no unattributed spend in the window.
  unattributed: {
    totalUsd: number;
    pctOfTrail: number;
    sparkline: Array<{ date: string; usd: number }>;
    topProjects: Array<{
      key: string;
      name: string;
      color: string;
      unattributedUsd: number;
      projectTotalUsd: number;
    }>;
  } | null;

  // LEGACY: optional for render backward compat (Task 4 removes and rewrites render).
  features?: Array<{
    key: string;
    name: string;
    color: string;
    totalUsd: number;
    clickable: boolean;
    stackPosition: number;
  }>;

  anomalies: Array<{
    id: number;
    kind: string;
    date: string;
    featureKey: string | null;
    sessionId: string | null;
    amount: number;
    reason: string;
  }>;
  recentCommits: Array<{
    sha: string;
    subject: string;
    repo: string | null;
    authoredAt: string | null;
  }>;
};

export function buildOverview(
  { db, days }: { db: DatabaseType.Database; days: number }
): OverviewVM {
  const windowDays = Math.max(1, days);
  // All date arithmetic uses the server's local time so the dashboard
  // matches the user's calendar — same machine, same timezone.
  const startExpr = `date('now', '-${windowDays - 1} days', 'localtime')`;
  const priorStartExpr = `date('now', '-${windowDays * 2 - 1} days', 'localtime')`;
  const priorEndExpr = `date('now', '-${windowDays} days', 'localtime')`;

  // --- scalar stats ---
  const totalRow = db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM feature_rollups WHERE date >= ${startExpr}`)
    .get() as { total: number };
  const priorRow = db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM feature_rollups WHERE date >= ${priorStartExpr} AND date <= ${priorEndExpr}`)
    .get() as { total: number };
  const weekRow = db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total, COALESCE(SUM(sessions_count), 0) AS sessions FROM feature_rollups WHERE date >= date('now', '-6 days', 'localtime')`)
    .get() as { total: number; sessions: number };

  const total = round2(totalRow.total);
  const prior = round2(priorRow.total);
  const deltaPct = prior > 0
    ? Math.round(((total - prior) / prior) * 100)
    : (total > 0 ? 100 : 0);

  // --- topFeatures (unchanged) ---
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

  // --- topProjects (project-first shape: key, name, totalUsd, pct, featureCount, sessionCount) ---
  const projectRows = db
    .prepare(`
      SELECT feature_key AS featureKey,
             MAX(feature_name) AS featureName,
             MAX(repo) AS repo,
             ROUND(SUM(total_cost_usd), 2) AS totalUsd,
             COALESCE(SUM(sessions_count), 0) AS sessionsCount
      FROM feature_rollups
      WHERE date >= ${startExpr}
      GROUP BY feature_key
    `)
    .all() as Array<{ featureKey: string; featureName: string; repo: string | null; totalUsd: number; sessionsCount: number }>;

  type ProjectIntermediate = { key: string; name: string; totalUsd: number; featureCount: number; sessionCount: number };
  const projectMap = new Map<string, ProjectIntermediate>();
  for (const r of projectRows) {
    const { projectKey, projectName } = bucketProject(r);
    let p = projectMap.get(projectKey);
    if (!p) {
      p = { key: projectKey, name: projectName, totalUsd: 0, featureCount: 0, sessionCount: 0 };
      projectMap.set(projectKey, p);
    }
    p.totalUsd = round2(p.totalUsd + r.totalUsd);
    p.featureCount += 1;
    p.sessionCount += r.sessionsCount;
  }
  const topProjects: OverviewVM['topProjects'] = [...projectMap.values()]
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, 12)
    .map((p) => ({
      ...p,
      pct: total > 0 ? Math.round((p.totalUsd / total) * 100) : 0,
    }));

  // --- anomalies, recentCommits (unchanged) ---
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

  // --- NEW: project-first aggregation ---
  //
  // Effective project key (effProjKey) derivation:
  //   • project_key IS NOT NULL              → use project_key
  //   • project_key IS NULL, featKey != uncat → use feature_key (each feature is its own project)
  //   • project_key IS NULL, featKey = uncat  → NULL ("unattributed-unknown"):
  //     counted in unattributedTotal but NOT placed into any named project band.

  // Project-level window totals (excludes unattributed-unknown rows).
  type ProjAggRow = { effProjKey: string; effProjName: string; total: number };
  const projAggRows = (db
    .prepare(`
      SELECT effProjKey,
             COALESCE(MAX(projKey), MAX(featName)) AS effProjName,
             ROUND(SUM(usd), 2) AS total
      FROM (
        SELECT CASE WHEN project_key IS NOT NULL THEN project_key
                    WHEN feature_key != '${UNCATEGORIZED_KEY}' THEN feature_key
               END AS effProjKey,
               project_key AS projKey,
               feature_name AS featName,
               total_cost_usd AS usd
        FROM feature_rollups
        WHERE date >= ${startExpr}
      )
      WHERE effProjKey IS NOT NULL
      GROUP BY effProjKey
      ORDER BY total DESC
    `)
    .all() as ProjAggRow[]);

  const top6 = projAggRows.slice(0, 6);
  const tailProj = projAggRows.slice(6);
  const otherProjTotal = round2(tailProj.reduce((s, r) => s + r.total, 0));
  const top6Set = new Set(top6.map((r) => r.effProjKey));
  const projAggMap = new Map(projAggRows.map((r) => [r.effProjKey, r]));

  const projects: OverviewVM['projects'] = top6.map((r, i) => ({
    key: r.effProjKey,
    name: r.effProjName,
    color: colorForProject(r.effProjKey),
    totalUsd: r.total,
    clickable: true,
    stackPosition: i,   // 0 = bottom (largest)
  }));
  const hasOther = otherProjTotal > 0;
  if (hasOther) {
    projects.push({
      key: OTHER_KEY,
      name: OTHER_NAME,
      color: OTHER_COLOR,
      totalUsd: otherProjTotal,
      clickable: false,
      stackPosition: 6,
    });
  }

  // --- Commits / PRs per day ---
  const observedRows = db
    .prepare(`SELECT date, SUM(total_cost_usd) AS total FROM feature_rollups WHERE date >= ${startExpr} GROUP BY date`)
    .all() as Array<{ date: string; total: number }>;
  const observedMap = new Map(observedRows.map((r) => [r.date, r.total]));

  const commitsByDay = db
    .prepare(`SELECT date(authored_at, 'localtime') AS d, COUNT(*) AS n FROM session_commits WHERE authored_at IS NOT NULL AND date(authored_at, 'localtime') >= ${startExpr} GROUP BY date(authored_at, 'localtime')`)
    .all() as Array<{ d: string; n: number }>;
  const commitsMap = new Map(commitsByDay.map((r) => [r.d, r.n]));

  const prsByDay = db
    .prepare(`SELECT date(merged_at, 'localtime') AS d, COUNT(*) AS n FROM session_prs WHERE merged_at IS NOT NULL AND date(merged_at, 'localtime') >= ${startExpr} GROUP BY date(merged_at, 'localtime')`)
    .all() as Array<{ d: string; n: number }>;
  const prsMap = new Map(prsByDay.map((r) => [r.d, r.n]));

  // --- Pre-build empty day rows ---
  const dayRows: OverviewVM['days'] = [];
  const dayIndex = new Map<string, OverviewVM['days'][number]>();
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = (db.prepare(`SELECT date('now', '-${i} days', 'localtime') AS d`).get() as { d: string }).d;
    const bands: Record<string, number> = {};
    // Pre-fill 0 for all real projects (brief: every project gets an entry per day).
    for (const proj of top6) bands[proj.effProjKey] = 0;
    if (hasOther) bands[OTHER_KEY] = 0;
    const row = {
      date: d,
      total: round2(observedMap.get(d) ?? 0),
      bands,
      featureBands: {} as Record<string, Record<string, number>>,
      unattributedTotal: 0,
      commits: commitsMap.get(d) ?? 0,
      prs: prsMap.get(d) ?? 0,
    };
    dayRows.push(row);
    dayIndex.set(d, row);
  }

  // --- Per-day per-project per-feature rows ---
  type PerDayRow = { date: string; effProjKey: string | null; featKey: string; featName: string; usd: number };
  const perDayRows = db
    .prepare(`
      SELECT date,
             effProjKey,
             featKey,
             MAX(featName) AS featName,
             ROUND(SUM(usd), 2) AS usd
      FROM (
        SELECT date,
               CASE WHEN project_key IS NOT NULL THEN project_key
                    WHEN feature_key != '${UNCATEGORIZED_KEY}' THEN feature_key
               END AS effProjKey,
               feature_key AS featKey,
               feature_name AS featName,
               total_cost_usd AS usd
        FROM feature_rollups
        WHERE date >= ${startExpr}
      )
      GROUP BY date, effProjKey, featKey
    `)
    .all() as PerDayRow[];

  for (const r of perDayRows) {
    const dayRow = dayIndex.get(r.date);
    if (!dayRow) continue;

    // Unattributed spend from any feature_key === UNCATEGORIZED_KEY row.
    if (r.featKey === UNCATEGORIZED_KEY) {
      dayRow.unattributedTotal = round2(dayRow.unattributedTotal + r.usd);
    }

    if (r.effProjKey === null) continue; // unattributed-unknown: skip bands/featureBands

    // Determine band key: top-6 own band; tail projects collapse into __other__.
    const bandKey = top6Set.has(r.effProjKey) ? r.effProjKey : OTHER_KEY;
    dayRow.bands[bandKey] = round2((dayRow.bands[bandKey] ?? 0) + r.usd);

    // featureBands only for top-6 real projects (skip Other).
    if (top6Set.has(r.effProjKey)) {
      const effectiveFeatKey = r.featKey === UNCATEGORIZED_KEY ? '__unattributed__' : r.featKey;
      if (!dayRow.featureBands[r.effProjKey]) dayRow.featureBands[r.effProjKey] = {};
      const projFBands = dayRow.featureBands[r.effProjKey]!;
      projFBands[effectiveFeatKey] = round2((projFBands[effectiveFeatKey] ?? 0) + r.usd);
    }
  }

  // --- projectFeatureMix: per-project feature mix, keyed by topProjects.key (bucketProject format)
  // so the sub-bar JS can match data-project-key attributes in the DOM.
  const topProjectKeySet = new Set(topProjects.map((p) => p.key));
  const pfmProjMap = new Map<string, Map<string, { name: string; totalUsd: number; color: string }>>();

  for (const r of projectRows) {
    const { projectKey } = bucketProject(r);
    if (!topProjectKeySet.has(projectKey)) continue;

    if (!pfmProjMap.has(projectKey)) pfmProjMap.set(projectKey, new Map());
    const featMap = pfmProjMap.get(projectKey)!;

    const effectiveFeatKey = r.featureKey === UNCATEGORIZED_KEY ? '__unattributed__' : r.featureKey;
    const existing = featMap.get(effectiveFeatKey);
    if (!existing) {
      featMap.set(effectiveFeatKey, {
        name: effectiveFeatKey === '__unattributed__' ? 'Unattributed' : (r.featureName || r.featureKey),
        totalUsd: r.totalUsd,
        color: effectiveFeatKey === '__unattributed__' ? STRIPED_SENTINEL : colorFor(r.featureKey),
      });
    } else {
      existing.totalUsd = round2(existing.totalUsd + r.totalUsd);
    }
  }

  const projectFeatureMix: OverviewVM['projectFeatureMix'] = topProjects.map((proj) => {
    const featMap = pfmProjMap.get(proj.key) ?? new Map();
    const features = [...featMap.entries()]
      .map(([key, data]) => ({ key, name: data.name, color: data.color, totalUsd: data.totalUsd }))
      .sort((a, b) => b.totalUsd - a.totalUsd);
    return { projectKey: proj.key, features };
  });

  // --- unattributed block ---
  const totalUnattributedUsd = round2(dayRows.reduce((s, d) => s + d.unattributedTotal, 0));
  let unattributed: OverviewVM['unattributed'] = null;
  if (totalUnattributedUsd > 0) {
    // Per-project unattributed totals (accumulated from featureBands above).
    const projUnattribMap = new Map<string, number>();
    for (const dayRow of dayRows) {
      for (const [projKey, featMap] of Object.entries(dayRow.featureBands)) {
        const ua = featMap['__unattributed__'] ?? 0;
        if (ua > 0) {
          projUnattribMap.set(projKey, round2((projUnattribMap.get(projKey) ?? 0) + ua));
        }
      }
    }

    const topUnattribProjs = [...projUnattribMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([key, unattribUsd]) => {
        const projAgg = projAggMap.get(key);
        return {
          key,
          name: projAgg?.effProjName ?? key,
          color: colorForProject(key),
          unattributedUsd: unattribUsd,
          projectTotalUsd: projAgg?.total ?? unattribUsd,
        };
      });

    unattributed = {
      totalUsd: totalUnattributedUsd,
      pctOfTrail: total > 0 ? (totalUnattributedUsd / total) * 100 : 0,
      sparkline: dayRows.map((d) => ({ date: d.date, usd: d.unattributedTotal })),
      topProjects: topUnattribProjs,
    };
  }

  return {
    windowDays,
    totalUsd: total,
    priorUsd: prior,
    deltaPct,
    weekUsd: round2(weekRow.total),
    weekSessions: weekRow.sessions,
    topFeatures,
    topProjects,
    projects,
    days: dayRows,
    projectFeatureMix,
    unattributed,
    anomalies,
    recentCommits,
  };
}

export function bucketProject(r: { featureKey: string; featureName: string; repo: string | null }): {
  projectKey: string;
  projectName: string;
} {
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
