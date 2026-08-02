import { statSync } from 'node:fs';
import type DatabaseType from 'better-sqlite3';
import { buildOverview, bucketProject } from './overview.js';
import { colorForProject } from '../lib/feature-colors.js';
import { hiddenFeatureKeys, rollupVisiblePredicate, shownAnomalyPredicate } from '../lib/hidden-projects.js';
import { buildSources, type SourcesResponse } from './sources.js';
import { buildBudget, type BudgetReport } from './budget.js';
import { getConfig } from '../../lib/config.js';

const DASHBOARD_BASE_URL = 'http://127.0.0.1:4920';
const MAX_PROJECTS = 3;
const MAX_FEATURES_PER_PROJECT = 5;

export type TodayFeature = {
  key: string;
  name: string;
  usd: number;
  href: string;
};

export type TodayProject = {
  key: string;
  name: string;
  usd: number;
  href: string;
  features: TodayFeature[];
};

// Slim 30-day stacked-trend payload for the native menu-bar app's chart.
// Mirrors the overview trend chart: same bands, same server-resolved project
// colors, same stack order — so the dropdown chart matches the dashboard.
export type MenubarTrend = {
  days: Array<{ date: string; bands: Record<string, number> }>;
  projects: Array<{ key: string; name: string; color: string; stackPosition: number }>;
  // Tail projects (rank 7+) that live inside the __other__ band, so the
  // legend's expander can itemize the full window instead of one gray
  // aggregate. Sorted descending by spend, same as the dashboard legend.
  // color is the project's identity color (same map as the burn-paths
  // swatches), NOT the band color — in the chart these all draw gray.
  others: Array<{ key: string; name: string; totalUsd: number; color: string }>;
};

export type MenubarSummary = {
  sparkline: number[];          // last 14 days, oldest first, today rightmost
  last7Usd: number;
  last30Usd: number;
  deltaVsYesterday: number;     // signed % vs yesterday; 0 when both 0;
                                // Infinity when yesterday is 0 and today > 0
  yesterdayUsd: number;
  trend: MenubarTrend;
};

export type TodayResponse = {
  todayUsd: number;
  topProjects: TodayProject[];
  anomalyCount: number;
  // Largest active (undismissed) anomaly, so the menubar can lead with
  // the dollar amount instead of a bare count. Null when none active.
  topAnomaly: { amount: number; date: string; reason: string } | null;
  // ISO timestamp of the most recent usage event we've ingested. Reflects
  // data freshness, NOT response time — "asOf = now" would always print
  // "0s ago" in the menubar and tell the user nothing.
  lastEventAt: string | null;
  menubar: MenubarSummary;
  sourcesToday: SourcesResponse;
  sources30d: SourcesResponse;
  // Current billing-cycle budget status + burn-rate forecast. Null when no
  // budget is configured (monthlyBudgetUsd unset).
  budget: BudgetReport | null;
};

// Cache the full payload between menubar polls (every 60 s). Between
// pipeline runs nothing in the DB changes, so rebuilding two
// buildOverview() aggregations per poll is wasted work. The key captures
// every way the answer can change: (size, mtime) of the DB file and its
// WAL — every commit from any process touches the WAL, and this stays
// true across processes where PRAGMA data_version proved unreliable —
// plus total_changes() for this connection's own writes (e.g. anomaly
// dismissals), and the local date, which rolls "today" over at midnight
// with no write at all. WeakMap so tests with several in-process DBs
// don't cross-contaminate.
const todayCache = new WeakMap<DatabaseType.Database, { key: string; value: TodayResponse }>();

function todayCacheKey(db: DatabaseType.Database): string {
  const fileSig = (path: string): string => {
    try {
      const st = statSync(path);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return 'absent';
    }
  };
  const tc = (db.prepare(`SELECT total_changes() AS c`).get() as { c: number }).c;
  const today = (db.prepare(`SELECT date('now', 'localtime') AS d`).get() as { d: string }).d;
  return `${fileSig(db.name)};${fileSig(db.name + '-wal')};${tc};${today}`;
}

