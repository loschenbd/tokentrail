import type DatabaseType from 'better-sqlite3';
import { buildOverview } from './overview.js';

const DASHBOARD_BASE_URL = 'http://127.0.0.1:4920';

export type TodayResponse = {
  todayUsd: number;
  topFeatures: Array<{
    key: string;
    name: string;
    usd: number;
    href: string;
  }>;
  anomalyCount: number;
  asOf: string;
};

export function buildToday(db: DatabaseType.Database): TodayResponse {
  const overview = buildOverview(db, { days: 1 });

  const anomalyCount = (db
    .prepare(`SELECT COUNT(*) AS n FROM anomalies WHERE dismissed_at IS NULL`)
    .get() as { n: number }).n;

  return {
    todayUsd: overview.totalUsd,
    topFeatures: overview.topFeatures.slice(0, 3).map((f) => ({
      key: f.featureKey,
      name: f.featureName,
      usd: f.totalUsd,
      href: `${DASHBOARD_BASE_URL}/feature/${encodeURIComponent(f.featureKey)}`,
    })),
    anomalyCount,
    asOf: new Date().toISOString(),
  };
}
