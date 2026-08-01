import { existsSync } from 'node:fs';
import type DatabaseType from 'better-sqlite3';
import { commitExistsIn, commitsPresentIn, isGitRepo, repoContextFor } from '../services/git.js';
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

// Injectable git seam for resolveCommitRepos (defaults to the real git funcs;
// tests pass fakes to assert the O(dirs) spawn budget without shelling git).
export type ResolveDeps = {
  isRepo: (dir: string) => boolean;
  present: (dir: string, shas: string[]) => Set<string>;
  slug: (dir: string) => string | null;
};

// Batched commit->repo resolution — the many-hashes counterpart to
// resolveCommitRepo. For each candidate dir (in order) that is a git repo, ONE
// `git cat-file --batch-check` tests every still-unresolved hash at once, so
// the whole run costs O(dirs) git spawns instead of O(commits × dirs). First
// containing repo wins (dirs are tried in order; a resolved hash is dropped
// from the remaining set so a later dir can't reclaim it). Unknown hashes map
// to null (parked). This is what the ingest + re-resolve hot paths use.
export function resolveCommitRepos(
  commitHashes: string[],
  candidateDirs: string[],
  deps: ResolveDeps = {
    isRepo: isGitRepo,
    present: commitsPresentIn,
    slug: (dir) => repoContextFor(dir).repo,
  }
): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const h of commitHashes) result.set(h, null);
  let remaining = [...new Set(commitHashes)];
  for (const dir of candidateDirs) {
    if (remaining.length === 0) break;
    if (!deps.isRepo(dir)) continue;
    const present = deps.present(dir, remaining);
    if (present.size === 0) continue;
    const repo = deps.slug(dir);
    remaining = remaining.filter((h) => {
      if (present.has(h)) {
        result.set(h, repo);
        return false;
      }
      return true;
    });
  }
  return result;
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
  const repoByHash = resolveCommitRepos(parked.map((p) => p.commit_hash), dirs);
  const setRepo = db.prepare(
    'UPDATE cursor_code_attribution SET repo = ? WHERE commit_hash = ?'
  );
  let fixed = 0;
  const tx = db.transaction(() => {
    for (const { commit_hash } of parked) {
      const repo = repoByHash.get(commit_hash) ?? null;
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
  let inserted = 0;
  let parked = 0;

  if (commits.length === 0) {
    console.log('Cursor: no new scored commits.');
  } else {
    const dirs = knownProjectDirs(db);
    // Resolve every commit's repo up front in O(dirs) git spawns (batched),
    // then look each up inside the write transaction.
    const repoByHash = resolveCommitRepos(commits.map((c) => c.commitHash), dirs);

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

    let maxScored = since;
    const tx = db.transaction(() => {
      for (const c of commits) {
        const repo = repoByHash.get(c.commitHash) ?? null;
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

    console.log(
      `Cursor: ingested ${inserted} scored commit${inserted === 1 ? '' : 's'}` +
        (parked > 0 ? ` (${parked} awaiting a known repo)` : '') +
        '.'
    );
  }

  // Always re-resolve parked commits, even on an idle (zero-new-commit) run:
  // a repo that was unknown last run may be known now (a new session dir
  // appeared), and that shouldn't require a fresh scored commit to surface.
  const refixed = reresolveParkedCommits(db);
  if (refixed > 0) {
    console.log(`Cursor: attributed ${refixed} previously-parked commit${refixed === 1 ? '' : 's'} to a now-known repo.`);
  }

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
    // Only sum metered events against a real cycle boundary. Without a
    // finite, positive cycle-start timestamp, fetchMeteredUsd would page
    // through the entire event history and the sum would be mislabeled
    // "this cycle" — so skip the fetch entirely in that case.
    const cs = util?.cycleStart ? Date.parse(util.cycleStart) : NaN;
    metered = (Number.isFinite(cs) && cs > 0) ? await fetchMeteredUsd(cookie, cs) : null;
  }

  const now = new Date().toISOString();
  if (util === null && metered === null) {
    const existing = db.prepare('SELECT id FROM cursor_usage WHERE id=1').get();
    if (existing) { db.prepare('UPDATE cursor_usage SET stale = 1 WHERE id = 1').run(); return 'stale'; }
    return 'skipped';
  }

  // A partial failure (exactly one of util/metered missing) must not
  // clobber the last-good value for the missing half. COALESCE against
  // the existing row on every nullable column preserves it; stale=1
  // flags the row as not fully fresh. When both are present this is a
  // no-op (excluded.* always wins) and stale=0, matching prior behavior.
  const partial = util === null || metered === null;

  db.prepare(`
    INSERT INTO cursor_usage
      (id, cycle_start, cycle_end, membership_type, plan_used, plan_limit, plan_pct_used,
       ondemand_enabled, ondemand_used, metered_usd, events_scanned, events_total, truncated, fetched_at, stale)
    VALUES (1, @cs, @ce, @mt, @pu, @pl, @pp, @oe, @ou, @mu, @es, @et, @tr, @f, @stale)
    ON CONFLICT(id) DO UPDATE SET
      cycle_start=COALESCE(excluded.cycle_start, cursor_usage.cycle_start),
      cycle_end=COALESCE(excluded.cycle_end, cursor_usage.cycle_end),
      membership_type=COALESCE(excluded.membership_type, cursor_usage.membership_type),
      plan_used=COALESCE(excluded.plan_used, cursor_usage.plan_used),
      plan_limit=COALESCE(excluded.plan_limit, cursor_usage.plan_limit),
      plan_pct_used=COALESCE(excluded.plan_pct_used, cursor_usage.plan_pct_used),
      ondemand_enabled=COALESCE(excluded.ondemand_enabled, cursor_usage.ondemand_enabled),
      ondemand_used=COALESCE(excluded.ondemand_used, cursor_usage.ondemand_used),
      metered_usd=COALESCE(excluded.metered_usd, cursor_usage.metered_usd),
      events_scanned=COALESCE(excluded.events_scanned, cursor_usage.events_scanned),
      events_total=COALESCE(excluded.events_total, cursor_usage.events_total),
      truncated=excluded.truncated, fetched_at=excluded.fetched_at, stale=excluded.stale
  `).run({
    cs: util?.cycleStart ?? null, ce: util?.cycleEnd ?? null, mt: util?.membershipType ?? null,
    pu: util?.planUsed ?? null, pl: util?.planLimit ?? null, pp: util?.planPctUsed ?? null,
    oe: util?.ondemandEnabled == null ? null : util.ondemandEnabled ? 1 : 0,
    ou: util?.ondemandUsed ?? null,
    mu: metered?.usd ?? null, es: metered?.eventsScanned ?? null, et: metered?.eventsTotal ?? null,
    tr: metered?.truncated ? 1 : 0, f: now, stale: partial ? 1 : 0,
  });

  // Per-day metered rollup (Cursor-only table; never summed into usage_events).
  // Only write when metered actually succeeded this run — a partial/stale run
  // keeps the last-good daily rows, mirroring the cursor_usage stale behavior.
  if (metered && metered.byDay) {
    const upsertDay = db.prepare(`
      INSERT INTO cursor_daily_cost (date, usd, updated_at)
      VALUES (@date, @usd, @now)
      ON CONFLICT(date) DO UPDATE SET usd = excluded.usd, updated_at = excluded.updated_at
    `);
    const tx = db.transaction((entries: Array<[string, number]>) => {
      for (const [date, usd] of entries) upsertDay.run({ date, usd, now });
    });
    tx(Object.entries(metered.byDay));

    // Prune rows from prior billing cycles. cursor_daily_cost is a
    // current-cycle-only rollup (spec §4): bucketMeteredByDay stops at the
    // current cycle start, so rows written in a past cycle are never
    // revisited and would otherwise linger and inflate the 30d Cursor
    // figure for ~a month after each rollover. Delete anything dated before
    // the cycle start (UTC date, matching the byDay keys). When util is
    // absent this run (partial), fall back to the last-good cycle_start we
    // just COALESCE-preserved into cursor_usage.
    const cycleStartIso = util?.cycleStart
      ?? (db.prepare('SELECT cycle_start AS cs FROM cursor_usage WHERE id=1').get() as { cs: string | null } | undefined)?.cs
      ?? null;
    const cycleStartMs = cycleStartIso ? Date.parse(cycleStartIso) : NaN;
    if (Number.isFinite(cycleStartMs)) {
      const cycleStartDate = new Date(cycleStartMs).toISOString().slice(0, 10);
      db.prepare('DELETE FROM cursor_daily_cost WHERE date < ?').run(cycleStartDate);
    }
  }

  const plan = util?.membershipType ?? 'unknown';
  const dollars = metered?.usd != null ? `$${metered.usd.toFixed(2)}` : 'n/a';
  console.log(`Cursor usage (account-wide, estimated): ${plan} · ${dollars} metered this cycle` +
    (metered?.truncated ? ' (partial — event history truncated)' : '') + '.');
  return partial ? 'stale' : 'updated';
}

export async function runCursor(
  opts: { ingest?: boolean; spend?: boolean }
): Promise<void> {
  const both = !opts.ingest && !opts.spend;
  if (both || opts.ingest) await runCursorIngest();
  if (both || opts.spend) await runCursorUsage();
}
