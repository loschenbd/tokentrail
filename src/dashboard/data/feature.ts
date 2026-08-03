import type DatabaseType from 'better-sqlite3';
import {
  dedupeCommits,
  deriveShipped,
  parseRelease,
  type CommitInput,
  type ShippedPr,
  type ShippedRelease,
} from './feature-shipped.js';
import { STALE_DAYS } from './branches.js';

export type FeatureDetailVM = {
  featureKey: string;
  featureName: string;
  totalUsd: number;
  status: 'opened' | 'closed' | 'stale';
  // null when the prior window's spend was 0 (no honest baseline for a %).
  deltaPct: number | null;
  sessionCount: number;
  branches: string[];
  // Computed accounting for the statement header.
  mergedPrCount: number;
  commitCount: number; // deduped work items (squash twins collapsed, releases out)
  releaseCount: number;
  costPerPr: number | null;
  costPerCommit: number | null;
  activeDays: number;
  dailySeries: Array<{ date: string; total: number; commits: number; prs: number }>;
  // Discrete events for the adaptive timeline / event strip.
  events: Array<{ date: string; type: 'commit' | 'pr' | 'release'; label: string; url: string | null }>;
  // "What shipped": merged PRs grouped under the release they rode, newest first.
  releases: ShippedRelease[];
  clusters: Array<{
    name: string;
    sessionIds: string[];
    sessionCount: number;
    totalUsd: number;
  }>;
  sessions: Array<{
    sessionId: string;
    title: string | null;
    date: string | null;
    cost: number;
    commits: Array<{ sha: string; subject: string; repo: string | null }>;
    prs: Array<{ repo: string; prNumber: number; title: string; url: string; state: string }>;
  }>;
};

