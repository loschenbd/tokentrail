import { createHash, randomUUID } from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import OpenAI from 'openai';

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
//     a network failure must not crash the rollup. Errors are logged and the
//     run record is NOT written, so the next rollup retries.

const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MIN_SESSIONS_FOR_CLUSTERING = 5;
const MAX_TITLES_PER_FEATURE = 80;
const MAX_COMMITS_PER_SESSION = 3;

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
    llmCalls: 0,
  };

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.log(
      'OPENROUTER_API_KEY not set. Add it to .env to enable topic clustering.'
    );
    return summary;
  }
  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;

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

  const client = new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    // OpenRouter recommends attribution headers — surface tokentrail so
    // your usage shows up cleanly in the OpenRouter dashboard.
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/benjaminloschen/tokentrail',
      'X-Title': 'Tokentrail',
    },
  });
  const upsertRun = db.prepare(
    `INSERT INTO feature_cluster_runs (feature_key, session_count, session_id_hash, computed_at)
     VALUES (@feature_key, @session_count, @session_id_hash, datetime('now'))
     ON CONFLICT(feature_key) DO UPDATE SET
       session_count   = excluded.session_count,
       session_id_hash = excluded.session_id_hash,
       computed_at     = excluded.computed_at`
  );
  const lastRun = db.prepare(
    `SELECT session_count, session_id_hash FROM feature_cluster_runs WHERE feature_key = ?`
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
      | { session_count: number; session_id_hash: string }
      | undefined;
    if (prev && prev.session_id_hash === fingerprint) {
      summary.featuresSkipped++;
      continue;
    }

    const sessions = loadSessions(db, sessionIds);
    let clusters: ClusterResult[];
    try {
      clusters = await callClusterer(client, model, f.feature_name, sessions);
      summary.llmCalls++;
    } catch (err) {
      summary.featuresFailed++;
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

  const response = await client.chat.completions.create({
    model,
    max_tokens: 2000,
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
