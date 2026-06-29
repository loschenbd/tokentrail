import { createHash } from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import { getLLMClient as defaultGetLLMClient } from '../lib/llm.js';
import { classifyCommit } from './mainline-inference-rules.js';
import { sliceEventsByCommits } from './mainline-inference-slicing.js';

export type MainlineInferenceDeps = {
  getLLMClient: typeof defaultGetLLMClient;
};

export type MainlineInferenceSummary = {
  sessionsConsidered: number;
  sessionsRelabeled: number;
  eventsRelabeled: number;
  llmCalls: number;
};

type SessionRow = { session_id: string; title: string | null };
type CommitRow = { sha: string; subject: string; authored_at: string };
type EventRow = { id: string; timestamp: string };

export async function inferMainlineFeatures(
  db: DatabaseType.Database,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  deps?: MainlineInferenceDeps
): Promise<MainlineInferenceSummary> {
  const summary: MainlineInferenceSummary = {
    sessionsConsidered: 0,
    sessionsRelabeled: 0,
    eventsRelabeled: 0,
    llmCalls: 0,
  };

  // Sessions to process: at least one mainline-bucket event, no override.
  const sessions = db
    .prepare(
      `
    SELECT DISTINCT s.session_id AS session_id, s.title AS title
    FROM usage_events e
    JOIN work_units w ON w.repo = e.repo AND w.branch = e.branch
    JOIN sessions s ON s.session_id = e.session_id
    WHERE w.feature_key GLOB 'mainline-*'
      AND (s.feature_override IS NULL OR s.feature_override = '')
  `
    )
    .all() as SessionRow[];

  summary.sessionsConsidered = sessions.length;

  const getCommits = db.prepare(`
    SELECT commit_sha AS sha, subject, authored_at
    FROM session_commits
    WHERE session_id = ?
    ORDER BY authored_at ASC
  `);

  const getEvents = db.prepare(`
    SELECT e.id AS id, e.timestamp AS timestamp
    FROM usage_events e
    JOIN work_units w ON w.repo = e.repo AND w.branch = e.branch
    WHERE e.session_id = ? AND w.feature_key GLOB 'mainline-*'
    ORDER BY e.timestamp ASC
  `);

  const getRun = db.prepare(
    `SELECT commit_set_hash FROM mainline_inference_runs WHERE session_id = ?`
  );

  const upsertRun = db.prepare(`
    INSERT INTO mainline_inference_runs (session_id, ran_at, events_relabeled, llm_calls, commit_set_hash)
    VALUES (@session_id, @ran_at, @events_relabeled, @llm_calls, @commit_set_hash)
    ON CONFLICT(session_id) DO UPDATE SET
      ran_at = excluded.ran_at,
      events_relabeled = excluded.events_relabeled,
      llm_calls = excluded.llm_calls,
      commit_set_hash = excluded.commit_set_hash
  `);

  const updateEvent = db.prepare(`
    UPDATE usage_events
       SET inferred_feature_key = @key,
           inferred_feature_name = @name,
           inference_source = @source
     WHERE id = @id
  `);

  for (const s of sessions) {
    try {
      const commits = getCommits.all(s.session_id) as CommitRow[];
      const hash = hashCommitSet(commits.map((c) => c.sha));
      const prev = getRun.get(s.session_id) as { commit_set_hash: string } | undefined;

      // Short-circuit: commit set unchanged since last run — skip entirely.
      if (prev && prev.commit_set_hash === hash) continue;

      const events = getEvents.all(s.session_id) as EventRow[];
      if (events.length === 0) continue;

      let labeled = 0;

      db.transaction(() => {
        if (commits.length === 0) {
          // No commits → Rule C: uncategorized (LLM fallback lands in Task 7).
          for (const e of events) {
            updateEvent.run({
              id: e.id,
              key: 'uncategorized-mainline',
              name: 'Uncategorized mainline',
              source: 'no-signal',
            });
            labeled++;
          }
        } else {
          const slices = sliceEventsByCommits(
            events,
            commits.map((c) => ({ sha: c.sha, authoredAt: c.authored_at }))
          );

          // Build sha → classification map (Rule A first, Rule C fallback).
          const classBySha = new Map<string, { key: string; name: string; source: string }>();
          for (const c of commits) {
            const r = classifyCommit(c.subject);
            if (r) {
              classBySha.set(c.sha, r);
            } else {
              classBySha.set(c.sha, {
                key: 'uncategorized-mainline',
                name: 'Uncategorized mainline',
                source: 'no-signal',
              });
            }
          }

          for (const slice of slices) {
            // classBySha is populated for every commit sha in slices — safe to assert.
            const cls = classBySha.get(slice.commitSha)!;
            for (const e of slice.events) {
              updateEvent.run({
                id: e.id,
                key: cls.key,
                name: cls.name,
                source: cls.source,
              });
              labeled++;
            }
          }
        }

        upsertRun.run({
          session_id: s.session_id,
          ran_at: new Date().toISOString(),
          events_relabeled: labeled,
          llm_calls: 0,
          commit_set_hash: hash,
        });
      })();

      if (labeled > 0) summary.sessionsRelabeled++;
      summary.eventsRelabeled += labeled;
    } catch (err) {
      // Project rule 6: one bad session must not crash the whole pass.
      console.error(`[mainline-inference] session ${s.session_id} failed:`, err);
    }
  }

  return summary;
}

function hashCommitSet(shas: string[]): string {
  const h = createHash('sha256');
  // Sort so insertion order doesn't affect the fingerprint.
  for (const sha of [...shas].sort()) h.update(sha);
  return h.digest('hex');
}
