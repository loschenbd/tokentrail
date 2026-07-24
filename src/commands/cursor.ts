import { existsSync } from 'node:fs';
import type DatabaseType from 'better-sqlite3';
import { commitExistsIn, repoContextFor } from '../services/git.js';
import { getDb } from '../db/db.js';
import {
  readScoredCommits,
  cursorTrackingDbPath,
} from '../services/cursor-tracking-reader.js';

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
