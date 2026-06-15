import { getDb } from '../db/db.js';
import { NotionService, type RollupPagePayload } from '../services/notion.js';

export type SyncOptions = {
  days?: number;
  force?: boolean;
  delayMs?: number;
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
         sessions_count, notion_page_id, commit_summary
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
  }>;

  if (rows.length === 0) {
    console.log('Notion is already in step with the ledger. Nothing to sync.');
    return { scanned: 0, upserted: 0, skipped: 0 };
  }

  const notion = new NotionService(token, databaseId);
  const markSynced = db.prepare(`
    UPDATE feature_rollups
    SET notion_page_id = @page_id,
        synced_to_notion_at = datetime('now')
    WHERE id = @id
  `);

  let upserted = 0;
  let skipped = 0;
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
    const writtenId = await notion.upsertPage(payload, pageId);
    if (writtenId) {
      markSynced.run({ id: r.id, page_id: writtenId });
      upserted++;
    } else {
      skipped++;
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  console.log(
    `Notion sync complete: ${upserted} page${upserted === 1 ? '' : 's'} ` +
      `upserted, ${skipped} skipped.`
  );
  return { scanned: rows.length, upserted, skipped };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
