import { Client } from '@notionhq/client';

// Notion block-children types we need. We keep them as a loose `any`
// payload type because @notionhq/client's generated types are heavy
// and we're only ever constructing a handful of block shapes.
export type NotionBlock = Record<string, unknown>;

export type SessionRef = {
  sessionId: string;
  title: string | null;
  cost: number;
};

export type CommitRef = {
  sha: string;
  subject: string;
  repo: string | null;
};

export type PrRef = {
  repo: string;
  prNumber: number;
  title: string;
  url: string;
  state: string;
};

// Property names in the target Notion database. Update here if the
// schema differs from what's documented in the README.
export const NOTION_PROPS = {
  name: 'Name',
  date: 'Date',
  featureKey: 'Feature Key',
  featureName: 'Feature Name',
  repo: 'Repo',
  branches: 'Branches',
  totalCostUsd: 'Total Cost USD',
  totalInputTokens: 'Total Input Tokens',
  totalOutputTokens: 'Total Output Tokens',
  sessions: 'Sessions',
  syncedAt: 'Synced At',
  commits: 'Commits',
  type: 'Type',
  anomaly: 'Anomaly',
  anomalyReason: 'Anomaly reason',
} as const;

export type RollupPagePayload = {
  date: string;          // YYYY-MM-DD
  featureKey: string;
  featureName: string;
  repo: string | null;
  branches: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  sessions: number;
  commitSummary: string | null;
  isAnomaly: boolean;
  anomalyReason: string | null;
  type: 'Rollup' | 'Digest';
};

export class NotionService {
  private readonly client: Client;
  private readonly databaseId: string;

  constructor(token: string, databaseId: string) {
    this.client = new Client({ auth: token });
    this.databaseId = databaseId;
  }

  async findExistingPage(featureKey: string, date: string): Promise<string | null> {
    try {
      const res = await this.client.databases.query({
        database_id: this.databaseId,
        page_size: 1,
        filter: {
          and: [
            {
              property: NOTION_PROPS.featureKey,
              rich_text: { equals: featureKey },
            },
            {
              property: NOTION_PROPS.date,
              date: { equals: date },
            },
          ],
        },
      });
      const page = res.results[0];
      return page?.id ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  notion: lookup failed for ${featureKey}/${date}: ${msg}`);
      return null;
    }
  }

  async upsertPage(
    payload: RollupPagePayload,
    existingPageId: string | null,
    children?: NotionBlock[]
  ): Promise<{ pageId: string; created: boolean } | null> {
    const properties = buildProperties(payload);
    try {
      if (existingPageId) {
        await this.client.pages.update({
          page_id: existingPageId,
          properties,
        });
        return { pageId: existingPageId, created: false };
      }
      const res = await this.client.pages.create({
        parent: { database_id: this.databaseId },
        properties,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        children: (children ?? []) as any,
      });
      return { pageId: res.id, created: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `  notion: upsert failed for ${payload.featureKey}/${payload.date}: ${msg}`
      );
      return null;
    }
  }

  async findDigestPage(weekStart: string): Promise<string | null> {
    try {
      const res = await this.client.databases.query({
        database_id: this.databaseId,
        page_size: 1,
        filter: {
          and: [
            { property: NOTION_PROPS.type, select: { equals: 'Digest' } },
            { property: NOTION_PROPS.date, date: { equals: weekStart } },
          ],
        },
      });
      const page = res.results[0];
      return page?.id ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  notion: digest lookup failed for ${weekStart}: ${msg}`);
      return null;
    }
  }

  async upsertDigestPage(
    weekStart: string,
    weekTotalUsd: number,
    body: NotionBlock[]
  ): Promise<string | null> {
    try {
      const existing = await this.findDigestPage(weekStart);
      const props: Record<string, unknown> = {
        [NOTION_PROPS.name]: { title: [{ type: 'text', text: { content: `Week of ${weekStart}` } }] },
        [NOTION_PROPS.date]: { date: { start: weekStart } },
        [NOTION_PROPS.type]: { select: { name: 'Digest' } },
        [NOTION_PROPS.totalCostUsd]: { number: weekTotalUsd },
        [NOTION_PROPS.syncedAt]: { date: { start: new Date().toISOString() } },
      };
      if (existing) {
        await this.client.pages.update({ page_id: existing, properties: props as never });
        await this.rebuildPageBody(existing, body);
        return existing;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await this.client.pages.create({
        parent: { database_id: this.databaseId },
        properties: props as never,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        children: body as any,
      });
      return res.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  notion: digest upsert failed for ${weekStart}: ${msg}`);
      return null;
    }
  }

  // Delete all top-level children of a page, then append new ones. Used
  // by `tokentrail sync --rebuild-bodies` to refresh existing pages whose
  // body was empty (created before this feature) or stale.
  async rebuildPageBody(
    pageId: string,
    children: NotionBlock[]
  ): Promise<boolean> {
    try {
      // List + delete existing children. Notion paginates; loop until done.
      let cursor: string | undefined;
      const toDelete: string[] = [];
      do {
        const res = await this.client.blocks.children.list({
          block_id: pageId,
          start_cursor: cursor,
          page_size: 100,
        });
        for (const block of res.results) {
          if ('id' in block && typeof block.id === 'string') {
            toDelete.push(block.id);
          }
        }
        cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
      } while (cursor);

      for (const blockId of toDelete) {
        await this.client.blocks.delete({ block_id: blockId });
      }

      // Append in batches of 100 (Notion API cap).
      for (let i = 0; i < children.length; i += 100) {
        const slice = children.slice(i, i + 100);
        await this.client.blocks.children.append({
          block_id: pageId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          children: slice as any,
        });
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  notion: rebuild body failed for ${pageId}: ${msg}`);
      return false;
    }
  }
}