export function buildToday(
  db: DatabaseType.Database,
  opts: { hidden?: string[] } = {}
): TodayResponse {
  const hidden = opts.hidden ?? [];
  const cfg = getConfig();
  // Hidden patterns + budget config join the cache key so editing settings.json
  // takes effect on the next poll without waiting for a DB write.
  const sb = cfg.sourceBudgets;
  const cacheKey = `${todayCacheKey(db)};hidden=${hidden.join(',')};budget=${cfg.monthlyBudgetUsd}:${cfg.budgetCycleStartDay}:${sb.claude},${sb.copilot},${sb.cursor}`;
  const cached = todayCache.get(db);
  if (cached && cached.key === cacheKey) return cached.value;

  const hiddenKeys = hiddenFeatureKeys(db, hidden);
  const visibleSql = rollupVisiblePredicate(hiddenKeys);
  const overview = buildOverview({ db, days: 1, hidden });

  // Same canonical filter the Worth a look page uses: not dismissed AND not on
  // a hidden project, so the menubar count can't disagree with the dashboard.
  const shownAnomalies = shownAnomalyPredicate(hiddenKeys);

  const anomalyCount = (db
    .prepare(`SELECT COUNT(*) AS n FROM anomalies WHERE ${shownAnomalies}`)
    .get() as { n: number }).n;

  const lastEventAt = (db
    .prepare(`SELECT MAX(timestamp) AS t FROM usage_events`)
    .get() as { t: string | null }).t;

  const topAnomaly = (db
    .prepare(`SELECT amount, date, reason FROM anomalies
              WHERE ${shownAnomalies}
              ORDER BY amount DESC LIMIT 1`)
    .get() ?? null) as { amount: number; date: string; reason: string } | null;

  // Build per-project feature lists from today's feature_rollups.
  // topProjects no longer carries feature details (new project-first shape),
  // so we query and group features independently using the same bucketing logic.
  const todayDateExpr = `date('now', 'localtime')`;
  const allFeatureRows = db
    .prepare(`
      SELECT feature_key AS featureKey,
             MAX(feature_name) AS featureName,
             MAX(repo) AS repo,
             ROUND(SUM(total_cost_usd), 2) AS totalUsd
      FROM feature_rollups
      WHERE date >= ${todayDateExpr} AND ${visibleSql}
      GROUP BY feature_key
      ORDER BY totalUsd DESC
    `)
    .all() as Array<{ featureKey: string; featureName: string; repo: string | null; totalUsd: number }>;

  const projectFeaturesMap = new Map<string, TodayFeature[]>();
  for (const r of allFeatureRows) {
    const { projectKey } = bucketProject(r);
    if (!projectFeaturesMap.has(projectKey)) projectFeaturesMap.set(projectKey, []);
    projectFeaturesMap.get(projectKey)!.push({
      key: r.featureKey,
      name: r.featureName,
      usd: r.totalUsd,
      href: `${DASHBOARD_BASE_URL}/feature/${encodeURIComponent(r.featureKey)}`,
    });
  }

  const menubar = buildMenubarSummary(db, overview.totalUsd, hidden, visibleSql);
  const value: TodayResponse = {
    todayUsd: overview.totalUsd,
    topProjects: overview.topProjects.slice(0, MAX_PROJECTS).map((p) => ({
      key: p.key,
      name: p.name,
      usd: p.totalUsd,
      href: `${DASHBOARD_BASE_URL}/project/${encodeURIComponent(p.key)}`,
      features: (projectFeaturesMap.get(p.key) ?? []).slice(0, MAX_FEATURES_PER_PROJECT),
    })),
    anomalyCount,
    topAnomaly,
    lastEventAt,
    menubar,
    sourcesToday: buildSources(db, { days: 1, claudeUsd: overview.totalUsd }),
    sources30d: buildSources(db, { days: 30, claudeUsd: menubar.last30Usd }),
    budget: buildBudget(db, {
      budgetUsd: cfg.monthlyBudgetUsd,
      cycleStartDay: cfg.budgetCycleStartDay,
      sourceBudgets: cfg.sourceBudgets,
    }),
  };
  todayCache.set(db, { key: cacheKey, value });
  return value;
}

function buildMenubarTrend(db: DatabaseType.Database, hidden: string[]): MenubarTrend {
  const overview = buildOverview({ db, days: 30, hidden });
  return {
    days: overview.days.map((d) => ({ date: d.date, bands: d.bands })),
    projects: overview.projects.map((p) => ({
      key: p.key,
      name: p.name,
      color: p.color,
      stackPosition: p.stackPosition,
    })),
    others: overview.otherProjects.map((p) => ({
      key: p.key,
      name: p.name,
      totalUsd: p.totalUsd,
      // projectColors spans the burn-paths top 12; deeper tail projects
      // get the same hash-picked hue the dashboard would give them solo.
      color: overview.projectColors[p.key] ?? colorForProject(p.key),
    })),
  };
}

function buildMenubarSummary(
  db: DatabaseType.Database,
  todayUsd: number,
  hidden: string[],
  visibleSql: string
): MenubarSummary {
  // Daily totals over the last 30 days, one query.
  const rows = db
    .prepare(
      `SELECT date, ROUND(SUM(total_cost_usd), 2) AS total
         FROM feature_rollups
        WHERE date >= date('now', '-29 days', 'localtime') AND ${visibleSql}
        GROUP BY date`
    )
    .all() as Array<{ date: string; total: number }>;
  const byDate = new Map(rows.map((r) => [r.date, r.total]));

  const dateAt = (offset: number): string =>
    (db.prepare(`SELECT date('now', '${offset} days', 'localtime') AS d`).get() as { d: string }).d;

  const sparkline: number[] = [];
  for (let i = 13; i >= 0; i--) sparkline.push(round2(byDate.get(dateAt(-i)) ?? 0));

  let last7Usd = 0;
  for (let i = 6; i >= 0; i--) last7Usd += byDate.get(dateAt(-i)) ?? 0;
  let last30Usd = 0;
  for (const r of rows) last30Usd += r.total;

  const yesterdayUsd = round2(byDate.get(dateAt(-1)) ?? 0);
  let deltaVsYesterday: number;
  if (yesterdayUsd === 0 && todayUsd === 0) deltaVsYesterday = 0;
  else if (yesterdayUsd === 0) deltaVsYesterday = Infinity;
  else deltaVsYesterday = Math.round(((todayUsd - yesterdayUsd) / yesterdayUsd) * 100);

  return {
    sparkline,
    last7Usd: round2(last7Usd),
    last30Usd: round2(last30Usd),
    deltaVsYesterday,
    yesterdayUsd,
    trend: buildMenubarTrend(db, hidden),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
