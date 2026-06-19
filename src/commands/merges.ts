import { execFileSync } from 'node:child_process';
import type DatabaseType from 'better-sqlite3';
import { getDb } from '../db/db.js';
import { findGitRoot, isDir } from '../services/git-history.js';
import { expandBranches } from './prs.js';

export type MergesBackfillOptions = {
  // Re-scan every (repo, branch) even if already in branch_merges. Default
  // behavior is incremental — only check pairs we haven't seen yet.
  force?: boolean;
};

export type BranchMergeRecord = {
  repo: string;
  branch: string;
  mergedAt: string | null;
  sourceSha: string | null;
};

// Try the conventional trunk refs in order. First one that exists wins.
const TRUNK_REFS = ['origin/main', 'origin/master', 'main', 'master'];

// Check whether `sha` is reachable from any of the trunk refs in `gitRoot`.
// Returns the trunk ref that contains it (for diagnostics) plus the commit
// date of the sha itself (used as the merged_at timestamp — for a regular
// merge, the original commit date is close to the merge date).
//
// Only catches merge styles that preserve the original SHA on trunk:
// regular merge, fast-forward, octopus merge. Squash and rebase create
// new SHAs that break this signal.
export function isMergedIntoMain(
  gitRoot: string,
  sha: string,
  runGit: GitRunner = realGit
): { merged: false } | { merged: true; trunkRef: string; mergedAt: string } {
  for (const ref of TRUNK_REFS) {
    if (runGit(gitRoot, ['merge-base', '--is-ancestor', sha, ref]) !== 0) continue;
    const dateStr = runGit(gitRoot, ['log', '-1', '--format=%aI', sha], 'capture');
    if (typeof dateStr !== 'string') continue;
    return { merged: true, trunkRef: ref, mergedAt: dateStr.trim() };
  }
  return { merged: false };
}

