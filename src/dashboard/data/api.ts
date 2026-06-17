import type DatabaseType from 'better-sqlite3';
import { buildOverview } from './overview.js';

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

export type MenubarSummary = {
  sparkline: number[];          // last 14 days, oldest first, today rightmost
  last7Usd: number;
  last30Usd: number;
  deltaVsYesterday: number;     // signed % vs yesterday; 0 when both 0;
                                // Infinity when yesterday is 0 and today > 0
  yesterdayUsd: number;
};

export type TodayResponse = {
  todayUsd: number;
  topProjects: TodayProject[];
  anomalyCount: number;
  asOf: string;
  menubar: MenubarSummary;
};

export function buildToday(db: DatabaseType.Database): TodayResponse {
  const overview = buildOverview(db, { days: 1 });

  const anomalyCount = (db
    .prepare(`SELECT COUNT(*) AS n FROM anomalies WHERE dismissed_at IS NULL`)
    .get() as { n: number }).n;

  return {
    todayUsd: overview.totalUsd,
    topProjects: overview.topProjects.slice(0, MAX_PROJECTS).map((p) => ({
      key: p.projectKey,
      name: p.projectName,
      usd: p.totalUsd,
      href: `${DASHBOARD_BASE_URL}/project/${encodeURIComponent(p.projectKey)}`,
      features: p.features.slice(0, MAX_FEATURES_PER_PROJECT).map((f) => ({
        key: f.featureKey,
        name: f.featureName,
        usd: f.totalUsd,
        href: `${DASHBOARD_BASE_URL}/feature/${encodeURIComponent(f.featureKey)}`,
      })),
    })),
    anomalyCount,
    asOf: new Date().toISOString(),
    menubar: buildMenubarSummary(db, overview.totalUsd),
  };
}

function buildMenubarSummary(db: DatabaseType.Database, todayUsd: number): MenubarSummary {
  // Daily totals over the last 30 days, one query.
  const rows = db
    .prepare(
      `SELECT date, ROUND(SUM(total_cost_usd), 2) AS total
         FROM feature_rollups
        WHERE date >= date('now', '-29 days', 'localtime')
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
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
