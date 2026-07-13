import { createHash, randomUUID } from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import type OpenAI from 'openai';
import { getLLMClient } from '../lib/llm.js';

// One LLM call per feature, grouped by feature_key. Each call returns a list
// of named topic clusters covering every session in that feature.
//
// Design notes:
//   - We hit OpenRouter via the OpenAI-compatible SDK. Override the model
//     with OPENROUTER_MODEL if you want a different provider/model.
//   - Triggered from the rollup tail; skipped when the session set hasn't
//     changed since the last successful cluster run for that feature.
//   - Minimum 5 sessions per feature — anything smaller is just the session
//     list itself, no value in renaming.
//   - Each session contributes its title + up to 3 commit subjects as signal.
//   - Cost-defensive: Haiku is cheap, but a missing OPENROUTER_API_KEY or
//     a network failure must not crash the rollup. Errors are logged, and a
//     feature that keeps failing on the SAME session-set fingerprint backs
//     off exponentially (2 min doubling to a 24 h cap) instead of retrying
//     every rollup — a per-minute pipeline retrying a doomed call kept the
//     local Ollama model resident around the clock. A changed fingerprint
//     (new sessions) resets the backoff and retries immediately.

const MIN_SESSIONS_FOR_CLUSTERING = 5;
const MAX_TITLES_PER_FEATURE = 80;
const MAX_COMMITS_PER_SESSION = 3;
const FAIL_BACKOFF_BASE_MIN = 2;
const FAIL_BACKOFF_CAP_MIN = 24 * 60;

type SessionForClustering = {
  sessionId: string;
  title: string;
  cost: number;
  commits: string[];
};

type ClusterResult = {
  name: string;
  session_ids: string[];
};

export type ClusterSummary = {
  featuresConsidered: number;
  featuresClustered: number;
  featuresSkipped: number;
  featuresFailed: number;
  // Features skipped this run because a previous failure on the same
  // fingerprint is still inside its backoff window.
  featuresBackedOff: number;
  llmCalls: number;
};

