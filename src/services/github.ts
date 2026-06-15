import { Octokit } from '@octokit/rest';

export type PrInfo = {
  number: number;
  title: string;
  labels: string[];
  mergedAt: string | null;
  state: 'open' | 'closed';
  body: string | null;
  linkedIssue: number | null;
};

export class GitHubService {
  private readonly client: Octokit;

  constructor(token: string) {
    this.client = new Octokit({ auth: token });
  }

  // Look up the most recent PR whose head branch is `branch` on `owner/repo`.
  // Returns null when no PR exists or the lookup fails.
  async findPrByBranch(
    owner: string,
    repo: string,
    branch: string
  ): Promise<PrInfo | null> {
    try {
      const res = await this.client.rest.pulls.list({
        owner,
        repo,
        state: 'all',
        head: `${owner}:${branch}`,
        per_page: 5,
        sort: 'updated',
        direction: 'desc',
      });
      const pr = res.data[0];
      if (!pr) return null;
      return {
        number: pr.number,
        title: pr.title,
        labels: pr.labels
          .map((l) => (typeof l === 'string' ? l : l.name ?? ''))
          .filter((s) => s.length > 0),
        mergedAt: pr.merged_at,
        state: pr.state === 'open' ? 'open' : 'closed',
        body: pr.body,
        linkedIssue: parseLinkedIssue(pr.body),
      };
    } catch (err) {
      // 404 from this endpoint just means "no PR with that head" — common
      // for branches that were merged + deleted, or never PR'd. Silence
      // those; surface only unexpected failures (auth, rate limit, etc.).
      const status = (err as { status?: number })?.status;
      if (status === 404) return null;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  github: ${owner}/${repo}#${branch} lookup failed: ${msg}`);
      return null;
    }
  }
}

// Match "closes #123", "fixes #4", "resolves #88", case-insensitive,
// at any point in the PR body. First match wins.
const ISSUE_RE = /\b(?:closes?|fixes?|resolves?)\s+#(\d+)\b/i;

export function parseLinkedIssue(body: string | null | undefined): number | null {
  if (!body) return null;
  const m = body.match(ISSUE_RE);
  if (!m) return null;
  return Number.parseInt(m[1] ?? '', 10) || null;
}

export function parseRepoOwnerName(slug: string): { owner: string; repo: string } | null {
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}
