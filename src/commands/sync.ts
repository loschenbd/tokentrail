import { getDb } from '../db/db.js';
import {
  NotionService,
  buildRollupBody,
  type RollupBodyContext,
  type RollupPagePayload,
} from '../services/notion.js';

export type SyncOptions = {
  days?: number;
  force?: boolean;
  delayMs?: number;
  // Re-write the page BODY (Sessions / PRs / Commits sections) for
  // every rollup synced this run. Heavy — issues list+delete+append
  // per page. Use when adding the body feature for the first time or
  // after substantial data changes; not needed for routine syncs.
  rebuildBodies?: boolean;
};

export type SyncSummary = {
  scanned: number;
  upserted: number;
  skipped: number;
};

// Push feature_rollups rows into the configured Notion database.
//
// Default behavior:
//   - Only sync rows updated since their last Notion sync (or never synced).
//   - --force re-pushes everything.
//   - --days restricts to a recent window.
//
// Notion is treated as a mirror; we never read from it as truth.
export async function runSync(opts: SyncOptions = {}): Promise<SyncSummary> {
  const token = process.env.NOTION_TOKEN;
  const databaseId = process.env.NOTION_DATABASE_ID;
  if (!token || !databaseId) {
    console.log(
      'NOTION_TOKEN or NOTION_DATABASE_ID not set. Add them to .env to sync to Notion.'
    );
    return { scanned: 0, upserted: 0, skipped: 0 };
  }

  const db = getDb();
  const params: Record<string, string | number> = {};
  let where = '1=1';
  if (opts.days && opts.days > 0) {
    where += ` AND date >= date('now', '-' || @days || ' days')`;
    params.days = opts.days;
  }
  if (!opts.force) {
    // Sync only rows whose updated_at is newer than synced_to_notion_at
    // (or were never synced). updated_at is bumped on every rollup run, so
    // genuinely-unchanged rollups don't re-push.
    where += ` AND (synced_to_notion_at IS NULL OR updated_at > synced_to_notion_at)`;
  }

  const rows = db
    .prepare(
      `SELECT
         id, date, feature_key, feature_name, repo, branches,
         total_input_tokens, total_output_tokens, total_cost_usd,
         sessions_count, notion_page_id, commit_summary, session_ids
       FROM feature_rollups
       WHERE ${where}
       ORDER BY date DESC, total_cost_usd DESC`
    )
    .all(params) as Array<{
    id: string;
    date: string;
    feature_key: string;
    feature_name: string;
    repo: string | null;
    branches: string | null;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost_usd: number;
    sessions_count: number;
    notion_page_id: string | null;
    commit_summary: string | null;
    session_ids: string | null;
  }>;

  if (rows.length === 0) {
    console.log('Notion is already in step with the ledger. Nothing to sync.');
    return { scanned: 0, upserted: 0, skipped: 0 };
  }

  const notion = new NotionService(token, databaseId);
  const markSynced = db.prepare(`
    UPDATE feature_rollups
    SET notion_page_id = @page_id,
        synced_to_notion_at = datetime('now'),
        body_synced_at = COALESCE(@body_synced_at, body_synced_at)
    WHERE id = @id
  `);

  // Prepared statements for body context lookup.
  const sessionsForRollup = db.prepare(`
    SELECT s.session_id, s.title,
           (SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM usage_events e
            WHERE e.session_id = s.session_id) AS cost
    FROM sessions s
    WHERE s.session_id IN (SELECT value FROM json_each(?))
    ORDER BY cost DESC
  `);
  const commitsForRollup = db.prepare(`
    SELECT commit_sha AS sha, subject, repo
    FROM session_commits
    WHERE session_id IN (SELECT value FROM json_each(?))
    ORDER BY authored_at
  `);
  const prsForRollup = db.prepare(`
    SELECT repo, pr_number AS prNumber, pr_title AS title,
           pr_url AS url, pr_state AS state
    FROM session_prs
    WHERE session_id IN (SELECT value FROM json_each(?))
    ORDER BY repo, pr_number
  `);

  let upserted = 0;
  let skipped = 0;
  let bodiesWritten = 0;
  const delayMs = opts.delayMs ?? 350;

  for (const r of rows) {
    const payload: RollupPagePayload = {
      date: r.date,
      featureKey: r.feature_key,
      featureName: r.feature_name,
      repo: r.repo,
      branches: r.branches ?? '',
      totalInputTokens: r.total_input_tokens,
      totalOutputTokens: r.total_output_tokens,
      totalCostUsd: r.total_cost_usd,
      sessions: r.sessions_count,
      commitSummary: r.commit_summary,
    };

    let pageId = r.notion_page_id;
    if (!pageId) {
      pageId = await notion.findExistingPage(r.feature_key, r.date);
    }

    // Build body context once per row — both the create path (children)
    // and the rebuild path (rebuildPageBody) use the same shape.
    const sessionIds = (r.session_ids ?? '')
      .split(',')
      .filter((s) => s.length > 0);
    const body = sessionIds.length > 0
      ? buildBodyContext(sessionIds, {
          sessionsForRollup,
          commitsForRollup,
          prsForRollup,
        })
      : null;
    const children = body ? buildRollupBody(body) : [];

    const result = await notion.upsertPage(
      payload,
      pageId,
      children.length > 0 ? children : undefined
    );
    if (!result) {
      skipped++;
      if (delayMs > 0) await sleep(delayMs);
      continue;
    }

    let bodySyncedAt: string | null = null;
    if (result.created) {
      // pages.create already wrote the children — stamp body_synced_at.
      bodySyncedAt = new Date().toISOString();
      bodiesWritten++;
    } else if (opts.rebuildBodies && children.length > 0) {
      // For existing pages, rebuild the body when explicitly requested.
      const ok = await notion.rebuildPageBody(result.pageId, children);
      if (ok) {
        bodySyncedAt = new Date().toISOString();
        bodiesWritten++;
      }
      // Heavy operation — give Notion extra breathing room afterward.
      if (delayMs > 0) await sleep(delayMs);
    }

    markSynced.run({
      id: r.id,
      page_id: result.pageId,
      body_synced_at: bodySyncedAt,
    });
    upserted++;
    if (delayMs > 0) await sleep(delayMs);
  }

  const bodyNote = bodiesWritten > 0
    ? ` (${bodiesWritten} ${bodiesWritten === 1 ? 'body' : 'bodies'} written)`
    : '';
  console.log(
    `Notion sync complete: ${upserted} page${upserted === 1 ? '' : 's'} ` +
      `upserted, ${skipped} skipped${bodyNote}.`
  );
  return { scanned: rows.length, upserted, skipped };
}

