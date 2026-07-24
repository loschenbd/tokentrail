import { existsSync } from 'node:fs';
import type DatabaseType from 'better-sqlite3';
import { commitExistsIn, repoContextFor } from '../services/git.js';
import { getDb } from '../db/db.js';
import { getConfig } from '../lib/config.js';
import {
  readScoredCommits,
  cursorTrackingDbPath,
} from '../services/cursor-tracking-reader.js';
import {
  deriveSessionCookie, fetchUsageSummary, fetchMeteredUsd,
  type CursorUtilization, type CursorMetered,
} from '../services/cursor-cloud.js';

// Resolve a Cursor-scored commit hash to a Tokentrail repo slug by testing
// membership across known project dirs. First containing repo wins. Results
// (including misses) are memoized in `cache` so a run never shells git twice
// for the same hash. A miss (no known repo contains it) returns null; the
// caller parks the row for a later run.
export function resolveCommitRepo(
  commitHash: string,
  candidateDirs: string[],
  cache: Map<string, string | null>
): string | null {
  if (cache.has(commitHash)) return cache.get(commitHash) ?? null;
  let resolved: string | null = null;
  for (const dir of candidateDirs) {
    if (commitExistsIn(dir, commitHash)) {
      resolved = repoContextFor(dir).repo;
      break;
    }
  }
  cache.set(commitHash, resolved);
  return resolved;
}