// ─── Page body builder ──────────────────────────────────────────────

export type RollupBodyContext = {
  sessions: SessionRef[];
  commits: CommitRef[];
  prs: PrRef[];
};

const MAX_SESSIONS_IN_BODY = 30;
const MAX_COMMITS_IN_BODY = 30;
const MAX_PRS_IN_BODY = 20;

export function buildRollupBody(ctx: RollupBodyContext, opts?: { dashboardUrl?: string }): NotionBlock[] {
  const blocks: NotionBlock[] = [];

  if (opts?.dashboardUrl) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          { type: 'text', text: { content: 'View on dashboard →', link: { url: opts.dashboardUrl } } },
        ],
      },
    });
  }

  // Sessions section.
  if (ctx.sessions.length > 0) {
    blocks.push(heading('Sessions'));
    const shown = ctx.sessions.slice(0, MAX_SESSIONS_IN_BODY);
    for (const s of shown) {
      const cost = '$' + s.cost.toFixed(2);
      const title = s.title?.trim() || '(no first prompt)';
      const idShort = s.sessionId.slice(0, 8);
      blocks.push(bullet([plain(`${cost} · ${idShort} — ${truncate(title, 200)}`)]));
    }
    if (ctx.sessions.length > shown.length) {
      blocks.push(
        bullet([plain(`(+${ctx.sessions.length - shown.length} more sessions)`)])
      );
    }
  }

  // Pull Requests section.
  if (ctx.prs.length > 0) {
    blocks.push(heading('Pull Requests'));
    const shown = ctx.prs.slice(0, MAX_PRS_IN_BODY);
    for (const pr of shown) {
      blocks.push(
        bullet([
          plain(`[${pr.state}] `),
          link(`${pr.repo}#${pr.prNumber}`, pr.url),
          plain(`  ${truncate(pr.title, 180)}`),
        ])
      );
    }
    if (ctx.prs.length > shown.length) {
      blocks.push(
        bullet([plain(`(+${ctx.prs.length - shown.length} more PRs)`)])
      );
    }
  }

  // Commits section.
  if (ctx.commits.length > 0) {
    blocks.push(heading('Commits'));
    const shown = ctx.commits.slice(0, MAX_COMMITS_IN_BODY);
    for (const c of shown) {
      const shaShort = c.sha.slice(0, 8);
      const url = c.repo
        ? `https://github.com/${c.repo}/commit/${c.sha}`
        : null;
      const runs = [];
      if (url) {
        runs.push(link(shaShort, url));
      } else {
        runs.push(plain(shaShort));
      }
      runs.push(plain(`  ${truncate(c.subject, 200)}`));
      blocks.push(bullet(runs));
    }
    if (ctx.commits.length > shown.length) {
      blocks.push(
        bullet([plain(`(+${ctx.commits.length - shown.length} more commits)`)])
      );
    }
  }

  return blocks;
}

function heading(text: string): NotionBlock {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: [plain(text)] },
  };
}

function bullet(richText: NotionBlock[]): NotionBlock {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: richText },
  };
}

function plain(content: string): NotionBlock {
  return { type: 'text', text: { content } };
}

function link(content: string, url: string): NotionBlock {
  return { type: 'text', text: { content, link: { url } } };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

// One-time Notion schema setup (manual via Notion UI, or via the
// notion-update-data-source MCP tool — see
// docs/superpowers/specs/2026-06-15-tokentrail-visualization-design.md):
//
//   ALTER COLUMN "Type"           SET SELECT WITH OPTIONS "Rollup", "Digest"
//   ALTER COLUMN "Anomaly"        SET CHECKBOX
//   ALTER COLUMN "Anomaly reason" SET RICH_TEXT
//
// Sync will silently warn-and-continue until these columns exist.
function buildProperties(p: RollupPagePayload) {
  const props: Record<string, unknown> = {
    [NOTION_PROPS.name]: {
      title: [
        { type: 'text', text: { content: `${p.featureKey} · ${p.date}` } },
      ],
    },
    [NOTION_PROPS.date]: { date: { start: p.date } },
    [NOTION_PROPS.featureKey]: {
      rich_text: [{ type: 'text', text: { content: p.featureKey } }],
    },
    [NOTION_PROPS.featureName]: {
      rich_text: [{ type: 'text', text: { content: p.featureName } }],
    },
    [NOTION_PROPS.branches]: {
      rich_text: [{ type: 'text', text: { content: p.branches } }],
    },
    [NOTION_PROPS.totalCostUsd]: { number: p.totalCostUsd },
    [NOTION_PROPS.totalInputTokens]: { number: p.totalInputTokens },
    [NOTION_PROPS.totalOutputTokens]: { number: p.totalOutputTokens },
    [NOTION_PROPS.sessions]: { number: p.sessions },
    [NOTION_PROPS.syncedAt]: { date: { start: new Date().toISOString() } },
    [NOTION_PROPS.commits]: {
      rich_text: [
        { type: 'text', text: { content: p.commitSummary ?? '' } },
      ],
    },
    [NOTION_PROPS.type]: { select: { name: p.type } },
    [NOTION_PROPS.anomaly]: { checkbox: p.isAnomaly },
    [NOTION_PROPS.anomalyReason]: {
      rich_text: [{ type: 'text', text: { content: p.anomalyReason ?? '' } }],
    },
  };
  // Repo is multi_select — one rollup can span multiple repos when the same
  // feature key shows up in more than one repo on the same day. We always
  // emit an array (possibly empty) so Notion replaces, not merges.
  const repoNames = (p.repo ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  props[NOTION_PROPS.repo] = {
    multi_select: repoNames.map((name) => ({ name })),
  };
  return props as Parameters<Client['pages']['create']>[0]['properties'];
}
