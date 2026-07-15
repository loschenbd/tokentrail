import type DatabaseType from 'better-sqlite3';
import { buildOverview, bucketProject, type OverviewVM } from './overview.js';
import {
  hiddenFeatureKeys,
  rollupVisiblePredicate,
  repoVisiblePredicate,
  eventsVisiblePredicate,
  matchesHiddenPattern,
} from '../lib/hidden-projects.js';

const TOP_PROJECTS_LIMIT = 5;
const PACE_MIN_HISTORY_DAYS = 7;
const SHIPPED_ITEMS_LIMIT = 5;

export type TodaySession = {
  sessionId: string;
  title: string;            // never empty: title → inferred_feature_name → project_dir basename → 'Untitled session'
  projectName: string;      // project_dir basename, '' if unknown
  featureKey: string | null;
  startedAt: string;        // 'HH:MM' local
  endedAt: string;          // 'HH:MM' local
  usd: number;
};

export type ShippedItem = { kind: 'pr' | 'commit'; title: string; state?: string; at: string };

export type TodayVM = {
  todayUsd: number;
  yesterdayUsd: number;
  deltaPct: number;
  sessionsToday: number;
  sessions: TodaySession[];
  topProjects: OverviewVM['topProjects'];
  anomalies: OverviewVM['anomalies'];
  hourly: { hour: number; usd: number; projects: { name: string; usd: number; color: string }[] }[];
  projectFeatureMix: OverviewVM['projectFeatureMix'];
  paceUsd: number | null;
  usualDayUsd: number;
  shipped: { prCount: number; commitCount: number; items: ShippedItem[] };
};