// Real filesystem dirs Tokentrail already knows about — the search space for
// commit->repo resolution. Distinct, existing dirs from sessions + usage.
export function knownProjectDirs(db: DatabaseType.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT project_dir FROM sessions WHERE project_dir IS NOT NULL
       UNION SELECT DISTINCT project_dir FROM usage_events WHERE project_dir IS NOT NULL`
    )
    .all() as Array<{ project_dir: string }>;
  return rows.map((r) => r.project_dir).filter((d) => d && existsSync(d));
}

export function reresolveParkedCommits(db: DatabaseType.Database): number {
  const parked = db
    .prepare('SELECT commit_hash FROM cursor_code_attribution WHERE repo IS NULL')
    .all() as Array<{ commit_hash: string }>;
  if (parked.length === 0) return 0;
  const dirs = knownProjectDirs(db);
  const cache = new Map<string, string | null>();
  const setRepo = db.prepare(
    'UPDATE cursor_code_attribution SET repo = ? WHERE commit_hash = ?'
  );
  let fixed = 0;
  const tx = db.transaction(() => {
    for (const { commit_hash } of parked) {
      const repo = resolveCommitRepo(commit_hash, dirs, cache);
      if (repo !== null) {
        setRepo.run(repo, commit_hash);
        fixed++;
      }
    }
  });
  tx();
  return fixed;
}

const WATERMARK_KEY = 'scored_commits';

export async function runCursorIngest(
  dbArg?: DatabaseType.Database
): Promise<{ inserted: number; parked: number; scanned: number }> {
  const db = dbArg ?? getDb();
  const path = cursorTrackingDbPath();

  const wmRow = db
    .prepare('SELECT last_scored_at FROM cursor_ingest_state WHERE key = ?')
    .get(WATERMARK_KEY) as { last_scored_at: number } | undefined;
  const since = wmRow?.last_scored_at ?? 0;

  const commits = readScoredCommits(path, since);
  if (commits.length === 0) {
    console.log('Cursor: no new scored commits.');
    return { inserted: 0, parked: 0, scanned: 0 };
  }

  const dirs = knownProjectDirs(db);
  const cache = new Map<string, string | null>();

  const upsert = db.prepare(`
    INSERT INTO cursor_code_attribution
      (commit_hash, repo, branch, ai_lines, composer_lines, tab_lines,
       human_lines, ai_pct, committed_at, message, scored_at, source)
    VALUES
      (@commit_hash, @repo, @branch, @ai_lines, @composer_lines, @tab_lines,
       @human_lines, @ai_pct, @committed_at, @message, @scored_at, 'cursor')
    ON CONFLICT(commit_hash) DO UPDATE SET
      repo = COALESCE(excluded.repo, cursor_code_attribution.repo),
      branch = excluded.branch,
      ai_lines = excluded.ai_lines,
      composer_lines = excluded.composer_lines,
      tab_lines = excluded.tab_lines,
      human_lines = excluded.human_lines,
      ai_pct = excluded.ai_pct,
      committed_at = excluded.committed_at,
      message = excluded.message,
      scored_at = excluded.scored_at
  `);

  let inserted = 0;
  let parked = 0;
  let maxScored = since;
  const tx = db.transaction(() => {
    for (const c of commits) {
      const repo = resolveCommitRepo(c.commitHash, dirs, cache);
      if (repo === null) parked++;
      upsert.run({
        commit_hash: c.commitHash,
        repo,
        branch: c.branch,
        ai_lines: c.aiLines,
        composer_lines: c.composerLines,
        tab_lines: c.tabLines,
        human_lines: c.humanLines,
        ai_pct: c.aiPct,
        committed_at: c.committedAt,
        message: c.message,
        scored_at: c.scoredAt,
      });
      inserted++;
      if (c.scoredAt > maxScored) maxScored = c.scoredAt;
    }
    db.prepare(
      `INSERT INTO cursor_ingest_state (key, last_scored_at) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET last_scored_at = excluded.last_scored_at`
    ).run(WATERMARK_KEY, maxScored);
  });
  tx();

  const refixed = reresolveParkedCommits(db);
  if (refixed > 0) {
    console.log(`Cursor: attributed ${refixed} previously-parked commit${refixed === 1 ? '' : 's'} to a now-known repo.`);
  }

  console.log(
    `Cursor: ingested ${inserted} scored commit${inserted === 1 ? '' : 's'}` +
      (parked > 0 ? ` (${parked} awaiting a known repo)` : '') +
      '.'
  );
  return { inserted, parked, scanned: commits.length };
}

export async function runCursorUsage(
  dbArg?: DatabaseType.Database,
  deps?: { cookie?: string | null; util?: CursorUtilization | null; metered?: CursorMetered | null }
): Promise<'updated' | 'stale' | 'skipped'> {
  const db = dbArg ?? getDb();
  if (!getConfig().cursorCloudSpend) { console.log('Cursor: cloud usage disabled by config.'); return 'skipped'; }
  const cookie = deps?.cookie !== undefined ? deps.cookie : deriveSessionCookie();
  if (!cookie) { console.log('Cursor: no session cookie found; skipping cloud usage.'); return 'skipped'; }

  const util = deps?.util !== undefined ? deps.util : await fetchUsageSummary(cookie);
  let metered: CursorMetered | null;
  if (deps?.metered !== undefined) metered = deps.metered;
  else {
    const cycleStartMs = util?.cycleStart ? Date.parse(util.cycleStart) : 0;
    metered = await fetchMeteredUsd(cookie, Number.isFinite(cycleStartMs) ? cycleStartMs : 0);
  }

  const now = new Date().toISOString();
  if (util === null && metered === null) {
    const existing = db.prepare('SELECT id FROM cursor_usage WHERE id=1').get();
    if (existing) { db.prepare('UPDATE cursor_usage SET stale = 1 WHERE id = 1').run(); return 'stale'; }
    return 'skipped';
  }

  db.prepare(`
    INSERT INTO cursor_usage
      (id, cycle_start, cycle_end, membership_type, plan_used, plan_limit, plan_pct_used,
       ondemand_enabled, ondemand_used, metered_usd, events_scanned, events_total, truncated, fetched_at, stale)
    VALUES (1, @cs, @ce, @mt, @pu, @pl, @pp, @oe, @ou, @mu, @es, @et, @tr, @f, 0)
    ON CONFLICT(id) DO UPDATE SET
      cycle_start=excluded.cycle_start, cycle_end=excluded.cycle_end, membership_type=excluded.membership_type,
      plan_used=excluded.plan_used, plan_limit=excluded.plan_limit, plan_pct_used=excluded.plan_pct_used,
      ondemand_enabled=excluded.ondemand_enabled, ondemand_used=excluded.ondemand_used,
      metered_usd=excluded.metered_usd, events_scanned=excluded.events_scanned,
      events_total=excluded.events_total, truncated=excluded.truncated, fetched_at=excluded.fetched_at, stale=0
  `).run({
    cs: util?.cycleStart ?? null, ce: util?.cycleEnd ?? null, mt: util?.membershipType ?? null,
    pu: util?.planUsed ?? null, pl: util?.planLimit ?? null, pp: util?.planPctUsed ?? null,
    oe: util?.ondemandEnabled == null ? null : util.ondemandEnabled ? 1 : 0,
    ou: util?.ondemandUsed ?? null,
    mu: metered?.usd ?? null, es: metered?.eventsScanned ?? null, et: metered?.eventsTotal ?? null,
    tr: metered?.truncated ? 1 : 0, f: now,
  });
  const plan = util?.membershipType ?? 'unknown';
  const dollars = metered?.usd != null ? `$${metered.usd.toFixed(2)}` : 'n/a';
  console.log(`Cursor usage (account-wide, estimated): ${plan} · ${dollars} metered this cycle` +
    (metered?.truncated ? ' (partial — event history truncated)' : '') + '.');
  return 'updated';
}

export async function runCursor(
  opts: { ingest?: boolean; spend?: boolean }
): Promise<void> {
  const both = !opts.ingest && !opts.spend;
  if (both || opts.ingest) await runCursorIngest();
  if (both || opts.spend) await runCursorUsage();
}