export function buildFeatureDetail(
  db: DatabaseType.Database,
  opts: { featureKey: string; days: number }
): FeatureDetailVM | null {
  const days = Math.max(1, opts.days);
  const startExpr = `date('now', '-${days - 1} days', 'localtime')`;
  const priorStartExpr = `date('now', '-${days * 2 - 1} days', 'localtime')`;
  const priorEndExpr = `date('now', '-${days} days', 'localtime')`;

  const head = db
    .prepare(`
      SELECT MAX(feature_name) AS featureName,
             COALESCE(SUM(total_cost_usd), 0) AS totalUsd,
             COALESCE(SUM(sessions_count), 0) AS sessionCount,
             GROUP_CONCAT(DISTINCT branches) AS branches,
             GROUP_CONCAT(DISTINCT session_ids) AS sessionIds
      FROM feature_rollups
      WHERE feature_key = @key AND date >= ${startExpr}
    `)
    .get({ key: opts.featureKey }) as {
      featureName: string | null;
      totalUsd: number;
      sessionCount: number;
      branches: string | null;
      sessionIds: string | null;
    };
  if (head.totalUsd === 0 && !head.featureName) return null;

  const prior = (db
    .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM feature_rollups WHERE feature_key = @key AND date >= ${priorStartExpr} AND date <= ${priorEndExpr}`)
    .get({ key: opts.featureKey }) as { total: number }).total;
  // Only a real prior-window baseline earns a delta; a first-window feature
  // showed a meaningless "▲100%" before.
  const deltaPct = prior > 0 ? Math.round(((head.totalUsd - prior) / prior) * 100) : null;

  const dailyRows = db
    .prepare(`SELECT date, SUM(total_cost_usd) AS total FROM feature_rollups WHERE feature_key = @key AND date >= ${startExpr} GROUP BY date ORDER BY date`)
    .all({ key: opts.featureKey }) as Array<{ date: string; total: number }>;

  const branches = (head.branches ?? '')
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  const uniqueBranches = [...new Set(branches)].sort();

  const sessionIds = uniqueSessionIds(head.sessionIds);

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

  const dailySeries: FeatureDetailVM['dailySeries'] = dailyRows.map((r) => ({
    date: r.date,
    total: r.total,
    commits: commitsMap.get(r.date) ?? 0,
    prs: prsMap.get(r.date) ?? 0,
  }));

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
        ORDER BY cost DESC
      `)
      .all(JSON.stringify(sessionIds)) as Array<{
        sessionId: string;
        title: string | null;
        date: string | null;
        cost: number;
      }>;

  const commitStmt = db.prepare(`SELECT commit_sha AS sha, subject, repo FROM session_commits WHERE session_id = ? ORDER BY authored_at`);
  const prStmt = db.prepare(`SELECT repo, pr_number AS prNumber, pr_title AS title, pr_url AS url, pr_state AS state FROM session_prs WHERE session_id = ? ORDER BY repo, pr_number`);

  const sessions = sessionRows.map((s) => ({
    sessionId: s.sessionId,
    title: s.title,
    date: s.date,
    cost: round2(s.cost),
    commits: commitStmt.all(s.sessionId) as FeatureDetailVM['sessions'][number]['commits'],
    prs: prStmt.all(s.sessionId) as FeatureDetailVM['sessions'][number]['prs'],
  }));

  const clusterRows = db
    .prepare(
      `SELECT cluster_name AS name, session_ids AS sessionIdsCsv,
              session_count AS sessionCount, total_usd AS totalUsd
       FROM feature_clusters
       WHERE feature_key = ?
       ORDER BY rank ASC`
    )
    .all(opts.featureKey) as Array<{
      name: string;
      sessionIdsCsv: string;
      sessionCount: number;
      totalUsd: number;
    }>;
  // Scope each cluster's sessionIds to the in-window session set so a
  // 30d view doesn't surface sessions that fall outside the window.
  const windowSessionSet = new Set(sessionIds);
  const clusters: FeatureDetailVM['clusters'] = clusterRows
    .map((c) => {
      const ids = c.sessionIdsCsv
        .split(',')
        .map((s) => s.trim())
        .filter((s) => windowSessionSet.has(s));
      return {
        name: c.name,
        sessionIds: ids,
        sessionCount: ids.length,
        totalUsd: round2(c.totalUsd),
      };
    })
    .filter((c) => c.sessionCount > 0);

  // feature_rollups.sessions_count is a per-row count, so SUMming it
  // double-counts any session that spans multiple days. The distinct
  // count of session_ids we already resolved IS the right number.
  const distinctSessionCount = sessionIds.length;

  // Map each session to the earliest rollup date it appears in, so we
  // can fall back to that when sessions.first_seen_at is NULL (the
  // chart filters out null dates, which silently drops the session).
  const earliestDateBySession = new Map<string, string>();
  for (const r of db
    .prepare(`SELECT date, session_ids FROM feature_rollups WHERE feature_key = @key AND date >= ${startExpr} ORDER BY date`)
    .all({ key: opts.featureKey }) as Array<{ date: string; session_ids: string | null }>) {
    if (!r.session_ids) continue;
    for (const sid of r.session_ids.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!earliestDateBySession.has(sid)) earliestDateBySession.set(sid, r.date);
    }
  }
  const sessionsWithDateFallback = sessions.map((s) =>
    s.date ? s : { ...s, date: earliestDateBySession.get(s.sessionId) ?? null }
  );

  // --- Shipped-output accounting (What shipped, header stats, event timeline) ---
  // All commits + PRs across the feature's sessions, deduped, for derivation.
  const allCommits: CommitInput[] = sessionIds.length === 0
    ? []
    : (db
        .prepare(`SELECT DISTINCT commit_sha AS sha, subject, repo, authored_at AS authoredAt
                  FROM session_commits WHERE session_id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(sessionIds)) as Array<{ sha: string; subject: string; repo: string | null; authoredAt: string | null }>);
  const allPrs = sessionIds.length === 0
    ? []
    : (db
        .prepare(`SELECT DISTINCT repo, pr_number AS prNumber, pr_title AS title, pr_url AS url,
                         pr_state AS state, merged_at AS mergedAt
                  FROM session_prs WHERE session_id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(sessionIds)) as Array<{ repo: string; prNumber: number; title: string; url: string; state: string; mergedAt: string | null }>);

  const dedup = dedupeCommits(allCommits);
  const prByNumber = new Map<number, ShippedPr>(
    allPrs.map((p) => [p.prNumber, { repo: p.repo, prNumber: p.prNumber, title: p.title, url: p.url }])
  );
  const releases = deriveShipped(allCommits, prByNumber);

  const mergedPrs = allPrs.filter((p) => p.state === 'merged' && p.mergedAt);
  const mergedPrCount = new Set(mergedPrs.map((p) => `${p.repo}#${p.prNumber}`)).size;
  const commitCount = dedup.workItemCount;
  const total = round2(head.totalUsd);
  const costPerPr = mergedPrCount > 0 ? round2(total / mergedPrCount) : null;
  const costPerCommit = commitCount > 0 ? round2(total / commitCount) : null;

  // Discrete events for the timeline: plain commits (ticks), merged PRs
  // (diamonds), releases (flags). Day-resolution so they line up with the axis.
  const dayOf = (ts: string | null): string | null => (ts ? ts.slice(0, 10) : null);
  const events: FeatureDetailVM['events'] = [];
  for (const c of dedup.changeCommits) {
    const d = dayOf(c.authoredAt);
    if (d) events.push({ date: d, type: 'commit', label: c.subject, url: null });
  }
  for (const p of mergedPrs) {
    const d = dayOf(p.mergedAt);
    if (d) events.push({ date: d, type: 'pr', label: `#${p.prNumber} ${p.title}`, url: p.url || null });
  }
  for (const c of allCommits) {
    const v = parseRelease(c.subject);
    const d = dayOf(c.authoredAt);
    if (v && d) events.push({ date: d, type: 'release', label: v, url: null });
  }

  // Lifecycle status: a merged PR means shipped (closed) regardless of window;
  // else aged past STALE_DAYS is stale; else opened. Mirrors the project page.
  const lastActive = dailySeries.length > 0 ? dailySeries[dailySeries.length - 1]!.date : '';
  const staleBefore = (db
    .prepare(`SELECT date('now', 'localtime', '-${STALE_DAYS} days') AS d`)
    .get() as { d: string }).d;
  const status: 'opened' | 'closed' | 'stale' =
    mergedPrCount > 0 ? 'closed' : (lastActive && lastActive < staleBefore ? 'stale' : 'opened');

  // A session's `cost` is its GLOBAL spend, which can exceed the feature total
  // when the session also touched other features. Scale each session's cost so
  // the ledger sums to the feature total (share ∝ global spend) — otherwise the
  // "share of total" waterfall bar overflows and the numbers contradict the
  // header. Scaling preserves the cost-desc ordering.
  const globalSum = sessionsWithDateFallback.reduce((s, x) => s + x.cost, 0);
  const scale = globalSum > 0 ? total / globalSum : 1;
  // Ledger commits: drop squash twins + release commits so the drill-down is the
  // real work, with the merged PRs shown separately on the row.
  const ledgerSessions = sessionsWithDateFallback.map((s) => ({
    ...s,
    cost: round2(s.cost * scale),
    commits: dedupeCommits(
      s.commits.map((c) => ({ sha: c.sha, subject: c.subject, authoredAt: null, repo: c.repo }))
    ).changeCommits.map((c) => ({ sha: c.sha, subject: c.subject, repo: c.repo })),
  }));

  return {
    featureKey: opts.featureKey,
    featureName: head.featureName ?? opts.featureKey,
    totalUsd: total,
    status,
    deltaPct,
    sessionCount: distinctSessionCount,
    branches: uniqueBranches,
    mergedPrCount,
    commitCount,
    releaseCount: dedup.releaseCount,
    costPerPr,
    costPerCommit,
    activeDays: dailySeries.length,
    dailySeries,
    events,
    releases,
    clusters,
    sessions: ledgerSessions,
  };
}

function uniqueSessionIds(csvOrNull: string | null): string[] {
  if (!csvOrNull) return [];
  const set = new Set<string>();
  for (const chunk of csvOrNull.split(',')) {
    const s = chunk.trim();
    if (s) set.add(s);
  }
  return [...set];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
