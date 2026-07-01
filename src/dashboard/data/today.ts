import type DatabaseType from 'better-sqlite3';
import { buildOverview, type OverviewVM } from './overview.js';

const TOP_PROJECTS_LIMIT = 5;

export type TodayVM = {
  todayUsd: number;
  yesterdayUsd: number;
  deltaPct: number;
  sessionsToday: number;
  topProjects: OverviewVM['topProjects'];
  anomalies: OverviewVM['anomalies'];
};

export function buildTodayVM(db: DatabaseType.Database): TodayVM {
  const overview = buildOverview({ db, days: 1 });

  const yesterdayRow = db
    .prepare(
      `SELECT COALESCE(SUM(total_cost_usd), 0) AS total
         FROM feature_rollups
        WHERE date = date('now', '-1 day', 'localtime')`
    )
    .get() as { total: number };
  const yesterdayUsd = round2(yesterdayRow.total);

  const sessionsRow = db
    .prepare(
      `SELECT COALESCE(SUM(sessions_count), 0) AS sessions
         FROM feature_rollups
        WHERE date = date('now', 'localtime')`
    )
    .get() as { sessions: number };

  const todayUsd = overview.totalUsd;
  const deltaPct =
    yesterdayUsd > 0
      ? Math.round(((todayUsd - yesterdayUsd) / yesterdayUsd) * 100)
      : todayUsd > 0
        ? 100
        : 0;

  return {
    todayUsd,
    yesterdayUsd,
    deltaPct,
    sessionsToday: sessionsRow.sessions,
    topProjects: overview.topProjects.slice(0, TOP_PROJECTS_LIMIT),
    anomalies: overview.anomalies,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