function buildBodyContext(
  sessionIds: string[],
  prepared: {
    sessionsForRollup: ReturnType<typeof getDb>['prepare'] extends (s: string) => infer R
      ? R
      : never;
    commitsForRollup: ReturnType<typeof getDb>['prepare'] extends (s: string) => infer R
      ? R
      : never;
    prsForRollup: ReturnType<typeof getDb>['prepare'] extends (s: string) => infer R
      ? R
      : never;
  }
): RollupBodyContext {
  const json = JSON.stringify(sessionIds);
  const sessions = (prepared.sessionsForRollup.all(json) as Array<{
    session_id: string;
    title: string | null;
    cost: number;
  }>).map((r) => ({
    sessionId: r.session_id,
    title: r.title,
    cost: r.cost ?? 0,
  }));
  const commits = (prepared.commitsForRollup.all(json) as Array<{
    sha: string;
    subject: string;
    repo: string | null;
  }>).map((r) => ({ sha: r.sha, subject: r.subject, repo: r.repo }));
  // Dedupe PRs across sessions (multiple sessions can point at the same PR).
  const prMap = new Map<string, RollupBodyContext['prs'][number]>();
  for (const p of prepared.prsForRollup.all(json) as Array<{
    repo: string;
    prNumber: number;
    title: string;
    url: string;
    state: string;
  }>) {
    const k = `${p.repo}#${p.prNumber}`;
    if (!prMap.has(k)) prMap.set(k, p);
  }
  return { sessions, commits, prs: [...prMap.values()] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
