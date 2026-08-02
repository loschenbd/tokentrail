import type DatabaseType from 'better-sqlite3';
import { buildBranchGraph, STALE_DAYS, type BranchGraphVM } from './branches.js';
import { canonicalProjectColors } from './overview.js';
import { colorForProject } from '../lib/feature-colors.js';
import { shownAnomalyPredicate } from '../lib/hidden-projects.js';
import { attribute } from '../../lib/attribution.js';
import { getConfig } from '../../lib/config.js';

// A "project" is a higher-level grouping than a feature. There are three
// kinds of project key:
//   repo:<owner>/<name>    — a GitHub-style repo (e.g. repo:loschenbd/archi)
//   local:<basename>       — a local git repo with no remote
//   feature:<feature_key>  — a single feature standing on its own (typically
//                            an "outside:" bucket with no repo at all)
//
// The Overview's project grouping uses the same key namespace; the project
// detail page resolves whichever filter applies and aggregates the
// matching feature_rollups rows.

export type ProjectDetailVM = {
  projectKey: string;
  projectName: string;
  // Canonical project color (see canonicalProjectColors) — identical to the
  // overview chart bands, burn-path swatches, and menubar dots.
  color: string;
  totalUsd: number;
  priorUsd: number;
  deltaPct: number;
  avgUsdPerDay: number;
  weekStats: {
    thisWeekUsd: number;
    lastWeekUsd: number;
    priorWeekUsd: number;
    thisVsLastPct: number;
    lastVsPriorPct: number;
  };
  peakDay: {
    date: string;
    totalUsd: number;
    featureKey: string;
    featureName: string;
  } | null;
  sessionCount: number;
  featureCount: number;
  dailySeries: Array<{ date: string; total: number; commits: number; prs: number }>;
  features: Array<{
    featureKey: string;
    featureName: string;
    totalUsd: number;
    sessionCount: number;
    lastActive: string;
    // Lifecycle status, taken from the feature's linked branch (open→opened,
    // merged→closed, stale→stale); features with no branch fall back to
    // activity age (stale past the cutoff, else opened — never closed).
    status: 'opened' | 'closed' | 'stale';
    daily: Array<{ date: string; totalUsd: number }>;
  }>;
  sessions: Array<{
    sessionId: string;
    title: string | null;
    date: string | null;
    cost: number;
  }>;
  recentCommits: Array<{ sha: string; subject: string; repo: string | null; authoredAt: string | null }>;
  anomalies: Array<{
    id: number;
    kind: string;
    date: string;
    featureKey: string | null;
    sessionId: string | null;
    amount: number;
    reason: string;
    cause: { kind: 'session' | 'feature'; ref: string; label: string } | null;
  }>;
  unattributed: {
    totalUsd: number;
    sparkline: Array<{ date: string; usd: number }>;
    topFeatures: Array<{ featureKey: string; featureName: string; usd: number }>;
  } | null;
  branchGraph: BranchGraphVM | null;
};

type ProjectFilter = {
  kind: 'repo' | 'feature';
  repo?: string;
  featureKey?: string;
};

function parseProjectKey(projectKey: string): ProjectFilter | null {
  if (projectKey.startsWith('repo:')) {
    return { kind: 'repo', repo: projectKey.slice(5) };
  }
  if (projectKey.startsWith('local:')) {
    return { kind: 'repo', repo: 'local/' + projectKey.slice(6) };
  }
  if (projectKey.startsWith('feature:')) {
    return { kind: 'feature', featureKey: projectKey.slice(8) };
  }
  return null;
}

