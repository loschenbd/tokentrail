import type DatabaseType from 'better-sqlite3';
import { getDb } from '../db/db.js';
import { repoContextFor } from '../services/git.js';
import { knownSlugForDir } from '../db/repo-heal.js';
import { copilotCostUsd } from '../lib/cost.js';
import { refreshWorkUnits } from '../services/work-units.js';
import {
  readUsageEvents,
  copilotStorePath,
} from '../services/copilot-store-reader.js';

const WATERMARK_KEY = 'usage';

export type CopilotSummary = {
  newEvents: number;
  sessionsTouched: number;
  scanned: number;
  workUnitsInserted: number;
  workUnitsUpdated: number;
};

// Ingest GitHub Copilot CLI usage from ~/.copilot/session-store.db into
// usage_events (source='copilot'). Read side mirrors the Cursor reader
// (read-only foreign SQLite, single-row watermark, non-fatal); the write
// destination is usage_events — the Claude path — so cost/attribution/rollup/
// report all work unchanged. See docs/plans/copilot-ingest-plan.md.
export async function runCopilot(
  dbArg?: DatabaseType.Database
): Promise<CopilotSummary> {
  const db = dbArg ?? getDb();
  const path = copilotStorePath();

  const wmRow = db
    .prepare('SELECT last_row_id FROM copilot_ingest_state WHERE key = ?')
    .get(WATERMARK_KEY) as { last_row_id: number } | undefined;
  const since = wmRow?.last_row_id ?? 0;

  const events = readUsageEvents(path, since);
  if (events.length === 0) {
    console.log('Copilot: no new usage events.');
    return {
      newEvents: 0,
      sessionsTouched: 0,
      scanned: 0,
      workUnitsInserted: 0,
      workUnitsUpdated: 0,
    };
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO usage_events (
      id, session_id, timestamp, repo, branch, commit_sha,
      model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      estimated_cost_usd, source, project_dir
    ) VALUES (
      @id, @session_id, @timestamp, @repo, @branch, @commit_sha,
      @model, @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
      @estimated_cost_usd, 'copilot', @project_dir
    )
  `);

  // Resolve repo context once per cwd — running git per event is wasteful.
  const ctxCache = new Map<string, ReturnType<typeof repoContextFor>>();
  const contextFor = (cwd: string | null) => {
    if (!cwd) return { repo: null, branch: null, commitSha: null };
    let ctx = ctxCache.get(cwd);
    if (!ctx) {
      ctx = repoContextFor(cwd);
      // A local/<basename> fallback for a dir already known under a remote
      // slug is the same project — stamp the slug, don't fragment.
      if (ctx.repo?.startsWith('local/')) {
        const known = knownSlugForDir(db, cwd);
        if (known) ctx = { ...ctx, repo: known };
      }
      ctxCache.set(cwd, ctx);
    }
    return ctx;
  };

  let newEvents = 0;
  let maxRowId = since;
  const sessions = new Set<string>();

  const tx = db.transaction(() => {
    for (const e of events) {
      const ctx = contextFor(e.cwd);
      // Prefer Copilot's session-time branch (recorded natively) over git's
      // current branch, which reflects HEAD now, not during the session.
      const branch = e.branch && e.branch.length > 0 ? e.branch : ctx.branch;
      const cost = copilotCostUsd({
        model: e.model,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        cacheWriteTokens: e.cacheWriteTokens,
        cacheReadTokens: e.cacheReadTokens,
        totalNanoAiu: e.totalNanoAiu,
      });
      const result = insert.run({
        id: `copilot:${e.sessionId}:${e.rowId}`,
        session_id: e.sessionId,
        timestamp: e.timestamp,
        repo: ctx.repo,
        branch,
        commit_sha: ctx.commitSha,
        model: e.model,
        input_tokens: e.inputTokens,
        output_tokens: e.outputTokens,
        cache_read_tokens: e.cacheReadTokens,
        cache_write_tokens: e.cacheWriteTokens,
        estimated_cost_usd: cost,
        project_dir: e.cwd,
      });
      if (result.changes > 0) newEvents++;
      sessions.add(e.sessionId);
      if (e.rowId > maxRowId) maxRowId = e.rowId;
    }
    db.prepare(
      `INSERT INTO copilot_ingest_state (key, last_row_id) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET last_row_id = excluded.last_row_id`
    ).run(WATERMARK_KEY, maxRowId);
  });
  tx();

  console.log(
    `Copilot: ingested ${newEvents} new usage event${newEvents === 1 ? '' : 's'} ` +
      `from ${sessions.size} session${sessions.size === 1 ? '' : 's'} ` +
      `(estimated).`
  );

  // usage_events changed → work_units are a deterministic function of them.
  let workUnitsInserted = 0;
  let workUnitsUpdated = 0;
  if (newEvents > 0) {
    ({ inserted: workUnitsInserted, updated: workUnitsUpdated } = refreshWorkUnits(db));
  }

  return {
    newEvents,
    sessionsTouched: sessions.size,
    scanned: events.length,
    workUnitsInserted,
    workUnitsUpdated,
  };
}
