import { Client } from '@notionhq/client';

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
    existingPageId: string | null
  ): Promise<string | null> {
    const properties = buildProperties(payload);
    try {
      if (existingPageId) {
        await this.client.pages.update({
          page_id: existingPageId,
          properties,
        });
        return existingPageId;
      }
      const res = await this.client.pages.create({
        parent: { database_id: this.databaseId },
        properties,
      });
      return res.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `  notion: upsert failed for ${payload.featureKey}/${payload.date}: ${msg}`
      );
      return null;
    }
  }
}

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
