import { getDb } from '../db/db.js';
import { GitHubService, parseRepoOwnerName } from '../services/github.js';

export type PrsBackfillOptions = {
  force?: boolean;
  delayMs?: number;
};

// Mainline names we never look PRs up for.
const MAINLINE = new Set(['main', 'master', 'develop', 'staging']);

// Walk session_commits, extract unique (session_id, repo, head_branch)
// triples whose branch isn't mainline, and look up the matching PR via
// GitHub. Caches lookups by (repo, branch) so two sessions that worked
// on the same branch share one API call.
export async function backfillPrs(opts: PrsBackfillOptions = {}): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log(
      'GITHUB_TOKEN not set. Add it to .env to enrich sessions with PR data.'
    );
    return;
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT
         c.session_id,
         c.repo,
         c.branch
       FROM session_commits c
       WHERE c.repo IS NOT NULL AND c.repo != ''
         AND c.branch IS NOT NULL AND c.branch != ''
         ${opts.force ? '' : `AND NOT EXISTS (
           SELECT 1 FROM session_prs p
           WHERE p.session_id = c.session_id AND p.repo = c.repo
         )`}`
    )
    .all() as Array<{ session_id: string; repo: string; branch: string }>;

  // Explode the (session, repo, comma-separated-decoration) rows into
  // (session, repo, normalized-branch) tuples. session_commits.branch
  // looks like "HEAD -> feat/foo, origin/feat/foo" — strip the prefix
  // and pick the branch name.
  type Tuple = { sessionId: string; repo: string; branch: string };
  const tuples: Tuple[] = [];
  for (const r of rows) {
    for (const branch of expandBranches(r.branch)) {
      tuples.push({ sessionId: r.session_id, repo: r.repo, branch });
    }
  }
  // Dedupe.
  const seen = new Set<string>();
  const deduped: Tuple[] = [];
  for (const t of tuples) {
    const key = `${t.sessionId}::${t.repo}::${t.branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(t);
  }

  if (deduped.length === 0) {
    console.log('No session/repo/branch tuples need a PR lookup.');
    return;
  }

  const gh = new GitHubService(token);
  const insert = db.prepare(`
    INSERT OR REPLACE INTO session_prs (
      session_id, repo, pr_number, pr_title, pr_url, pr_state, head_branch, merged_at
    ) VALUES (
      @session_id, @repo, @pr_number, @pr_title, @pr_url, @pr_state, @head_branch, @merged_at
    )
  `);

  // Cache PR lookups by (repo, branch) so concurrent sessions on the same
  // branch (resume points, multiple terminals) don't burn extra calls.
  type PrCache = { number: number; title: string; state: 'open' | 'closed'; mergedAt: string | null } | null;
  const prCache = new Map<string, PrCache>();
  const delayMs = opts.delayMs ?? 200;

  let inserted = 0;
  let prFound = 0;
  let apiCalls = 0;

  for (const t of deduped) {
    const cacheKey = `${t.repo}::${t.branch}`;
    let pr = prCache.get(cacheKey);
    if (pr === undefined) {
      const parsed = parseRepoOwnerName(t.repo);
      if (!parsed) {
        prCache.set(cacheKey, null);
        pr = null;
      } else {
        const result = await gh.findPrByBranch(parsed.owner, parsed.repo, t.branch);
        apiCalls++;
        if (delayMs > 0) await sleep(delayMs);
        if (result) {
          pr = {
            number: result.number,
            title: result.title,
            state: result.state,
            mergedAt: result.mergedAt,
          };
          prCache.set(cacheKey, pr);
          prFound++;
        } else {
          prCache.set(cacheKey, null);
          pr = null;
        }
      }
    }

    if (!pr) continue;

    const parsed = parseRepoOwnerName(t.repo);
    if (!parsed) continue;
    insert.run({
      session_id: t.sessionId,
      repo: t.repo,
      pr_number: pr.number,
      pr_title: pr.title,
      pr_url: `https://github.com/${parsed.owner}/${parsed.repo}/pull/${pr.number}`,
      pr_state: pr.mergedAt ? 'merged' : pr.state,
      head_branch: t.branch,
      merged_at: pr.mergedAt,
    });
    inserted++;
  }

  console.log(
    `PR backfill complete: ${inserted} session ↔ PR links written. ` +
      `${prFound} unique PRs found across ${apiCalls} GitHub call${apiCalls === 1 ? '' : 's'}.`
  );
}

export async function showPrs(sessionPrefix: string): Promise<void> {
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
  const prs = db
    .prepare(
      `SELECT repo, pr_number, pr_title, pr_url, pr_state, merged_at
       FROM session_prs WHERE session_id = ?
       ORDER BY repo, pr_number`
    )
    .all(session.session_id) as Array<{
    repo: string;
    pr_number: number;
    pr_title: string;
    pr_url: string;
    pr_state: string;
    merged_at: string | null;
  }>;

  console.log(`Session ${session.session_id.slice(0, 8)} — ${session.title ?? '(no title)'}`);
  console.log('─'.repeat(96));
  if (prs.length === 0) {
    console.log('No PRs found for this session.');
    console.log('Run `tokentrail prs --backfill` first.');
    return;
  }
  for (const p of prs) {
    console.log(`[${p.pr_state.padEnd(6)}]  ${p.repo}#${p.pr_number}  ${p.pr_title}`);
    console.log(`            ${p.pr_url}`);
  }
}

// Decorations look like "HEAD -> main, origin/main" or
// "tag: v1, origin/feat/foo, feat/foo". Strip HEAD pointer, tag:
// prefixes, the "origin/" remote prefix, drop mainline, dedupe.
function expandBranches(raw: string): string[] {
  const out = new Set<string>();
  for (const piece of raw.split(',')) {
    let s = piece.trim();
    if (!s) continue;
    s = s.replace(/^HEAD -> /, '');
    if (s.startsWith('tag:')) continue;
    s = s.replace(/^origin\//, '');
    if (s === 'HEAD' || s === 'origin') continue;
    if (MAINLINE.has(s.toLowerCase())) continue;
    out.add(s);
  }
  return [...out];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
