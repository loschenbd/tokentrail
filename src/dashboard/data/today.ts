import type DatabaseType from 'better-sqlite3';
import { buildOverview, type OverviewVM } from './overview.js';

const TOP_PROJECTS_LIMIT = 5;
const PACE_MIN_HISTORY_DAYS = 7;

export type TodaySession = {
  sessionId: string;
  title: string;            // never empty: title → inferred_feature_name → project_dir basename → 'Untitled session'
  projectName: string;      // project_dir basename, '' if unknown
  featureKey: string | null;
  startedAt: string;        // 'HH:MM' local
  endedAt: string;          // 'HH:MM' local
  usd: number;
};

export type TodayVM = {
  todayUsd: number;
  yesterdayUsd: number;
  deltaPct: number;
  sessionsToday: number;
  sessions: TodaySession[];
  topProjects: OverviewVM['topProjects'];
  anomalies: OverviewVM['anomalies'];
  hourly: { hour: number; usd: number }[];
  paceUsd: number | null;
  usualDayUsd: number;
};

export function buildTodayVM(
  db: DatabaseType.Database,
  opts: { nowHour?: number } = {},
): TodayVM {
  const nowHour = opts.nowHour ?? new Date().getHours();
  const overview = buildOverview({ db, days: 1 });

  const yesterdayRow = db
    .prepare(
      `SELECT COALESCE(SUM(total_cost_usd), 0) AS total
         FROM feature_rollups
        WHERE date = date('now', '-1 day', 'localtime')`
    )
    .get() as { total: number };
  const yesterdayUsd = round2(yesterdayRow.total);

  const sessionRows = db
    .prepare(
      `SELECT ue.session_id AS sessionId,
              MIN(ue.timestamp) AS startTs,
              MAX(ue.timestamp) AS endTs,
              SUM(ue.estimated_cost_usd) AS usd,
              MAX(s.title) AS title,
              COALESCE(MAX(s.project_dir), MAX(ue.project_dir)) AS projectDir,
              MAX(ue.inferred_feature_name) AS featureName,
              MAX(COALESCE(s.feature_override, ue.inferred_feature_key)) AS featureKey
         FROM usage_events ue
         LEFT JOIN sessions s ON s.session_id = ue.session_id
        WHERE date(ue.timestamp, 'localtime') = date('now', 'localtime')
        GROUP BY ue.session_id
        ORDER BY MIN(ue.timestamp) ASC`
    )
    .all() as Array<{
      sessionId: string; startTs: string; endTs: string; usd: number;
      title: string | null; projectDir: string | null;
      featureName: string | null; featureKey: string | null;
    }>;

  const sessions: TodaySession[] = sessionRows.map((r) => {
    const projectName = r.projectDir ? (r.projectDir.split('/').pop() ?? '') : '';
    return {
      sessionId: r.sessionId,
      title: r.title?.trim() || r.featureName?.trim() || projectName || 'Untitled session',
      projectName,
      featureKey: r.featureKey,
      startedAt: localHHMM(r.startTs),
      endedAt: localHHMM(r.endTs),
      usd: round2(r.usd),
    };
  });

  const todayUsd = overview.totalUsd;
  const deltaPct =
    yesterdayUsd > 0
      ? Math.round(((todayUsd - yesterdayUsd) / yesterdayUsd) * 100)
      : todayUsd > 0
        ? 100
        : 0;

  // 24 zero-filled hourly buckets for today.
  const hourly: { hour: number; usd: number }[] = Array.from({ length: 24 }, (_, hour) => ({ hour, usd: 0 }));
  const hourRows = db
    .prepare(
      `SELECT CAST(strftime('%H', timestamp, 'localtime') AS INTEGER) AS hour,
              SUM(estimated_cost_usd) AS usd
         FROM usage_events
        WHERE date(timestamp, 'localtime') = date('now', 'localtime')
        GROUP BY hour`
    )
    .all() as { hour: number; usd: number }[];
  for (const r of hourRows) hourly[r.hour]!.usd = round2(r.usd);

  // Usual day: average daily rollup total over the last 30 completed days.
  const usualRow = db
    .prepare(
      `SELECT COALESCE(SUM(total_cost_usd), 0) AS total, COUNT(DISTINCT date) AS days
         FROM feature_rollups
        WHERE date >= date('now', '-30 day', 'localtime')
          AND date < date('now', 'localtime')`
    )
    .get() as { total: number; days: number };
  const usualDayUsd = usualRow.days > 0 ? round2(usualRow.total / usualRow.days) : 0;

  // Pace: today ÷ (historical share of a day's spend that lands by nowHour).
  const paceRow = db
    .prepare(
      `WITH hist AS (
         SELECT date(timestamp, 'localtime') AS d,
                CAST(strftime('%H', timestamp, 'localtime') AS INTEGER) AS h,
                SUM(estimated_cost_usd) AS usd
           FROM usage_events
          WHERE date(timestamp, 'localtime') >= date('now', '-30 day', 'localtime')
            AND date(timestamp, 'localtime') < date('now', 'localtime')
          GROUP BY d, h
       )
       -- h <= nowHour: "by now" includes the current, in-progress hour
       SELECT COALESCE(SUM(CASE WHEN h <= ? THEN usd END), 0) AS byNow,
              COALESCE(SUM(usd), 0) AS total,
              COUNT(DISTINCT d) AS days
         FROM hist`
    )
    .get(nowHour) as { byNow: number; total: number; days: number };
  const share = paceRow.total > 0 ? paceRow.byNow / paceRow.total : 0;
  const paceUsd =
    paceRow.days >= PACE_MIN_HISTORY_DAYS && share > 0 ? round2(todayUsd / share) : null;

  // Step 3b: Re-map colors from the 30-day ranking
  const colorRef = buildOverview({ db, days: 30 }).projectColors;
  const topProjects = overview.topProjects
    .slice(0, TOP_PROJECTS_LIMIT)
    .map((p) => ({ ...p, color: colorRef[p.key] ?? p.color }));

  return {
    todayUsd,
    yesterdayUsd,
    deltaPct,
    sessionsToday: sessions.length,
    sessions,
    topProjects,
    anomalies: overview.anomalies,
    hourly,
    paceUsd,
    usualDayUsd,
  };
}

function localHHMM(ts: string): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