export async function recomputeClusters(
  db: DatabaseType.Database
): Promise<ClusterSummary> {
  const summary: ClusterSummary = {
    featuresConsidered: 0,
    featuresClustered: 0,
    featuresSkipped: 0,
    featuresFailed: 0,
    featuresBackedOff: 0,
    llmCalls: 0,
  };

  const llm = getLLMClient();
  if (!llm) {
    console.log(
      'No LLM backend configured. Run `tokentrail llm setup` (or set OPENROUTER_API_KEY) to enable topic clustering.'
    );
    return summary;
  }
  const model = llm.model;
  const client = llm.client;

  const features = db
    .prepare(
      `SELECT feature_key,
              MAX(feature_name) AS feature_name,
              GROUP_CONCAT(DISTINCT session_ids) AS session_ids_csv,
              SUM(sessions_count) AS sessions_count
       FROM feature_rollups
       WHERE session_ids IS NOT NULL AND session_ids != ''
       GROUP BY feature_key
       HAVING sessions_count >= ${MIN_SESSIONS_FOR_CLUSTERING}`
    )
    .all() as Array<{
    feature_key: string;
    feature_name: string;
    session_ids_csv: string;
    sessions_count: number;
  }>;

  if (features.length === 0) return summary;

  // Success clears any failure state so a later failure starts backoff fresh.
  const upsertRun = db.prepare(
    `INSERT INTO feature_cluster_runs (feature_key, session_count, session_id_hash, computed_at)
     VALUES (@feature_key, @session_count, @session_id_hash, datetime('now'))
     ON CONFLICT(feature_key) DO UPDATE SET
       session_count   = excluded.session_count,
       session_id_hash = excluded.session_id_hash,
       computed_at     = excluded.computed_at,
       failed_hash     = NULL,
       fail_count      = 0,
       last_failed_at  = NULL`
  );
  // Failure keeps the last successful session_id_hash intact (session_id_hash
  // '' on first-ever insert can never match a real fingerprint) and counts
  // consecutive failures of the SAME fingerprint; a different fingerprint
  // restarts the count at 1.
  const upsertFailure = db.prepare(
    `INSERT INTO feature_cluster_runs
       (feature_key, session_count, session_id_hash, computed_at, failed_hash, fail_count, last_failed_at)
     VALUES (@feature_key, @session_count, '', datetime('now'), @failed_hash, 1, datetime('now'))
     ON CONFLICT(feature_key) DO UPDATE SET
       failed_hash    = excluded.failed_hash,
       fail_count     = CASE
         WHEN feature_cluster_runs.failed_hash = excluded.failed_hash
           THEN feature_cluster_runs.fail_count + 1
         ELSE 1
       END,
       last_failed_at = excluded.last_failed_at`
  );
  const lastRun = db.prepare(
    `SELECT session_count, session_id_hash, failed_hash, fail_count, last_failed_at
     FROM feature_cluster_runs WHERE feature_key = ?`
  );
  const clearClusters = db.prepare(
    `DELETE FROM feature_clusters WHERE feature_key = ?`
  );
  const insertCluster = db.prepare(
    `INSERT INTO feature_clusters
       (id, feature_key, cluster_name, session_ids, session_count, total_usd, rank, computed_at)
     VALUES
       (@id, @feature_key, @cluster_name, @session_ids, @session_count, @total_usd, @rank, datetime('now'))`
  );

  for (const f of features) {
    summary.featuresConsidered++;
    const sessionIds = uniqueSessionIds(f.session_ids_csv);
    if (sessionIds.length < MIN_SESSIONS_FOR_CLUSTERING) {
      summary.featuresSkipped++;
      continue;
    }

    const fingerprint = fingerprintFor(sessionIds);
    const prev = lastRun.get(f.feature_key) as
      | {
          session_count: number;
          session_id_hash: string;
          failed_hash: string | null;
          fail_count: number;
          last_failed_at: string | null;
        }
      | undefined;
    if (prev && prev.session_id_hash === fingerprint) {
      summary.featuresSkipped++;
      continue;
    }
    if (
      prev &&
      prev.failed_hash === fingerprint &&
      prev.fail_count > 0 &&
      prev.last_failed_at &&
      !backoffElapsed(prev.last_failed_at, prev.fail_count)
    ) {
      summary.featuresBackedOff++;
      continue;
    }

    const sessions = loadSessions(db, sessionIds);
    let clusters: ClusterResult[];
    try {
      clusters = await callClusterer(client, model, f.feature_name, sessions);
      summary.llmCalls++;
    } catch (err) {
      summary.featuresFailed++;
      upsertFailure.run({
        feature_key: f.feature_key,
        session_count: sessionIds.length,
        failed_hash: fingerprint,
      });
      console.error(
        `Cluster: failed to cluster feature "${f.feature_key}":`,
        err instanceof Error ? err.message : err
      );
      continue;
    }

    const enriched = scoreClusters(clusters, sessions);

    const tx = db.transaction(() => {
      clearClusters.run(f.feature_key);
      enriched.forEach((c, i) => {
        insertCluster.run({
          id: randomUUID(),
          feature_key: f.feature_key,
          cluster_name: c.name,
          session_ids: c.sessionIds.join(','),
          session_count: c.sessionIds.length,
          total_usd: c.totalUsd,
          rank: i,
        });
      });
      upsertRun.run({
        feature_key: f.feature_key,
        session_count: sessionIds.length,
        session_id_hash: fingerprint,
      });
    });
    tx();
    summary.featuresClustered++;
  }

  return summary;
}

