import { getDb } from '../db/db.js';
import { listSessionFiles, readUsageEvents } from '../services/jsonl-reader.js';
import { decodeProjectDir, repoContextFor } from '../services/git.js';
import { estimateCostUsd } from '../lib/cost.js';

export type IngestSummary = {
  newEvents: number;
  sessionsTouched: number;
  filesScanned: number;
};

export async function runIngest(): Promise<IngestSummary> {
  const files = listSessionFiles();
  if (files.length === 0) {
    console.log(
      'No Claude session logs found. Trail is empty — nothing to ingest.'
    );
    return { newEvents: 0, sessionsTouched: 0, filesScanned: 0 };
  }

  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO usage_events (
      id, session_id, timestamp, repo, branch, commit_sha,
      model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      estimated_cost_usd, source
    ) VALUES (
      @id, @session_id, @timestamp, @repo, @branch, @commit_sha,
      @model, @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
      @estimated_cost_usd, 'jsonl'
    )
  `);

  // Cache repo context per encoded project dir — running git per event is wasteful.
  const repoCache = new Map<string, ReturnType<typeof repoContextFor>>();

  let newEvents = 0;
  const sessions = new Set<string>();

  const tx = db.transaction((rows: Array<Record<string, unknown>>) => {
    for (const row of rows) {
      const result = insert.run(row);
      if (result.changes > 0) newEvents++;
      sessions.add(row.session_id as string);
    }
  });

  const batch: Array<Record<string, unknown>> = [];
  const BATCH_SIZE = 500;

  for await (const event of readUsageEvents(files)) {
    let ctx = repoCache.get(event.projectDirEncoded);
    if (!ctx) {
      const dir = decodeProjectDir(event.projectDirEncoded);
      ctx = repoContextFor(dir);
      repoCache.set(event.projectDirEncoded, ctx);
    }

    const cost = estimateCostUsd({
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheWriteTokens: event.cacheWriteTokens,
      cacheReadTokens: event.cacheReadTokens,
    });

    batch.push({
      id: event.eventId,
      session_id: event.sessionId,
      timestamp: event.timestamp,
      repo: ctx.repo,
      branch: ctx.branch,
      commit_sha: ctx.commitSha,
      model: event.model,
      input_tokens: event.inputTokens,
      output_tokens: event.outputTokens,
      cache_read_tokens: event.cacheReadTokens,
      cache_write_tokens: event.cacheWriteTokens,
      estimated_cost_usd: cost,
    });

    if (batch.length >= BATCH_SIZE) {
      tx(batch);
      batch.length = 0;
    }
  }
  if (batch.length > 0) tx(batch);

  console.log(
    `Trail updated: ${newEvents} new usage event${newEvents === 1 ? '' : 's'} ` +
      `from ${sessions.size} session${sessions.size === 1 ? '' : 's'} ` +
      `across ${files.length} file${files.length === 1 ? '' : 's'}.`
  );

  return {
    newEvents,
    sessionsTouched: sessions.size,
    filesScanned: files.length,
  };
}
