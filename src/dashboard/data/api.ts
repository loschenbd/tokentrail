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

export type TodayResponse = {
  todayUsd: number;
  topProjects: TodayProject[];
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
  };
}