// True when the retry window for the given consecutive-failure count has
// passed. Delay doubles per failure from FAIL_BACKOFF_BASE_MIN, capped at
// FAIL_BACKOFF_CAP_MIN (2, 4, 8, … minutes → 24 h). last_failed_at is
// SQLite's UTC "YYYY-MM-DD HH:MM:SS".
function backoffElapsed(lastFailedAt: string, failCount: number): boolean {
  const failedMs = Date.parse(lastFailedAt.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(failedMs)) return true;
  const delayMin = Math.min(
    FAIL_BACKOFF_BASE_MIN * 2 ** (failCount - 1),
    FAIL_BACKOFF_CAP_MIN
  );
  return Date.now() - failedMs >= delayMin * 60_000;
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

function fingerprintFor(sessionIds: string[]): string {
  const hash = createHash('sha256');
  for (const s of [...sessionIds].sort()) hash.update(s);
  return hash.digest('hex');
}

function loadSessions(
  db: DatabaseType.Database,
  sessionIds: string[]
): SessionForClustering[] {
  if (sessionIds.length === 0) return [];
  const placeholder = `(SELECT value FROM json_each(?))`;
  const rows = db
    .prepare(
      `SELECT s.session_id AS sessionId,
              COALESCE(s.title, '(no title)') AS title,
              COALESCE(
                (SELECT SUM(e.estimated_cost_usd) FROM usage_events e
                  WHERE e.session_id = s.session_id),
                0
              ) AS cost
       FROM sessions s
       WHERE s.session_id IN ${placeholder}`
    )
    .all(JSON.stringify(sessionIds)) as Array<{
    sessionId: string;
    title: string;
    cost: number;
  }>;
  const commitStmt = db.prepare(
    `SELECT subject FROM session_commits
     WHERE session_id = ? AND subject IS NOT NULL AND subject != ''
     ORDER BY authored_at LIMIT ${MAX_COMMITS_PER_SESSION}`
  );
  const truncated = rows.slice(0, MAX_TITLES_PER_FEATURE);
  return truncated.map((r) => ({
    sessionId: r.sessionId,
    title: r.title.slice(0, 200),
    cost: r.cost,
    commits: (commitStmt.all(r.sessionId) as Array<{ subject: string }>).map(
      (c) => c.subject.slice(0, 120)
    ),
  }));
}

async function callClusterer(
  client: OpenAI,
  model: string,
  featureName: string,
  sessions: SessionForClustering[]
): Promise<ClusterResult[]> {
  const lines = sessions.map((s) => {
    const commitText = s.commits.length
      ? `\n      commits: ${s.commits.join(' | ')}`
      : '';
    return `  - id: ${s.sessionId}\n    title: ${s.title}${commitText}`;
  });

  const prompt = `You are grouping Claude Code sessions for project "${featureName}" into 3-6 named topic clusters.

Sessions:
${lines.join('\n')}

Return ONLY valid JSON in this exact shape, no prose, no markdown fences:
[
  {"name": "<2-5 word noun phrase>", "session_ids": ["<id>", "<id>"]},
  ...
]

Rules:
- Each session id appears in EXACTLY ONE cluster.
- Pick 3-6 clusters (fewer is fine if sessions are uniform).
- Cluster names are short, specific noun phrases ("Sidebar redesign", "Auth refactor"). Avoid "Miscellaneous" / "Other" unless truly nothing fits.
- No duplicate names.`;

  // OpenRouter free-tier accounts cap per-request max_tokens (~5k as of
  // 2026-06). Default keeps clear of that; override with OPENROUTER_MAX_TOKENS
  // if you're on a paid plan and want headroom for very large features.
  const maxTokens = Number.parseInt(process.env.OPENROUTER_MAX_TOKENS || '3500', 10);
  const response = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.choices[0]?.message?.content ?? '';
  return parseAndValidate(text, sessions.map((s) => s.sessionId));
}

function parseAndValidate(text: string, validIds: string[]): ClusterResult[] {
  // The model usually returns a bare JSON array, but defensive trim handles
  // an occasional leading "```json" fence if a sampling glitch sneaks through.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error('Cluster response was not a JSON array');
  }
  const validSet = new Set(validIds);
  const seen = new Set<string>();
  const out: ClusterResult[] = [];
  for (const c of parsed) {
    if (!c || typeof c !== 'object') continue;
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name) continue;
    const ids: string[] = [];
    if (Array.isArray(c.session_ids)) {
      for (const id of c.session_ids) {
        if (typeof id !== 'string') continue;
        if (!validSet.has(id) || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
    }
    if (ids.length === 0) continue;
    out.push({ name, session_ids: ids });
  }
  // Sweep any session the model dropped on the floor into a synthetic
  // "Other" cluster — the dashboard expects every session to be reachable.
  const missing = validIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    out.push({ name: 'Other', session_ids: missing });
  }
  if (out.length === 0) {
    throw new Error('Cluster response produced no valid clusters');
  }
  return out;
}

type ScoredCluster = {
  name: string;
  sessionIds: string[];
  totalUsd: number;
};

function scoreClusters(
  clusters: ClusterResult[],
  sessions: SessionForClustering[]
): ScoredCluster[] {
  const costBySession = new Map<string, number>();
  for (const s of sessions) costBySession.set(s.sessionId, s.cost);
  return clusters
    .map((c) => ({
      name: c.name,
      sessionIds: c.session_ids,
      totalUsd: c.session_ids.reduce(
        (a, id) => a + (costBySession.get(id) ?? 0),
        0
      ),
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd);
}
