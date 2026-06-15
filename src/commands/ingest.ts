import { getDb } from '../db/db.js';
import { listSessionFiles, readUsageEvents } from '../services/jsonl-reader.js';
import { decodeProjectDir, repoContextFor } from '../services/git.js';
import { estimateCostUsd } from '../lib/cost.js';
import { refreshWorkUnits } from '../services/work-units.js';
import {
  applyHookSnapshots,
  loadLatestHookSnapshots,
} from '../services/hook-snapshots.js';

export type IngestSummary = {
  newEvents: number;
  sessionsTouched: number;
  filesScanned: number;
  workUnitsInserted: number;
  workUnitsUpdated: number;
};

export async function runIngest(): Promise<IngestSummary> {
  const files = listSessionFiles();
  if (files.length === 0) {
    console.log(
      'No Claude session logs found. Trail is empty — nothing to ingest.'
    );
    return {
      newEvents: 0,
      sessionsTouched: 0,
      filesScanned: 0,
      workUnitsInserted: 0,
      workUnitsUpdated: 0,
    };
  }

  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO usage_events (
      id, session_id, timestamp, repo, branch, commit_sha,
      model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      estimated_cost_usd, source, project_dir
    ) VALUES (
      @id, @session_id, @timestamp, @repo, @branch, @commit_sha,
      @model, @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
      @estimated_cost_usd, 'jsonl', @project_dir
    )
  `);

  // Backfill project_dir on existing rows. We overwrite previous values too
  // because the fs-aware decoder gives better paths than older naive
  // decodes (e.g. "foo/bar" → "foo-bar" when foo-bar exists as a single dir).
  const backfillProjectDir = db.prepare(`
    UPDATE usage_events SET project_dir = @project_dir
    WHERE id = @id AND (project_dir IS NULL OR project_dir != @project_dir)
  `);

  // Backfill repo/branch/commit on rows where the decoded project dir is
  // now a git repo but the row still has null repo. Hook snapshots remain
  // the strongest signal, so we don't touch rows that already have a branch.
  const backfillRepoCtx = db.prepare(`
    UPDATE usage_events
    SET repo = @repo,
        branch = @branch,
        commit_sha = @commit_sha
    WHERE id = @id
      AND (repo IS NULL OR repo = '')
  `);

  // Cache repo context per encoded project dir — running git per event is wasteful.
  const repoCache = new Map<string, ReturnType<typeof repoContextFor>>();

  let newEvents = 0;
  let backfilledDir = 0;
  let backfilledRepo = 0;
  const sessions = new Set<string>();

  const tx = db.transaction((rows: Array<Record<string, unknown>>) => {
    for (const row of rows) {
      const result = insert.run(row);
      if (result.changes > 0) {
        newEvents++;
      } else {
        if (row.project_dir) {
          const r = backfillProjectDir.run({
            id: row.id,
            project_dir: row.project_dir,
          });
          if (r.changes > 0) backfilledDir++;
        }
        if (row.repo) {
          const r = backfillRepoCtx.run({
            id: row.id,
            repo: row.repo,
            branch: row.branch,
            commit_sha: row.commit_sha,
          });
          if (r.changes > 0) backfilledRepo++;
        }
      }
      sessions.add(row.session_id as string);
    }
  });

  const batch: Array<Record<string, unknown>> = [];
  const BATCH_SIZE = 500;

  // Decoded paths cached alongside ctx so we don't re-resolve per event.
  const dirCache = new Map<string, string>();

  for await (const event of readUsageEvents(files)) {
    let ctx = repoCache.get(event.projectDirEncoded);
    let projectDir = dirCache.get(event.projectDirEncoded);
    if (!ctx) {
      const dir = decodeProjectDir(event.projectDirEncoded);
      projectDir = dir;
      dirCache.set(event.projectDirEncoded, dir);
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
      project_dir: projectDir ?? null,
    });

    if (batch.length >= BATCH_SIZE) {
      tx(batch);
      batch.length = 0;
    }
  }
  if (batch.length > 0) tx(batch);

  // Merge Stop-hook snapshots before computing work_units. Hook data is
  // a stronger branch signal than ingest-time HEAD, so apply it first.
  const snapshots = await loadLatestHookSnapshots();
  const hookResult = applyHookSnapshots(db, snapshots);

  const { inserted, updated } = refreshWorkUnits(db);

  console.log(
    `Trail updated: ${newEvents} new usage event${newEvents === 1 ? '' : 's'} ` +
      `from ${sessions.size} session${sessions.size === 1 ? '' : 's'} ` +
      `across ${files.length} file${files.length === 1 ? '' : 's'}.`
  );
  if (hookResult.sessionsCovered > 0) {
    console.log(
      `Hook backfill: refined ${hookResult.updated} event${hookResult.updated === 1 ? '' : 's'} ` +
        `across ${hookResult.sessionsCovered} session${hookResult.sessionsCovered === 1 ? '' : 's'}.`
    );
  }
  if (backfilledDir > 0) {
    console.log(
      `Project dir backfill: stamped ${backfilledDir} pre-existing event${backfilledDir === 1 ? '' : 's'}.`
    );
  }
  if (backfilledRepo > 0) {
    console.log(
      `Repo backfill: attributed ${backfilledRepo} pre-existing event${backfilledRepo === 1 ? '' : 's'} to a now-detectable repo.`
    );
  }
  console.log(
    `Work units: ${inserted} new, ${updated} updated.`
  );

  return {
    newEvents,
    sessionsTouched: sessions.size,
    filesScanned: files.length,
    workUnitsInserted: inserted,
    workUnitsUpdated: updated,
  };
}
