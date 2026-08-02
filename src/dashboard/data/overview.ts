import type DatabaseType from 'better-sqlite3';
import { bucketProject } from '../lib/project-bucket.js';
import { getConfig } from '../../lib/config.js';
import { buildBudget, type BudgetReport } from './budget.js';
import {
  hiddenFeatureKeys,
  rollupVisiblePredicate,
  repoVisiblePredicate,
  matchesHiddenPattern,
  shownAnomalyPredicate,
} from '../lib/hidden-projects.js';
import {
  colorFor,
  colorForProject,
  resolveProjectColors,
  shadeForFeature,
  OTHER_KEY,
  OTHER_NAME,
  OTHER_COLOR,
  UNCATEGORIZED_KEY,
  STRIPED_SENTINEL,
} from '../lib/feature-colors.js';

// Re-exported for existing importers (today.ts, api.ts, tests); the
// implementation moved to lib/ so hidden-projects can use it cycle-free.
export { bucketProject };

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
    color: string;
    totalUsd: number;
    pct: number;
    featureCount: number;
    sessionCount: number;
  }>;

  // Collision-free color map used by both trend chart and burn paths so
  // sibling projects on the same view never share a hue.
  projectColors: Record<string, string>;

  // NEW: project-first trend chart bands.
  projects: Array<{
    key: string;
    name: string;
    color: string;
    totalUsd: number;
    clickable: boolean;
    stackPosition: number;   // 0 = bottom (largest real project); 6 = Other
  }>;

  // Tail projects (rank 7+) collapsed into the Other band; the legend
  // renders these as an expandable sub-list. Sorted descending by spend.
  otherProjects: Array<{ key: string; name: string; totalUsd: number }>;

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

  // Cycle-to-date burn rate vs the user's configured monthly budget. Null
  // when no budget (global or per-source) is configured — the sidebar card
  // falls back to a "set a budget" prompt.
  budget: BudgetReport | null;
};

