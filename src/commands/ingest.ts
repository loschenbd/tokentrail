import { statSync } from 'node:fs';
import { getDb } from '../db/db.js';
import {
  listSessionFiles,
  scanSessionFile,
} from '../services/jsonl-reader.js';
import type { AssistantUsage } from '../services/jsonl-reader.js';
import { decodeProjectDir, repoContextFor } from '../services/git.js';
import { knownSlugForDir } from '../db/repo-heal.js';
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
  filesSkipped: number;
  workUnitsInserted: number;
  workUnitsUpdated: number;
};

// Bump to force a full re-read of files whose (size, mtime) watermark is
// unchanged — needed when parsing improves in place (e.g. better title
// extraction or project-dir decoding) and should re-stamp old sessions.
//
// v2: `size` now records the byte offset after the last line the scan
// actually parsed (== file size when the file ends with a newline), and
// a grown file is re-read from that offset instead of byte 0. v1 stored
// the raw stat size, which could sit past an unparsed mid-write line
// fragment — unsafe to resume from, hence the bump.
const INGEST_SCAN_VERSION = 2;

export async function runIngest(): Promise<IngestSummary> {
  const allFiles = listSessionFiles();
  if (allFiles.length === 0) {
    console.log(
      'No Claude session logs found. Trail is empty — nothing to ingest.'
    );
    return {
      newEvents: 0,
      sessionsTouched: 0,
      filesScanned: 0,
      filesSkipped: 0,
      workUnitsInserted: 0,
      workUnitsUpdated: 0,
    };
  }

  const db = getDb();

  // Skip files whose (size, mtime) match the last successful scan.
  // Transcripts are append-only, so a file that merely GREW is resumed
  // from the stored offset — only the appended tail is read and parsed.
  // Anything else (new file, shrunk file, same-size mtime change, scan
  // version bump) is read from byte 0. Event inserts are OR IGNORE, so
  // overlapping re-reads are safe. Stats are captured before reading:
  // a file that grows mid-read gets re-scanned next cycle.
  const stateStmt = db.prepare(
    `SELECT size, mtime_ms FROM ingest_file_state
     WHERE path = ? AND scan_version = ?`
  );
  const files: Array<{ path: string; offset: number }> = [];
  const scannedStats = new Map<string, { mtimeMs: number }>();
  let filesSkipped = 0;
  for (const file of allFiles) {
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    const mtimeMs = Math.trunc(st.mtimeMs);
    const prev = stateStmt.get(file, INGEST_SCAN_VERSION) as
      | { size: number; mtime_ms: number }
      | undefined;
    if (prev && prev.size === st.size && prev.mtime_ms === mtimeMs) {
      filesSkipped++;
      continue;
    }
    const offset = prev && st.size > prev.size ? prev.size : 0;
    files.push({ path: file, offset });
    scannedStats.set(file, { mtimeMs });
  }
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

  const onUsage = (event: AssistantUsage): void => {
    let ctx = repoCache.get(event.projectDirEncoded);
    let projectDir = dirCache.get(event.projectDirEncoded);
    if (!ctx) {
      const dir = decodeProjectDir(event.projectDirEncoded);
      projectDir = dir;
      dirCache.set(event.projectDirEncoded, dir);
      ctx = repoContextFor(dir);
      // A local/<basename> fallback for a dir that previously produced a
      // remote slug is the same project — stamp the slug, don't fragment.
      if (ctx.repo?.startsWith('local/')) {
        const known = knownSlugForDir(db, dir);
        if (known) ctx = { ...ctx, repo: known };
      }
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
  };

  const upsertSession = db.prepare(`
    INSERT INTO sessions (session_id, title, project_dir, first_seen_at, last_seen_at)
    VALUES (@session_id, @title, @project_dir, @first_seen_at, @last_seen_at)
    ON CONFLICT(session_id) DO UPDATE SET
      -- Rewrite title from the JSONL on re-ingest so improved title
      -- extraction (e.g. stripping noise wrappers) takes effect. Falls
      -- back to the prior value when extraction returned NULL — which is
      -- also the normal case for a tail scan that never saw the session's
      -- opening lines.
      title = COALESCE(excluded.title, sessions.title),
      project_dir = COALESCE(excluded.project_dir, sessions.project_dir),
      -- Scalar MIN/MAX return NULL if either side is NULL, which would
      -- wipe stored bounds when a scan saw no timestamps; COALESCE each
      -- side against the other so a NULL never wins.
      first_seen_at = MIN(COALESCE(sessions.first_seen_at, excluded.first_seen_at),
                          COALESCE(excluded.first_seen_at, sessions.first_seen_at)),
      last_seen_at  = MAX(COALESCE(sessions.last_seen_at, excluded.last_seen_at),
                          COALESCE(excluded.last_seen_at, sessions.last_seen_at))
  `);
  let sessionsIndexed = 0;
  const sessionTx = db.transaction(
    (metas: Array<Record<string, unknown>>) => {
      for (const m of metas) {
        upsertSession.run(m);
        sessionsIndexed++;
      }
    }
  );

  // Single pass per changed file: usage events and session metadata come
  // out of one read of (only) the bytes appended since the last scan.
  const metaBatch: Array<Record<string, unknown>> = [];
  const consumedBytes = new Map<string, number>();
  for (const { path: file, offset } of files) {
    const scan = await scanSessionFile(file, offset, onUsage);
    consumedBytes.set(file, scan.consumedBytes);
    const m = scan.meta;
    metaBatch.push({
      session_id: m.sessionId,
      title: m.title,
      project_dir: m.projectDirEncoded
        ? decodeProjectDir(m.projectDirEncoded)
        : null,
      first_seen_at: m.firstSeenAt,
      last_seen_at: m.lastSeenAt,
    });
    if (metaBatch.length >= 200) {
      sessionTx(metaBatch);
      metaBatch.length = 0;
    }
  }
  if (batch.length > 0) tx(batch);
  if (metaBatch.length > 0) sessionTx(metaBatch);

  // Record watermarks only after the scan over the changed files
  // completed, so a crash mid-ingest re-reads them next cycle. `size`
  // stores the offset the scan actually consumed (not the stat size):
  // the next cycle resumes exactly where parsing stopped.
  const upsertState = db.prepare(`
    INSERT INTO ingest_file_state (path, size, mtime_ms, scan_version)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      scan_version = excluded.scan_version
  `);
  db.transaction(() => {
    for (const [path, st] of scannedStats) {
      const consumed = consumedBytes.get(path);
      if (consumed === undefined) continue;
      upsertState.run(path, consumed, st.mtimeMs, INGEST_SCAN_VERSION);
    }
  })();

  // Merge Stop-hook snapshots before computing work_units. Hook data is
  // a stronger branch signal than ingest-time HEAD, so apply it first.
  const snapshots = await loadLatestHookSnapshots();
  const hookResult = applyHookSnapshots(db, snapshots);

  // work_units are a deterministic function of usage_events (with hook-refined
  // branches applied above). If this cycle inserted no new events AND hook
  // application changed nothing, the full GROUP BY would rebuild byte-identical
  // rows — so skip it. This keeps an idle menubar poll (every ~60s) from
  // re-scanning all usage_events when there is provably nothing to recompute.
  let inserted = 0;
  let updated = 0;
  if (newEvents > 0 || hookResult.updated > 0) {
    ({ inserted, updated } = refreshWorkUnits(db));
  }

  console.log(
    `Trail updated: ${newEvents} new usage event${newEvents === 1 ? '' : 's'} ` +
      `from ${sessions.size} session${sessions.size === 1 ? '' : 's'} ` +
      `across ${files.length} changed file${files.length === 1 ? '' : 's'}` +
      (filesSkipped > 0 ? ` (${filesSkipped} unchanged skipped)` : '') +
      `.`
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
    filesSkipped,
    workUnitsInserted: inserted,
    workUnitsUpdated: updated,
  };
}
