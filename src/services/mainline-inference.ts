import { createHash } from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import { getLLMClient as defaultGetLLMClient } from '../lib/llm.js';
import { slugify } from '../lib/attribution.js';
import { classifyCommit } from './mainline-inference-rules.js';
import { sliceEventsByCommits } from './mainline-inference-slicing.js';

export type MainlineInferenceProgress = {
  current: number;
  total: number;
  title: string | null;
  action: 'skip' | 'llm' | 'rules-only';
};

export type MainlineInferenceDeps = {
  getLLMClient: typeof defaultGetLLMClient;
  onProgress?: (p: MainlineInferenceProgress) => void;
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
  deps: MainlineInferenceDeps = { getLLMClient: defaultGetLLMClient }
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

  // Acquire the LLM client once and reuse across all sessions.
  const llm = deps.getLLMClient();

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!;
    try {
      const commits = getCommits.all(s.session_id) as CommitRow[];
      const hash = hashCommitSet(commits.map((c) => c.sha));
      const prev = getRun.get(s.session_id) as { commit_set_hash: string } | undefined;

      // Short-circuit: commit set unchanged since last run — skip entirely.
      if (prev && prev.commit_set_hash === hash) {
        deps.onProgress?.({ current: i + 1, total: sessions.length, title: s.title, action: 'skip' });
        continue;
      }

      const events = getEvents.all(s.session_id) as EventRow[];
      if (events.length === 0) {
        deps.onProgress?.({ current: i + 1, total: sessions.length, title: s.title, action: 'skip' });
        continue;
      }

      deps.onProgress?.({
        current: i + 1,
        total: sessions.length,
        title: s.title,
        action: llm ? 'llm' : 'rules-only',
      });

      let labeled = 0;

      if (commits.length === 0) {
        // No commits: Rule B (LLM on session title) → Rule C fallback.
        let cls: { key: string; name: string; source: string } = {
          key: 'uncategorized-mainline',
          name: 'Uncategorized mainline',
          source: 'no-signal',
        };
        if (llm) {
          summary.llmCalls++;
          try {
            const resp = await llm.client.chat.completions.create({
              model: llm.model,
              messages: [
                { role: 'system', content: 'Pick a single kebab-case topic_slug (≤30 chars) for this engineering session. STRICT JSON: {"topic_slug":string}' },
                { role: 'user', content: JSON.stringify({ session_title: s.title ?? '' }) },
              ],
              response_format: { type: 'json_object' },
              max_tokens: 200,
            });
            const parsed = JSON.parse(resp.choices[0]?.message?.content ?? '') as { topic_slug?: string };
            const raw = (parsed.topic_slug ?? '').trim();
            if (raw) {
              const key = slugify(raw);
              cls = { key, name: humanizeFromSlug(key), source: 'session-title-llm' };
            }
          } catch (e) {
            console.log(`[infer-mainline] LLM call failed (no-commits) for ${s.session_id}: ${(e as Error).message}`);
          }
        }
        db.transaction(() => {
          for (const e of events) {
            updateEvent.run({ id: e.id, key: cls.key, name: cls.name, source: cls.source });
            labeled++;
          }
          upsertRun.run({
            session_id: s.session_id,
            ran_at: new Date().toISOString(),
            events_relabeled: labeled,
            llm_calls: llm ? 1 : 0,
            commit_set_hash: hash,
          });
        })();
      } else {
        // Rule A: classify commits by conventional-commit scope.
        const classBySha = new Map<string, { key: string; name: string; source: string }>();
        const unresolved: Array<{ sha: string; subject: string }> = [];
        for (const c of commits) {
          const r = classifyCommit(c.subject);
          if (r) {
            classBySha.set(c.sha, r);
          } else {
            unresolved.push({ sha: c.sha, subject: c.subject });
          }
        }

        // Rule B: LLM classification for unresolved commits, chunked.
        //
        // Local 8B-class models (llama3.1:8b in particular) silently return
        // empty content when asked to produce large structured JSON in
        // response_format: json_object mode — a 15-commit batch reliably
        // returns "" while a 2-commit batch succeeds. Chunk to something
        // safely under that threshold. On empty content or JSON parse
        // failure, fall through to session-title-only labeling for the
        // whole chunk (better than leaving every commit uncategorized).
        if (unresolved.length > 0 && llm) {
          const CHUNK = 6;
          for (let off = 0; off < unresolved.length; off += CHUNK) {
            const batch = unresolved.slice(off, off + CHUNK);
            summary.llmCalls++;
            let sessionFallback: { key: string; name: string } | null = null;
            try {
              const resp = await llm.client.chat.completions.create({
                model: llm.model,
                messages: [
                  {
                    role: 'system',
                    content: 'You label engineering work by topic. Output STRICT JSON only matching schema {"labels":[{"commit_sha":string,"topic_slug":string}]}. Slugs are kebab-case, ≤30 chars, no commit-type words (feat/fix/chore/refactor/docs/test/perf/style/build/ci/revert).',
                  },
                  {
                    role: 'user',
                    content: JSON.stringify({
                      session_title: s.title ?? '',
                      commits: batch.map((c) => ({ sha: c.sha, subject: c.subject })),
                    }),
                  },
                ],
                response_format: { type: 'json_object' },
                max_tokens: 400,
              });
              const content = resp.choices[0]?.message?.content ?? '';
              if (!content.trim()) {
                console.log(`[infer-mainline] empty content on ${s.session_id} batch ${off}-${off + batch.length}; falling back`);
                sessionFallback = await getSessionTitleSlug(llm, s.title ?? '', sessionFallback);
              } else {
                const parsed = JSON.parse(content) as { labels?: Array<{ commit_sha: string; topic_slug: string }> };
                if (Array.isArray(parsed.labels) && parsed.labels.length > 0) {
                  for (const lbl of parsed.labels) {
                    const raw = (lbl.topic_slug ?? '').trim();
                    if (!raw) continue;
                    const key = slugify(raw);
                    classBySha.set(lbl.commit_sha, {
                      key,
                      name: humanizeFromSlug(key),
                      source: 'session-title-llm',
                    });
                  }
                } else {
                  sessionFallback = await getSessionTitleSlug(llm, s.title ?? '', sessionFallback);
                }
              }
            } catch (e) {
              console.log(
                `[infer-mainline] LLM call failed for session ${s.session_id} batch ${off}: ${(e as Error).message}`
              );
              sessionFallback = await getSessionTitleSlug(llm, s.title ?? '', sessionFallback);
            }
            // Apply session-title fallback to every commit in this batch
            // that the batch call didn't resolve.
            if (sessionFallback) {
              // If the fallback itself returned uncategorized, preserve
              // the historical inference_source='no-signal' marker so
              // callers can distinguish "labeled from a title" from
              // "genuinely could not label."
              const src = sessionFallback.key === 'uncategorized-mainline' ? 'no-signal' : 'session-title-llm';
              for (const c of batch) {
                if (!classBySha.has(c.sha)) {
                  classBySha.set(c.sha, {
                    key: sessionFallback.key,
                    name: sessionFallback.name,
                    source: src,
                  });
                }
              }
            }
          }
        }

        // Rule C: final fallback for any commit still unresolved.
        for (const c of commits) {
          if (!classBySha.has(c.sha)) {
            classBySha.set(c.sha, {
              key: 'uncategorized-mainline',
              name: 'Uncategorized mainline',
              source: 'no-signal',
            });
          }
        }

        const slices = sliceEventsByCommits(
          events,
          commits.map((c) => ({ sha: c.sha, authoredAt: c.authored_at }))
        );

        db.transaction(() => {
          for (const slice of slices) {
            // classBySha is built from the same commits passed to sliceEventsByCommits,
            // so every commitSha in a slice is guaranteed to have a class entry.
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

          upsertRun.run({
            session_id: s.session_id,
            ran_at: new Date().toISOString(),
            events_relabeled: labeled,
            llm_calls: unresolved.length > 0 && llm ? 1 : 0,
            commit_set_hash: hash,
          });
        })();
      }

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

function humanizeFromSlug(slug: string): string {
  const s = slug.replace(/-/g, ' ').trim();
  if (!s) return 'Uncategorized';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Rule B fallback used when the per-commit batch call fails or comes back
// empty. Asks the LLM for a single topic slug for the whole session — a
// much smaller prompt that succeeds where the batch didn't. Cached per
// session so we only pay once even if multiple batches fall through.
async function getSessionTitleSlug(
  llm: NonNullable<ReturnType<typeof defaultGetLLMClient>>,
  title: string,
  cached: { key: string; name: string } | null
): Promise<{ key: string; name: string }> {
  if (cached) return cached;
  try {
    const resp = await llm.client.chat.completions.create({
      model: llm.model,
      messages: [
        { role: 'system', content: 'Pick a single kebab-case topic_slug (≤30 chars) for this engineering session. STRICT JSON: {"topic_slug":string}' },
        { role: 'user', content: JSON.stringify({ session_title: title }) },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 200,
    });
    const parsed = JSON.parse(resp.choices[0]?.message?.content ?? '') as { topic_slug?: string };
    const raw = (parsed.topic_slug ?? '').trim();
    if (raw) {
      const key = slugify(raw);
      return { key, name: humanizeFromSlug(key) };
    }
  } catch { /* fall through */ }
  return { key: 'uncategorized-mainline', name: 'Uncategorized mainline' };
}
