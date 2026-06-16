import type { NotionBlock } from './notion.js';

export type DigestContext = {
  weekStart: string;             // YYYY-MM-DD (Monday)
  weekTotalUsd: number;
  priorWeekTotalUsd: number;
  topFeatures: Array<{ featureKey: string; featureName: string; costUsd: number; sessions: number }>;
  anomalies: Array<{ kind: string; date: string; reason: string }>;
  recentCommits: Array<{ sha: string; subject: string; repo: string | null }>;
  openPrs: Array<{ repo: string; prNumber: number; title: string; url: string; state: string }>;
};

export function buildDigestBody(ctx: DigestContext): NotionBlock[] {
  const blocks: NotionBlock[] = [];

  blocks.push(heading('The trail so far'));
  const delta = ctx.priorWeekTotalUsd > 0
    ? Math.round(((ctx.weekTotalUsd - ctx.priorWeekTotalUsd) / ctx.priorWeekTotalUsd) * 100)
    : 0;
  blocks.push(paragraph([
    plain(`$${ctx.weekTotalUsd.toFixed(0)} this week`),
    plain(ctx.priorWeekTotalUsd > 0
      ? `  ·  ${delta >= 0 ? '+' : ''}${delta}% vs prior week ($${ctx.priorWeekTotalUsd.toFixed(0)})`
      : '  ·  no prior-week baseline'),
  ]));

  if (ctx.topFeatures.length > 0) {
    blocks.push(heading('Top burn paths'));
    for (const f of ctx.topFeatures) {
      blocks.push(bullet([
        plain(`$${f.costUsd.toFixed(0)} — ${f.featureName} (${f.sessions} sessions)`),
      ]));
    }
  }

  if (ctx.anomalies.length > 0) {
    blocks.push(heading('Worth a look'));
    for (const a of ctx.anomalies) {
      blocks.push(bullet([plain(`${a.date} — ${a.reason}`)]));
    }
  }

  if (ctx.recentCommits.length > 0) {
    blocks.push(heading('Recent commits'));
    for (const c of ctx.recentCommits.slice(0, 10)) {
      const shaShort = c.sha.slice(0, 8);
      const url = c.repo ? `https://github.com/${c.repo}/commit/${c.sha}` : null;
      const runs: NotionBlock[] = url
        ? [link(shaShort, url), plain(`  ${c.subject}`)]
        : [plain(`${shaShort}  ${c.subject}`)];
      blocks.push(bullet(runs));
    }
  }

  if (ctx.openPrs.length > 0) {
    blocks.push(heading('Open PRs'));
    for (const p of ctx.openPrs) {
      blocks.push(bullet([
        plain(`[${p.state}] `),
        link(`${p.repo}#${p.prNumber}`, p.url),
        plain(`  ${p.title}`),
      ]));
    }
  }

  return blocks;
}

function heading(text: string): NotionBlock {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: [plain(text)] } };
}
function bullet(rich: NotionBlock[]): NotionBlock {
  return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rich } };
}
function paragraph(rich: NotionBlock[]): NotionBlock {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: rich } };
}
function plain(content: string): NotionBlock {
  return { type: 'text', text: { content } };
}
function link(content: string, url: string): NotionBlock {
  return { type: 'text', text: { content, link: { url } } };
}
