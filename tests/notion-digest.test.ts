import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigestBody, type DigestContext } from '../src/services/notion-digest.js';

// The blocks Notion expects are `Record<string, unknown>` shapes — we
// assert structurally with the loose typings so the test stays close to
// the wire format.
describe('buildDigestBody', () => {
  test('renders all five sections when ctx is populated', () => {
    const ctx: DigestContext = {
      weekStart: '2026-06-08',
      weekTotalUsd: 1234,
      priorWeekTotalUsd: 1100,
      topFeatures: [
        { featureKey: 'rag', featureName: 'Local RAG', costUsd: 600, sessions: 4 },
      ],
      anomalies: [
        { kind: 'spike_day', date: '2026-06-09', reason: '$400 — 4× …' },
      ],
      recentCommits: [
        { sha: 'abcdef0', subject: 'Add retriever', repo: 'me/rag' },
      ],
      openPrs: [
        { repo: 'me/rag', prNumber: 7, title: 'Add retriever', url: 'https://github.com/me/rag/pull/7', state: 'open' },
      ],
    };
    const blocks = buildDigestBody(ctx);
    const headingTexts = blocks
      .filter((b: any) => b.type === 'heading_2')
      .map((b: any) => b.heading_2.rich_text[0].text.content);
    assert.deepEqual(headingTexts, [
      'The trail so far',
      'Top burn paths',
      'Worth a look',
      'Recent commits',
      'Open PRs',
    ]);
  });

  test('skips empty sections gracefully', () => {
    const ctx: DigestContext = {
      weekStart: '2026-06-08',
      weekTotalUsd: 0,
      priorWeekTotalUsd: 0,
      topFeatures: [],
      anomalies: [],
      recentCommits: [],
      openPrs: [],
    };
    const blocks = buildDigestBody(ctx);
    const headingTexts = blocks
      .filter((b: any) => b.type === 'heading_2')
      .map((b: any) => b.heading_2.rich_text[0].text.content);
    // "Trail so far" always renders even at $0 — it's the headline.
    assert.deepEqual(headingTexts, ['The trail so far']);
  });
});