export function buildProjectDetail(
  db: DatabaseType.Database,
  opts: { projectKey: string; days: number }
): ProjectDetailVM | null {
  const filter = parseProjectKey(opts.projectKey);
  if (!filter) return null;

  const days = Math.max(1, opts.days);
  const startExpr = `date('now', '-${days - 1} days', 'localtime')`;
  const priorStartExpr = `date('now', '-${days * 2 - 1} days', 'localtime')`;
  const priorEndExpr = `date('now', '-${days} days', 'localtime')`;

  // Each filter resolves to a SQL WHERE clause + bound params. Repo filter
  // matches the CSV column with leading/trailing comma sentinels so partial
  // matches (e.g. "archi" matching "loschenbd/archi-old") can't slip in.
  const filterSql = filter.kind === 'repo'
    ? `(',' || repo || ',') LIKE @repoNeedle`
    : `feature_key = @featureKey`;
  const filterParams: Record<string, string> = filter.kind === 'repo'
    ? { repoNeedle: `%,${filter.repo},%` }
    : { featureKey: filter.featureKey! };

  const head = db
    .prepare(`
      SELECT COALESCE(SUM(total_cost_usd), 0) AS totalUsd,
             COALESCE(SUM(sessions_count), 0) AS sessionCount,
             GROUP_CONCAT(DISTINCT session_ids) AS sessionIdsCsv
      FROM feature_rollups
      WHERE ${filterSql} AND date >= ${startExpr}
    `)
    .get(filterParams) as {
      totalUsd: number;
      sessionCount: number;
      sessionIdsCsv: string | null;
    };
  if (head.totalUsd === 0 && (head.sessionIdsCsv ?? '').length === 0) {
    return null;
  }

  const prior = (db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM feature_rollups WHERE ${filterSql} AND date >= ${priorStartExpr} AND date <= ${priorEndExpr}`)
    .get(filterParams) as { total: number }).total;
  const deltaPct = prior > 0 ? Math.round(((head.totalUsd - prior) / prior) * 100) : (head.totalUsd > 0 ? 100 : 0);

  // Project display name — prefer the human feature name for feature-kind
  // projects; for repo-kind, use the repo basename. For the unique features
  // list, we still need their per-feature totals.
  const features = db
    .prepare(`
      SELECT feature_key AS featureKey,
             MAX(feature_name) AS featureName,
             ROUND(SUM(total_cost_usd), 2) AS totalUsd,
             SUM(sessions_count) AS sessionCount
      FROM feature_rollups
      WHERE ${filterSql} AND date >= ${startExpr}
      GROUP BY feature_key
      ORDER BY totalUsd DESC
    `)
    .all(filterParams) as ProjectDetailVM['features'];

  const projectName = filter.kind === 'repo'
    ? (filter.repo!.split('/').pop() ?? filter.repo!)
    : (features[0]?.featureName ?? filter.featureKey!);

  // Per-feature lastActive + zero-filled daily series in-window.
  const featureDailyByKey = new Map<string, Map<string, number>>();
  const featureLastActive = new Map<string, string>();
  for (const r of db
    .prepare(`SELECT feature_key AS k, date AS d, SUM(total_cost_usd) AS s FROM feature_rollups WHERE ${filterSql} AND date >= ${startExpr} GROUP BY feature_key, date`)
    .all(filterParams) as Array<{ k: string; d: string; s: number }>) {
    if (!featureDailyByKey.has(r.k)) featureDailyByKey.set(r.k, new Map());
    featureDailyByKey.get(r.k)!.set(r.d, r.s);
    const prev = featureLastActive.get(r.k);
    if (!prev || r.d > prev) featureLastActive.set(r.k, r.d);
  }

  const sessionIds = uniqueSessionIds(head.sessionIdsCsv);

  const dailyRows = db
    .prepare(`SELECT date, SUM(total_cost_usd) AS total FROM feature_rollups WHERE ${filterSql} AND date >= ${startExpr} GROUP BY date ORDER BY date`)
    .all(filterParams) as Array<{ date: string; total: number }>;
  const observedMap = new Map(dailyRows.map((r) => [r.date, r.total]));

  const commitsByDay = sessionIds.length === 0
    ? []
    : db
      .prepare(`SELECT date(authored_at, 'localtime') AS d, COUNT(*) AS n FROM session_commits WHERE session_id IN (SELECT value FROM json_each(?)) AND authored_at IS NOT NULL GROUP BY date(authored_at, 'localtime')`)
      .all(JSON.stringify(sessionIds)) as Array<{ d: string; n: number }>;
  const commitsMap = new Map(commitsByDay.map((r) => [r.d, r.n]));
  const prsByDay = sessionIds.length === 0
    ? []
    : db
      .prepare(`SELECT date(merged_at, 'localtime') AS d, COUNT(*) AS n FROM session_prs WHERE session_id IN (SELECT value FROM json_each(?)) AND merged_at IS NOT NULL GROUP BY date(merged_at, 'localtime')`)
      .all(JSON.stringify(sessionIds)) as Array<{ d: string; n: number }>;
  const prsMap = new Map(prsByDay.map((r) => [r.d, r.n]));

  // Zero-fill the daily series across the full window so the chart doesn't
  // skip days with no activity.
  const dailySeries: ProjectDetailVM['dailySeries'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = db.prepare(`SELECT date('now', '-${i} days', 'localtime') AS d`).get() as { d: string };
    dailySeries.push({
      date: date.d,
      total: round2(observedMap.get(date.d) ?? 0),
      commits: commitsMap.get(date.d) ?? 0,
      prs: prsMap.get(date.d) ?? 0,
    });
  }

  const dailyDates = dailySeries.map((d) => d.date);
  const featuresWithSparkline = features.map((f) => {
    const perDate = featureDailyByKey.get(f.featureKey) ?? new Map<string, number>();
    return {
      ...f,
      totalUsd: round2(f.totalUsd),
      lastActive: featureLastActive.get(f.featureKey) ?? dailyDates[dailyDates.length - 1] ?? '',
      daily: dailyDates.map((d) => ({ date: d, totalUsd: round2(perDate.get(d) ?? 0) })),
    };
  });

  const recentCommits = sessionIds.length === 0
    ? []
    : db
      .prepare(`
        SELECT commit_sha AS sha, subject, repo, authored_at AS authoredAt
        FROM session_commits
        WHERE session_id IN (SELECT value FROM json_each(?)) AND authored_at IS NOT NULL
        ORDER BY authored_at DESC LIMIT 10
      `)
      .all(JSON.stringify(sessionIds)) as ProjectDetailVM['recentCommits'];

  const featureKeys = features.map((f) => f.featureKey);
  const anomaliesRaw = featureKeys.length === 0
    ? []
    : db
      .prepare(`
        SELECT id, kind, date, feature_key AS featureKey, session_id AS sessionId,
               ROUND(amount, 2) AS amount, reason
        FROM anomalies
        -- Empty hidden keys on purpose: this list is already scoped to the
        -- viewed project's feature_keys, so hidden-project filtering doesn't
        -- apply (you navigated here explicitly). Still routed through the
        -- shared helper so the "not dismissed" semantics can't drift.
        WHERE ${shownAnomalyPredicate([])}
          AND date >= ${startExpr}
          AND feature_key IN (SELECT value FROM json_each(?))
        ORDER BY multiplier DESC, date DESC
        LIMIT 5
      `)
      .all(JSON.stringify(featureKeys)) as Array<{
        id: number;
        kind: string;
        date: string;
        featureKey: string | null;
        sessionId: string | null;
        amount: number;
        reason: string;
      }>;

  // Cause line: prefer the session (title looked up in `sessions`) if the
  // anomaly references one; otherwise fall back to the anomaly's feature
  // (using the human name from our per-feature list).
  const featureNameByKey = new Map(featuresWithSparkline.map((f) => [f.featureKey, f.featureName || f.featureKey]));
  const anomalySessionIds = anomaliesRaw
    .map((a) => a.sessionId)
    .filter((s): s is string => !!s);
  const sessionTitleByRef = new Map<string, string>();
  if (anomalySessionIds.length > 0) {
    for (const r of db
      .prepare(`SELECT session_id AS sid, title FROM sessions WHERE session_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(anomalySessionIds)) as Array<{ sid: string; title: string | null }>) {
      sessionTitleByRef.set(r.sid, r.title ?? r.sid);
    }
  }
  const anomalies: ProjectDetailVM['anomalies'] = anomaliesRaw.map((a) => {
    let cause: { kind: 'session' | 'feature'; ref: string; label: string } | null = null;
    if (a.sessionId) {
      cause = { kind: 'session', ref: a.sessionId, label: sessionTitleByRef.get(a.sessionId) ?? a.sessionId };
    } else if (a.featureKey) {
      cause = { kind: 'feature', ref: a.featureKey, label: featureNameByKey.get(a.featureKey) ?? a.featureKey };
    }
    return { ...a, cause };
  });

  const branchGraph = buildBranchGraph(db, { projectKey: opts.projectKey, days });

  // Per-feature lifecycle status. Prefer the linked branch's state; among
  // several branches for one feature, the most-alive wins (opened > closed >
  // stale). Features with no branch fall back to activity age.
  const statusRank = (s: 'opened' | 'closed' | 'stale'): number =>
    s === 'opened' ? 2 : s === 'closed' ? 1 : 0;
  const branchStatusByFeature = new Map<string, 'opened' | 'closed' | 'stale'>();
  for (const b of branchGraph?.branches ?? []) {
    if (!b.featureKey) continue;
    const mapped: 'opened' | 'closed' | 'stale' =
      b.status === 'open' ? 'opened' : b.status === 'merged' ? 'closed' : 'stale';
    const prev = branchStatusByFeature.get(b.featureKey);
    if (prev === undefined || statusRank(mapped) > statusRank(prev)) {
      branchStatusByFeature.set(b.featureKey, mapped);
    }
  }
  // Window-independent "closed": a feature is closed if any of its branches has
  // a merged PR, regardless of the 30-day activity window. A shipped feature
  // goes quiet and its branch ages out of the branch graph, but it is still
  // done — not stale. Merges come from session_prs; each merged branch is
  // resolved to a feature two ways (union):
  //   (1) attribute() — the canonical branch→feature derivation, so it works
  //       even when feature_rollups.branches was never populated (older repos);
  //   (2) membership in a feature's recorded branches CSV — belt-and-braces for
  //       features attributed by PR title/label rather than by branch.
  const projectRepos = (db
    .prepare(`SELECT DISTINCT repo FROM feature_rollups
               WHERE ${filterSql} AND repo IS NOT NULL AND repo != ''`)
    .all(filterParams) as Array<{ repo: string }>).map((r) => r.repo);
  const closedFeatureKeys = new Set<string>();
  if (projectRepos.length > 0) {
    const mergedRows = db
      .prepare(`SELECT DISTINCT repo, REPLACE(head_branch, 'origin/', '') AS branch FROM session_prs
                 WHERE pr_state = 'merged' AND merged_at IS NOT NULL
                   AND head_branch IS NOT NULL AND head_branch != ''
                   AND repo IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(projectRepos)) as Array<{ repo: string; branch: string }>;
    const config = getConfig();
    const mergedBranches = new Set<string>();
    for (const m of mergedRows) {
      if (!m.branch) continue;
      closedFeatureKeys.add(attribute({ repo: m.repo, branch: m.branch }, config).featureKey);
      mergedBranches.add(m.branch);
    }
    // CSV path: features whose recorded branches include a merged branch.
    const featureBranchRows = db
      .prepare(`SELECT feature_key AS featureKey, branches FROM feature_rollups
                 WHERE ${filterSql} AND branches IS NOT NULL AND branches != ''`)
      .all(filterParams) as Array<{ featureKey: string; branches: string }>;
    for (const r of featureBranchRows) {
      const names = r.branches.split(',').map((s) => s.trim()).filter(Boolean);
      if (names.some((n) => mergedBranches.has(n))) closedFeatureKeys.add(r.featureKey);
    }
  }

  const staleBefore = (db
    .prepare(`SELECT date('now', 'localtime', '-${STALE_DAYS} days') AS d`)
    .get() as { d: string }).d;
  // Precedence: active work now (an in-window open branch) trumps a past merge;
  // a merge — in-window OR the durable lookup — reads "closed" over a stale or
  // aged-out branch; otherwise fall back to activity age.
  const featureStatus = (featureKey: string, lastActive: string): 'opened' | 'closed' | 'stale' => {
    const inWindow = branchStatusByFeature.get(featureKey);
    if (inWindow === 'opened') return 'opened';
    if (inWindow === 'closed' || closedFeatureKeys.has(featureKey)) return 'closed';
    if (inWindow === 'stale') return 'stale';
    return lastActive && lastActive < staleBefore ? 'stale' : 'opened';
  };
  const featuresWithStatus = featuresWithSparkline.map((f) => ({
    ...f,
    status: featureStatus(f.featureKey, f.lastActive),
  }));

  // SUM(sessions_count) double-counts sessions active on multiple days;
  // the distinct session_ids set is the right number.
  const distinctSessionCount = sessionIds.length;

  // Sessions across the project — for the trail elevation chart + the
  // upstream session list. NULL first_seen_at falls back to the earliest
  // feature_rollups.date where the session appears, so the chart doesn't
  // silently drop sessions with no datestamp.
  const sessionRows = sessionIds.length === 0
    ? []
    : db
      .prepare(`
        SELECT s.session_id AS sessionId,
               s.title       AS title,
               date(s.first_seen_at, 'localtime') AS date,
               COALESCE((SELECT SUM(e.estimated_cost_usd) FROM usage_events e WHERE e.session_id = s.session_id), 0) AS cost
        FROM sessions s
        WHERE s.session_id IN (SELECT value FROM json_each(?))
      `)
      .all(JSON.stringify(sessionIds)) as Array<{
        sessionId: string;
        title: string | null;
        date: string | null;
        cost: number;
      }>;
  const earliestDateBySession = new Map<string, string>();
  for (const r of db
    .prepare(`SELECT date, session_ids FROM feature_rollups WHERE ${filterSql} AND date >= ${startExpr} ORDER BY date`)
    .all(filterParams) as Array<{ date: string; session_ids: string | null }>) {
    if (!r.session_ids) continue;
    for (const sid of r.session_ids.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!earliestDateBySession.has(sid)) earliestDateBySession.set(sid, r.date);
    }
  }
  const sessions = sessionRows.map((s) => ({
    sessionId: s.sessionId,
    title: s.title,
    date: s.date ?? earliestDateBySession.get(s.sessionId) ?? null,
    cost: round2(s.cost),
  }));

  const avgUsdPerDay = round2(head.totalUsd / days);

  // Rolling weeks: this = days 0..6, last = 7..13, prior = 14..20.
  // We take these from dailySeries (already zero-filled). dailySeries is
  // ordered oldest→newest, so this week is the tail.
  const totalsByDate = new Map(dailySeries.map((d) => [d.date, d.total]));
  const dateAt = (n: number) => (db.prepare(`SELECT date('now', '-${n} days', 'localtime') AS d`).get() as { d: string }).d;
  const sumRange = (from: number, to: number): number => {
    let s = 0;
    for (let i = from; i <= to; i++) s += totalsByDate.get(dateAt(i)) ?? 0;
    return round2(s);
  };
  const thisWeekUsd = sumRange(0, 6);
  const lastWeekUsd = sumRange(7, 13);
  const priorWeekUsd = sumRange(14, 20);
  const deltaPctBetween = (curr: number, prev: number): number => {
    if (prev > 0) return Math.round(((curr - prev) / prev) * 100);
    return curr > 0 ? 100 : 0;
  };
  const weekStats = {
    thisWeekUsd,
    lastWeekUsd,
    priorWeekUsd,
    thisVsLastPct: deltaPctBetween(thisWeekUsd, lastWeekUsd),
    lastVsPriorPct: deltaPctBetween(lastWeekUsd, priorWeekUsd),
  };

  // Peak day: highest-total day in-window with the top feature on that
  // date. If two days tie, pick the more recent one (later in the series).
  let peakDay: ProjectDetailVM['peakDay'] = null;
  let peakUsd = 0;
  for (const d of dailySeries) {
    if (d.total >= peakUsd && d.total > 0) {
      peakUsd = d.total;
      peakDay = { date: d.date, totalUsd: d.total, featureKey: '', featureName: '' };
    }
  }
  if (peakDay) {
    const topFeat = db
      .prepare(`SELECT feature_key AS k, MAX(feature_name) AS n, SUM(total_cost_usd) AS s FROM feature_rollups WHERE ${filterSql} AND date = @peakDate GROUP BY feature_key ORDER BY s DESC LIMIT 1`)
      .get({ ...filterParams, peakDate: peakDay.date }) as { k: string; n: string; s: number } | undefined;
    if (topFeat) {
      peakDay.featureKey = topFeat.k;
      peakDay.featureName = topFeat.n ?? topFeat.k;
    }
  }

  // Unattributed block: same 'uncategorized-mainline' key the overview
  // unattributed card uses, scoped to this project. Only rendered when
  // totalUsd > 0.
  const unattTotal = round2(
    (db
      .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS s FROM feature_rollups WHERE ${filterSql} AND feature_key = 'uncategorized-mainline' AND date >= ${startExpr}`)
      .get(filterParams) as { s: number }).s
  );
  const unattSparkline = unattTotal > 0
    ? dailySeries.map((d) => ({
        date: d.date,
        usd: round2((db
          .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS s FROM feature_rollups WHERE ${filterSql} AND feature_key = 'uncategorized-mainline' AND date = @day`)
          .get({ ...filterParams, day: d.date }) as { s: number }).s),
      }))
    : [];
  const unattributed = unattTotal > 0
    ? { totalUsd: unattTotal, sparkline: unattSparkline, topFeatures: [] as Array<{ featureKey: string; featureName: string; usd: number }> }
    : null;

  return {
    projectKey: opts.projectKey,
    projectName,
    color: canonicalProjectColors(db)[opts.projectKey] ?? colorForProject(opts.projectKey),
    totalUsd: round2(head.totalUsd),
    priorUsd: round2(prior),
    deltaPct,
    avgUsdPerDay,
    weekStats,
    peakDay,
    sessionCount: distinctSessionCount,
    featureCount: features.length,
    dailySeries,
    features: featuresWithStatus,
    sessions,
    recentCommits,
    anomalies,
    unattributed,
    branchGraph,
  };
}

function uniqueSessionIds(csv: string | null): string[] {
  if (!csv) return [];
  const set = new Set<string>();
  for (const chunk of csv.split(',')) {
    const s = chunk.trim();
    if (s) set.add(s);
  }
  return [...set];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
