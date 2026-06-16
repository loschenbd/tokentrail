import { getDb } from '../db/db.js';
import {
  commitsInWindow,
  findGitRoot,
  gitConfigEmail,
  isDir,
} from '../services/git-history.js';
import { originUrl, parseRepoSlug } from '../services/git.js';

export type CommitsBackfillOptions = {
  // Limit to sessions with no commits yet — default behavior. --force
  // re-scans every session even if some commits are already cached.
  force?: boolean;
  // Override the default author filter (git config user.email). Pass
  // an empty string to disable the filter and capture all authors.
  author?: string;
};

export async function backfillCommits(
  opts: CommitsBackfillOptions = {}
): Promise<void> {
  const db = getDb();
  const authorEmail =
    opts.author === undefined ? gitConfigEmail() : opts.author || null;

  if (authorEmail) {
    console.log(`Filtering commits by author: ${authorEmail}`);
  } else {
    console.log('No author filter (capturing every author in the time window).');
  }

  const sessions = db
    .prepare(
      `SELECT s.session_id, s.project_dir, s.first_seen_at, s.last_seen_at
       FROM sessions s
       WHERE s.project_dir IS NOT NULL
         AND s.first_seen_at IS NOT NULL
         AND s.last_seen_at IS NOT NULL
         ${opts.force ? '' : `AND NOT EXISTS (
           SELECT 1 FROM session_commits c WHERE c.session_id = s.session_id
         )`}
       ORDER BY s.last_seen_at DESC`
    )
    .all() as Array<{
    session_id: string;
    project_dir: string;
    first_seen_at: string;
    last_seen_at: string;
  }>;

  if (sessions.length === 0) {
    console.log('No sessions need a commit scan.');
    return;
  }

  // Cache git-root lookup per directory — most sessions share a root.
  const rootCache = new Map<string, string | null>();
  // Cache repo slug per git root — one git config call instead of per-commit.
  const repoSlugCache = new Map<string, string | null>();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO session_commits (
      session_id, commit_sha, subject, body, authored_at, author_email, branch, repo
    ) VALUES (
      @session_id, @commit_sha, @subject, @body, @authored_at, @author_email, @branch, @repo
    )
  `);
  const clearForSession = db.prepare(
    `DELETE FROM session_commits WHERE session_id = ?`
  );

  let sessionsCovered = 0;
  let commitsInserted = 0;
  let skippedNoRepo = 0;

  for (const s of sessions) {
    let root = rootCache.get(s.project_dir);
    if (root === undefined) {
      root = isDir(s.project_dir) ? findGitRoot(s.project_dir) : null;
      rootCache.set(s.project_dir, root);
    }
    if (!root) {
      skippedNoRepo++;
      continue;
    }

    const commits = commitsInWindow(
      root,
      s.first_seen_at,
      s.last_seen_at,
      authorEmail ?? undefined
    );
    if (commits.length === 0) continue;

    let repoSlug = repoSlugCache.get(root);
    if (repoSlug === undefined) {
      // Mirror repoContextFor's fallback: local-only repos get local/<basename>
      // so their commits still surface under the same repo identity used by
      // attribution and rollups.
      const parsed = parseRepoSlug(originUrl(root));
      const base = root.split('/').filter(Boolean).pop() ?? 'unknown';
      repoSlug = parsed ?? `local/${base}`;
      repoSlugCache.set(root, repoSlug);
    }

    const tx = db.transaction(() => {
      if (opts.force) clearForSession.run(s.session_id);
      for (const c of commits) {
        insert.run({
          session_id: s.session_id,
          commit_sha: c.sha,
          subject: c.subject,
          body: c.body,
          authored_at: c.authoredAt,
          author_email: c.authorEmail,
          branch: c.branches,
          repo: repoSlug ?? null,
        });
        commitsInserted++;
      }
    });
    tx();
    sessionsCovered++;
  }

  console.log(
    `Backfill complete: ${commitsInserted} commits captured across ` +
      `${sessionsCovered} session${sessionsCovered === 1 ? '' : 's'}. ` +
      `${skippedNoRepo} session${skippedNoRepo === 1 ? '' : 's'} skipped (no git root).`
  );
}

export async function showCommits(sessionPrefix: string): Promise<void> {
  const db = getDb();
  if (sessionPrefix.length < 4) {
    console.error('Session prefix must be at least 4 characters.');
    return;
  }
  const matches = db
    .prepare(
      `SELECT session_id, title FROM sessions WHERE session_id LIKE @p LIMIT 5`
    )
    .all({ p: `${sessionPrefix}%` }) as Array<{
    session_id: string;
    title: string | null;
  }>;
  if (matches.length === 0) {
    console.error(`No session matches prefix "${sessionPrefix}".`);
    return;
  }
  if (matches.length > 1) {
    console.error(
      `Prefix "${sessionPrefix}" matches ${matches.length} sessions:`
    );
    for (const m of matches) {
      console.error(`  ${m.session_id.slice(0, 8)}  ${m.title ?? '(no title)'}`);
    }
    return;
  }
  const session = matches[0]!;
  const commits = db
    .prepare(
      `SELECT commit_sha, subject, authored_at, branch
       FROM session_commits WHERE session_id = ?
       ORDER BY authored_at`
    )
    .all(session.session_id) as Array<{
    commit_sha: string;
    subject: string;
    authored_at: string;
    branch: string | null;
  }>;

  console.log(`Session ${session.session_id.slice(0, 8)} — ${session.title ?? '(no title)'}`);
  console.log('─'.repeat(96));
  if (commits.length === 0) {
    console.log('No commits captured for this session.');
    console.log('Run `tokentrail commits --backfill` first.');
    return;
  }
  for (const c of commits) {
    const when = c.authored_at.slice(0, 19).replace('T', ' ');
    const sha = c.commit_sha.slice(0, 8);
    const refs = c.branch ? ` (${c.branch})` : '';
    console.log(`${when}  ${sha}  ${c.subject}${refs}`);
  }
}