// (repo, branch) pairs where we have session activity that hasn't been
// checked yet (or all of them, when force=true). Sources: usage_events
// (clean branch names), session_commits (git decoration, expanded via
// expandBranches), and session_prs (head_branch, origin/-stripped).
// All branch names are normalized to clean form before deduping —
// branch_merges rows are keyed on the clean name so dashboard reads
// can match without re-parsing decoration at query time.
export function findMergeCandidates(
  db: DatabaseType.Database,
  opts: { force?: boolean } = {}
): Array<{ repo: string; branch: string }> {
  const raw = db
    .prepare(
      `SELECT DISTINCT repo, branch FROM (
         SELECT u.repo AS repo, u.branch AS branch
           FROM usage_events u
          WHERE u.repo IS NOT NULL AND u.repo != ''
            AND u.repo NOT LIKE 'local/%'
            AND u.branch IS NOT NULL AND u.branch != ''
            AND u.branch NOT IN ('main','master','develop','staging')
         UNION ALL
         SELECT c.repo AS repo, c.branch AS branch
           FROM session_commits c
          WHERE c.repo IS NOT NULL AND c.repo != ''
            AND c.repo NOT LIKE 'local/%'
            AND c.branch IS NOT NULL AND c.branch != ''
         UNION ALL
         SELECT pr.repo AS repo,
                REPLACE(pr.head_branch, 'origin/', '') AS branch
           FROM session_prs pr
          WHERE pr.repo IS NOT NULL AND pr.repo != ''
            AND pr.repo NOT LIKE 'local/%'
            AND pr.head_branch IS NOT NULL AND pr.head_branch != ''
            AND REPLACE(pr.head_branch, 'origin/', '')
                NOT IN ('main','master','develop','staging')
       ) AS sources`
    )
    .all() as Array<{ repo: string; branch: string }>;

  // Expand git decoration ("HEAD -> X, origin/X") into clean branch names,
  // then dedupe. expandBranches also drops mainline + origin/ prefix.
  const seen = new Set<string>();
  const out: Array<{ repo: string; branch: string }> = [];
  for (const r of raw) {
    for (const branch of expandBranches(r.branch)) {
      const key = `${r.repo}::${branch}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ repo: r.repo, branch });
    }
  }

  if (opts.force) return out;
  // Incremental: drop pairs already in branch_merges.
  const have = new Set<string>(
    (db.prepare(`SELECT repo, branch FROM branch_merges`).all() as Array<{
      repo: string; branch: string;
    }>).map((r) => `${r.repo}::${r.branch}`)
  );
  return out.filter((t) => !have.has(`${t.repo}::${t.branch}`));
}

// For a (repo, branch), pick a representative commit SHA to test for
// ancestry. Strategy: the most recent session_commits row authored
// during a session whose usage_events.branch matched. If session_commits
// has no entry for this branch, fall back to any commit in any session
// that had usage_events on this branch.
function representativeSha(
  db: DatabaseType.Database,
  repo: string,
  branch: string
): string | null {
  const row = db
    .prepare(
      `SELECT c.commit_sha AS sha
         FROM session_commits c
        WHERE c.repo = ? AND c.session_id IN (
                SELECT DISTINCT u.session_id FROM usage_events u
                 WHERE u.repo = ? AND u.branch = ?
              )
        ORDER BY c.authored_at DESC
        LIMIT 1`
    )
    .get(repo, repo, branch) as { sha: string } | undefined;
  if (row?.sha) return row.sha;

  // Decoration-fallback: session_commits.branch directly matches (works
  // for the rare case where we have a commit but no usage_events row).
  const fallback = db
    .prepare(
      `SELECT commit_sha AS sha FROM session_commits
        WHERE repo = ? AND (
          branch = ?
          OR (',' || branch || ',') LIKE ?
        )
        ORDER BY authored_at DESC
        LIMIT 1`
    )
    .get(repo, branch, `%,${branch},%`) as { sha: string } | undefined;
  return fallback?.sha ?? null;
}

// Resolve the local on-disk git root for a repo. We can't infer the path
// from `owner/name` alone, so we look at sessions that had activity on
// this repo and try findGitRoot on each session.project_dir. First
// success wins, cached.
function repoGitRoot(
  db: DatabaseType.Database,
  repo: string,
  cache: Map<string, string | null>
): string | null {
  if (cache.has(repo)) return cache.get(repo)!;
  const dirs = db
    .prepare(
      `SELECT DISTINCT s.project_dir AS dir
         FROM sessions s
         JOIN usage_events u ON u.session_id = s.session_id
        WHERE u.repo = ? AND s.project_dir IS NOT NULL`
    )
    .all(repo) as Array<{ dir: string }>;
  for (const { dir } of dirs) {
    if (!isDir(dir)) continue;
    const root = findGitRoot(dir);
    if (root) {
      cache.set(repo, root);
      return root;
    }
  }
  cache.set(repo, null);
  return null;
}

export async function backfillBranchMerges(
  opts: MergesBackfillOptions = {}
): Promise<void> {
  const db = getDb();

  // One-time cleanup of pre-existing rows that were stored with raw git
  // decoration ("origin/X, X" / "HEAD -> X" / commas) before this
  // backfiller learned to normalize. Idempotent on subsequent runs.
  const cleanup = db
    .prepare(`DELETE FROM branch_merges WHERE branch LIKE '%,%' OR branch LIKE 'origin/%' OR branch LIKE 'HEAD -> %'`)
    .run();
  if (cleanup.changes > 0) {
    console.log(`Cleaned ${cleanup.changes} legacy branch_merges row${cleanup.changes === 1 ? '' : 's'} with raw git decoration.`);
  }

  const candidates = findMergeCandidates(db, { force: opts.force });

  if (candidates.length === 0) {
    console.log('No (repo, branch) pairs need a merge-history check.');
    return;
  }

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO branch_merges
       (repo, branch, merged_at, source_sha, detected_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  );

  const rootCache = new Map<string, string | null>();
  let checked = 0;
  let merged = 0;
  let noSha = 0;
  let noRoot = 0;

  for (const { repo, branch } of candidates) {
    const root = repoGitRoot(db, repo, rootCache);
    if (!root) { noRoot++; continue; }
    const sha = representativeSha(db, repo, branch);
    if (!sha) { noSha++; continue; }

    const result = isMergedIntoMain(root, sha);
    checked++;
    if (result.merged) {
      upsert.run(repo, branch, result.mergedAt, sha);
      merged++;
    } else {
      upsert.run(repo, branch, null, sha);
    }
  }

  console.log(
    `Merge-history backfill complete: ${checked} branch${checked === 1 ? '' : 'es'} checked, ` +
      `${merged} merged via git history. ` +
      `(${noRoot} repos with no local clone, ${noSha} branches with no representative commit.)`
  );
}

// --- git runner abstraction (allows tests to stub out execFileSync) ---

type GitRunner = (gitRoot: string, args: string[], mode?: 'exit' | 'capture') =>
  number | string;

const realGit: GitRunner = (gitRoot, args, mode = 'exit') => {
  try {
    if (mode === 'capture') {
      return execFileSync('git', args, {
        cwd: gitRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      });
    }
    execFileSync('git', args, { cwd: gitRoot, stdio: 'ignore' });
    return 0;
  } catch (err) {
    const status = (err as { status?: number })?.status;
    return typeof status === 'number' ? status : 1;
  }
};