export function buildTodayVM(
  db: DatabaseType.Database,
  opts: { nowHour?: number; hidden?: string[] } = {},
): TodayVM {
  const nowHour = opts.nowHour ?? new Date().getHours();
  const hidden = opts.hidden ?? [];
  const hiddenKeys = hiddenFeatureKeys(db, hidden);
  const visibleSql = rollupVisiblePredicate(hiddenKeys);
  const eventsVisibleSql = eventsVisiblePredicate(hidden, hiddenKeys);
  const overview = buildOverview({ db, days: 1, hidden });

  const yesterdayRow = db
    .prepare(
      `SELECT COALESCE(SUM(total_cost_usd), 0) AS total
         FROM feature_rollups
        WHERE date = date('now', '-1 day', 'localtime') AND ${visibleSql}`
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
          AND ${eventsVisiblePredicate(hidden, hiddenKeys, 'ue')}
        GROUP BY ue.session_id
        ORDER BY MIN(ue.timestamp) ASC`
    )
    .all() as Array<{
      sessionId: string; startTs: string; endTs: string; usd: number;
      title: string | null; projectDir: string | null;
      featureName: string | null; featureKey: string | null;
    }>;

  const sessions: TodaySession[] = sessionRows
    // The SQL predicate sees ue.project_dir; the coalesced value can still
    // come from sessions.project_dir, so re-check the final identity here.
    .filter((r) => !matchesHiddenPattern(hidden, r.projectDir, r.featureKey, r.featureName))
    .map((r) => {
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

  // Step 3b: Re-map colors from the 30-day ranking (hoisted so it's in scope for the breakdown)
  const colorRef = buildOverview({ db, days: 30, hidden }).projectColors;

  // 24 zero-filled hourly buckets for today.
  const hourly: TodayVM['hourly'] = Array.from({ length: 24 }, (_, hour) => ({ hour, usd: 0, projects: [] }));
  const hourRows = db
    .prepare(
      `SELECT CAST(strftime('%H', timestamp, 'localtime') AS INTEGER) AS hour,
              SUM(estimated_cost_usd) AS usd
         FROM usage_events
        WHERE date(timestamp, 'localtime') = date('now', 'localtime')
          AND ${eventsVisibleSql}
        GROUP BY hour`
    )
    .all() as { hour: number; usd: number }[];
  for (const r of hourRows) hourly[r.hour]!.usd = round2(r.usd);

  // Per-project hourly breakdown.
  const hourProjectRows = db
    .prepare(
      `SELECT CAST(strftime('%H', timestamp, 'localtime') AS INTEGER) AS hour,
              COALESCE(inferred_feature_key, 'unattributed') AS featureKey,
              COALESCE(inferred_feature_name, 'Unattributed') AS featureName,
              repo,
              SUM(estimated_cost_usd) AS usd
         FROM usage_events
        WHERE date(timestamp, 'localtime') = date('now', 'localtime')
          AND ${eventsVisibleSql}
        GROUP BY hour, featureKey, featureName, repo`
    )
    .all() as Array<{ hour: number; featureKey: string; featureName: string; repo: string | null; usd: number }>;

  // Bucket TS-side (same as Overview), re-aggregate per (hour, projectKey).
  const perHour = new Map<number, Map<string, { name: string; usd: number; color: string }>>();
  for (const r of hourProjectRows) {
    const { projectKey, projectName } = bucketProject(r);
    let bucket = perHour.get(r.hour);
    if (!bucket) { bucket = new Map(); perHour.set(r.hour, bucket); }
    const cur = bucket.get(projectKey);
    if (cur) cur.usd += r.usd;
    else bucket.set(projectKey, { name: projectName, usd: r.usd, color: colorRef[projectKey] ?? '#9CA3AF' });
  }
  for (const [hour, bucket] of perHour) {
    hourly[hour]!.projects = [...bucket.values()]
      .map((p) => ({ ...p, usd: round2(p.usd) }))
      .sort((a, b) => b.usd - a.usd);
  }

  // Usual day: average daily rollup total over the last 30 completed days.
  const usualRow = db
    .prepare(
      `SELECT COALESCE(SUM(total_cost_usd), 0) AS total, COUNT(DISTINCT date) AS days
         FROM feature_rollups
        WHERE date >= date('now', '-30 day', 'localtime')
          AND date < date('now', 'localtime')
          AND ${visibleSql}`
    )
    .get() as { total: number; days: number };
  const usualDayUsd = usualRow.days > 0 ? round2(usualRow.total / usualRow.days) : 0;

  // Shipped: commits and PRs from today-active sessions, deduped by sha/pr_number
  const commitRows = db
    .prepare(
      `WITH today_sessions AS (
         SELECT DISTINCT session_id FROM usage_events
          WHERE date(timestamp, 'localtime') = date('now', 'localtime')
            AND ${eventsVisibleSql}
       )
       SELECT sc.commit_sha AS sha, MAX(sc.subject) AS subject, MAX(sc.authored_at) AS at
         FROM session_commits sc
         JOIN today_sessions ts ON ts.session_id = sc.session_id
        WHERE date(sc.authored_at, 'localtime') = date('now', 'localtime')
          AND ${repoVisiblePredicate(hidden, 'sc.repo')}
        GROUP BY sc.commit_sha
        ORDER BY at DESC`
    )
    .all() as { sha: string; subject: string | null; at: string }[];

  const prRows = db
    .prepare(
      `WITH today_sessions AS (
         SELECT DISTINCT session_id FROM usage_events
          WHERE date(timestamp, 'localtime') = date('now', 'localtime')
            AND ${eventsVisibleSql}
       )
       SELECT sp.repo AS repo, sp.pr_number AS n, MAX(sp.pr_title) AS title,
              MAX(sp.pr_state) AS state, MAX(sp.merged_at) AS mergedAt
         FROM session_prs sp
         JOIN today_sessions ts ON ts.session_id = sp.session_id
        WHERE (date(sp.merged_at, 'localtime') = date('now', 'localtime')
           OR sp.pr_state = 'open')
          AND ${repoVisiblePredicate(hidden, 'sp.repo')}
        GROUP BY sp.repo, sp.pr_number
        ORDER BY COALESCE(mergedAt, '9999') DESC`
    )
    .all() as { repo: string; n: number; title: string | null; state: string | null; mergedAt: string | null }[];

  const shipped = {
    prCount: prRows.length,
    commitCount: commitRows.length,
    items: [
      ...prRows.map((p) => ({
        kind: 'pr' as const,
        title: p.title ?? `PR #${p.n}`,
        state: p.state ?? undefined,
        at: p.mergedAt ?? '',
      })),
      ...commitRows.map((c) => ({ kind: 'commit' as const, title: c.subject ?? c.sha.slice(0, 8), at: c.at })),
    ].slice(0, SHIPPED_ITEMS_LIMIT),
  };

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
            AND ${eventsVisibleSql}
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

  // Re-map colors from the 30-day ranking (colorRef already computed above).
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
    projectFeatureMix: overview.projectFeatureMix,
    paceUsd,
    usualDayUsd,
    shipped,
  };
}

function localHHMM(ts: string): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