export function buildOverview(
  { db, days, hidden = [], rollupTable = 'feature_rollups' }:
    { db: DatabaseType.Database; days: number; hidden?: string[]; rollupTable?: string }
): OverviewVM {
  const windowDays = Math.max(1, days);
  // Windowed aggregates read from `rollupTable`. For the blended default this
  // is `feature_rollups`; a source-scoped view passes the name of a temp table
  // holding just that harness's rollup rows (see scoped-rollup.ts). Table names
  // can't be bound params, so guard against anything but a bare identifier —
  // the value comes only from our own whitelist, never user input.
  const T = safeTable(rollupTable);
  // All date arithmetic uses the server's local time so the dashboard
  // matches the user's calendar — same machine, same timezone.
  const startExpr = `date('now', '-${windowDays - 1} days', 'localtime')`;
  const priorStartExpr = `date('now', '-${windowDays * 2 - 1} days', 'localtime')`;
  const priorEndExpr = `date('now', '-${windowDays} days', 'localtime')`;

  // settings.hiddenProjects display filter. Applied to every rollup-derived
  // aggregate so totals, bands, and the unattributed invariant stay
  // consistent with each other — but NOT to canonicalProjectColors (color
  // slots stay stable when hiding toggles).
  const hiddenKeys = hiddenFeatureKeys(db, hidden);
  const visibleSql = rollupVisiblePredicate(hiddenKeys);
  const repoVisibleSql = repoVisiblePredicate(hidden);

  // --- scalar stats ---
  const totalRow = db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM ${T} WHERE date >= ${startExpr} AND ${visibleSql}`)
    .get() as { total: number };
  const priorRow = db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM ${T} WHERE date >= ${priorStartExpr} AND date <= ${priorEndExpr} AND ${visibleSql}`)
    .get() as { total: number };
  const weekRow = db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total, COALESCE(SUM(sessions_count), 0) AS sessions FROM ${T} WHERE date >= date('now', '-6 days', 'localtime') AND ${visibleSql}`)
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
      FROM ${T}
      WHERE date >= ${startExpr} AND ${visibleSql}
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
      FROM ${T}
      WHERE date >= ${startExpr} AND ${visibleSql}
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
  const topProjectsRaw = [...projectMap.values()]
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, 12);

  // Canonical collision-free color map, keyed by projectKey. Resolved over
  // EVERY project in the ledger (not the windowed top 12) so a project keeps
  // one color across windows, pages, the API, and the menubar plugin.
  // Hidden projects participate in resolution (their color slot stays
  // claimed, so hiding never reshuffles other projects' hues) but are
  // stripped from the emitted map — it's serialized into page HTML and the
  // API payload, and a hidden project shouldn't be visible in view-source.
  const projectColors = canonicalProjectColors(db);
  if (hidden.length > 0) {
    for (const key of Object.keys(projectColors)) {
      if (matchesHiddenPattern(hidden, key)) delete projectColors[key];
    }
  }

  const topProjects: OverviewVM['topProjects'] = topProjectsRaw.map((p) => ({
    ...p,
    pct: total > 0 ? Math.round((p.totalUsd / total) * 100) : 0,
    color: projectColors[p.key]!,
  }));

  // --- anomalies, recentCommits ---
  // Anomalies are computed from the blended feature_rollups and carry no
  // source tag, so they can't be honestly scoped to one harness — showing the
  // global list on a source-scoped view (e.g. a $0 Copilot page listing a $729
  // Claude spike) would mislead. Suppress them off the blended default; the
  // panel falls back to its "nothing worth a look" state. Recent commits stay:
  // a commit isn't attributable to a harness, so it's fine on every scope.
  const scoped = T !== 'feature_rollups';
  const anomalies = scoped
    ? ([] as OverviewVM['anomalies'])
    : (db
        .prepare(`
      SELECT id, kind, date, feature_key AS featureKey, session_id AS sessionId,
             ROUND(amount, 2) AS amount, reason
      FROM anomalies
      WHERE ${shownAnomalyPredicate(hiddenKeys)} AND date >= ${startExpr}
      ORDER BY multiplier DESC, date DESC
      LIMIT 5
    `)
        .all() as OverviewVM['anomalies']);

  const recentCommits = db
    .prepare(`
      SELECT commit_sha AS sha, subject, repo, authored_at AS authoredAt
      FROM session_commits
      WHERE authored_at IS NOT NULL AND ${repoVisibleSql}
      ORDER BY authored_at DESC
      LIMIT 10
    `)
    .all() as OverviewVM['recentCommits'];

  // --- NEW: project-first aggregation via TS-side bucketProject() ---
  //
  // Query raw rollup columns (no SQL CASE). Apply bucketProject() in TypeScript
  // so chart bands and topProjects burn-paths share the same key namespace.
  // UNCATEGORIZED_KEY rows are routed to the unattributed block, never to named bands.

  type RawProjRow = { featureKey: string; featureName: string; repo: string | null; totalUsd: number };
  const rawProjRows = db
    .prepare(`
      SELECT feature_key AS featureKey,
             MAX(feature_name) AS featureName,
             MAX(repo) AS repo,
             ROUND(SUM(total_cost_usd), 2) AS totalUsd
      FROM ${T}
      WHERE date >= ${startExpr} AND ${visibleSql}
      GROUP BY feature_key
    `)
    .all() as RawProjRow[];

  // Group non-UNCATEGORIZED rows by bucketProject output.
  type ProjAgg = { projKey: string; projName: string; total: number };
  const projAggByKey = new Map<string, ProjAgg>();
  for (const r of rawProjRows) {
    if (r.featureKey === UNCATEGORIZED_KEY) continue;
    const { projectKey, projectName } = bucketProject(r);
    const existing = projAggByKey.get(projectKey);
    if (!existing) {
      projAggByKey.set(projectKey, { projKey: projectKey, projName: projectName, total: r.totalUsd });
    } else {
      existing.total = round2(existing.total + r.totalUsd);
    }
  }
  const projAggRows: ProjAgg[] = [...projAggByKey.values()].sort((a, b) => b.total - a.total);

  const top6 = projAggRows.slice(0, 6);
  const tailProj = projAggRows.slice(6);
  const otherProjTotal = round2(tailProj.reduce((s, r) => s + r.total, 0));
  const top6Set = new Set(top6.map((r) => r.projKey));

  const projects: OverviewVM['projects'] = top6.map((r, i) => ({
    key: r.projKey,
    name: r.projName,
    color: projectColors[r.projKey] ?? colorForProject(r.projKey),
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

  const otherProjects: OverviewVM['otherProjects'] = tailProj.map((r) => ({
    key: r.projKey,
    name: r.projName,
    totalUsd: r.total,
  }));

  // --- Commits / PRs per day ---
  const observedRows = db
    .prepare(`SELECT date, SUM(total_cost_usd) AS total FROM ${T} WHERE date >= ${startExpr} AND ${visibleSql} GROUP BY date`)
    .all() as Array<{ date: string; total: number }>;
  const observedMap = new Map(observedRows.map((r) => [r.date, r.total]));

  const commitsByDay = db
    .prepare(`SELECT date(authored_at, 'localtime') AS d, COUNT(*) AS n FROM session_commits WHERE authored_at IS NOT NULL AND date(authored_at, 'localtime') >= ${startExpr} AND ${repoVisibleSql} GROUP BY date(authored_at, 'localtime')`)
    .all() as Array<{ d: string; n: number }>;
  const commitsMap = new Map(commitsByDay.map((r) => [r.d, r.n]));

  const prsByDay = db
    .prepare(`SELECT date(merged_at, 'localtime') AS d, COUNT(*) AS n FROM session_prs WHERE merged_at IS NOT NULL AND date(merged_at, 'localtime') >= ${startExpr} AND ${repoVisibleSql} GROUP BY date(merged_at, 'localtime')`)
    .all() as Array<{ d: string; n: number }>;
  const prsMap = new Map(prsByDay.map((r) => [r.d, r.n]));

  // --- Pre-build empty day rows ---
  const dayRows: OverviewVM['days'] = [];
  const dayIndex = new Map<string, OverviewVM['days'][number]>();
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = (db.prepare(`SELECT date('now', '-${i} days', 'localtime') AS d`).get() as { d: string }).d;
    const bands: Record<string, number> = {};
    // Pre-fill 0 for all real projects (every project gets an entry per day).
    for (const proj of top6) bands[proj.projKey] = 0;
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

  // --- Per-day per-feature rows (raw; bucketProject applied in TS) ---
  type PerDayRawRow = { date: string; featureKey: string; featureName: string; repo: string | null; usd: number };
  const perDayRawRows = db
    .prepare(`
      SELECT date,
             feature_key AS featureKey,
             MAX(feature_name) AS featureName,
             MAX(repo) AS repo,
             ROUND(SUM(total_cost_usd), 2) AS usd
      FROM ${T}
      WHERE date >= ${startExpr} AND ${visibleSql}
      GROUP BY date, feature_key
    `)
    .all() as PerDayRawRow[];

  // Accumulate per-project unattributed totals across ALL projects (not just top-6).
  const allProjUnattribMap = new Map<string, number>();
  // Build project name lookup from all bucketProject calls (for unattributed card).
  const projNameMap = new Map<string, string>();

  for (const r of perDayRawRows) {
    const dayRow = dayIndex.get(r.date);
    if (!dayRow) continue;

    if (r.featureKey === UNCATEGORIZED_KEY) {
      // Unattributed spend: always goes to unattributedTotal, never to bands.
      dayRow.unattributedTotal = round2(dayRow.unattributedTotal + r.usd);
      // Track per-project unattributed if we can derive a project from repo.
      if (r.repo && r.repo.trim()) {
        const { projectKey, projectName } = bucketProject(r);
        projNameMap.set(projectKey, projectName);
        allProjUnattribMap.set(projectKey, round2((allProjUnattribMap.get(projectKey) ?? 0) + r.usd));
        // featureBands records the unattributed drilldown within the project.
        if (!dayRow.featureBands[projectKey]) dayRow.featureBands[projectKey] = {};
        const pFBands = dayRow.featureBands[projectKey]!;
        pFBands['__unattributed__'] = round2((pFBands['__unattributed__'] ?? 0) + r.usd);
      }
      continue;
    }

    const { projectKey, projectName } = bucketProject(r);
    projNameMap.set(projectKey, projectName);

    // Determine band key: top-6 own band; tail projects collapse into __other__.
    const bandKey = top6Set.has(projectKey) ? projectKey : OTHER_KEY;
    dayRow.bands[bandKey] = round2((dayRow.bands[bandKey] ?? 0) + r.usd);

    // featureBands only for top-6 real projects (skip Other).
    if (top6Set.has(projectKey)) {
      if (!dayRow.featureBands[projectKey]) dayRow.featureBands[projectKey] = {};
      const pFBands = dayRow.featureBands[projectKey]!;
      pFBands[r.featureKey] = round2((pFBands[r.featureKey] ?? 0) + r.usd);
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
        color: effectiveFeatKey === '__unattributed__' ? STRIPED_SENTINEL : shadeForFeature(projectColors[projectKey] ?? colorForProject(projectKey), r.featureKey),
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
    // allProjUnattribMap already accumulated across ALL projects during the perDayRawRows loop.
    const topUnattribProjs = [...allProjUnattribMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([key, unattribUsd]) => {
        const projAgg = projAggByKey.get(key);
        return {
          key,
          name: projAgg?.projName ?? projNameMap.get(key) ?? key,
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

  // --- budget: cycle-to-date burn rate vs the configured monthly cap ---
  const cfg = getConfig();
  const budget = buildBudget(db, {
    budgetUsd: cfg.monthlyBudgetUsd,
    cycleStartDay: cfg.budgetCycleStartDay,
    sourceBudgets: cfg.sourceBudgets,
  });

  return {
    windowDays,
    totalUsd: total,
    priorUsd: prior,
    deltaPct,
    weekUsd: round2(weekRow.total),
    weekSessions: weekRow.sessions,
    topFeatures,
    topProjects,
    projectColors,
    projects,
    otherProjects,
    days: dayRows,
    projectFeatureMix,
    unattributed,
    anomalies,
    recentCommits,
    budget,
  };
}

// One color per project for the WHOLE ledger, independent of any time
// window. Keys are handed to resolveProjectColors in ALL-TIME-SPEND order
// (ties broken by key), so the projects that actually appear on screens
// claim well-separated hues first and low-spend noise buckets absorb any
// crowding — the ledger can hold more projects than 360°/MIN_SEP slots.
// All-time order is view-independent, so every surface that colors a
// project — overview chart bands, burn-path bars, project detail, /api
// (menubar) — gets the same map. Never resolve colors from a windowed
// ranking or a view-local subset.
export function canonicalProjectColors(db: DatabaseType.Database): Record<string, string> {
  const rows = db
    .prepare(`
      SELECT feature_key AS featureKey,
             MAX(feature_name) AS featureName,
             MAX(repo) AS repo,
             SUM(total_cost_usd) AS totalUsd
      FROM feature_rollups
      GROUP BY feature_key
    `)
    .all() as Array<{ featureKey: string; featureName: string; repo: string | null; totalUsd: number }>;
  const spend = new Map<string, number>();
  for (const r of rows) {
    const { projectKey } = bucketProject(r);
    spend.set(projectKey, (spend.get(projectKey) ?? 0) + (r.totalUsd ?? 0));
  }
  const keys = [...spend.keys()].sort((a, b) =>
    (spend.get(b)! - spend.get(a)!) || (a < b ? -1 : a > b ? 1 : 0));
  return resolveProjectColors(keys);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Table names can't be SQLite bind params, so they're interpolated. The value
// only ever comes from our own code (feature_rollups or the scoped temp table),
// but validate a bare identifier anyway so this can never become an injection
// vector if a caller gets careless.
function safeTable(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe rollup table name: ${name}`);
  }
  return name;
}
