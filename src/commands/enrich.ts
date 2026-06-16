import { getDb } from '../db/db.js';
import { GitHubService, parseRepoOwnerName } from '../services/github.js';
import { attribute } from '../lib/attribution.js';

export type EnrichSummary = {
  scanned: number;
  enriched: number;
  prFound: number;
  skippedNoPr: number;
};

export type EnrichOptions = {
  // If true, re-enrich rows that have already been enriched.
  force?: boolean;
  // Sleep this many ms between GitHub requests; avoids secondary rate limits.
  delayMs?: number;
};

export async function runEnrich(opts: EnrichOptions = {}): Promise<EnrichSummary> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log(
      'GITHUB_TOKEN not set. Add it to .env to enrich work units with PR metadata.'
    );
    return { scanned: 0, enriched: 0, prFound: 0, skippedNoPr: 0 };
  }

  const db = getDb();
  // Skip local/* repos — they have no GitHub presence, so PR lookup is a
  // guaranteed 404. Branch-prefix attribution still runs for them at rollup.
  const rows = db
    .prepare(
      `SELECT id, repo, branch, github_enriched_at
       FROM work_units
       WHERE repo NOT LIKE 'local/%'
         ${opts.force ? '' : 'AND github_enriched_at IS NULL'}
       ORDER BY last_seen_at DESC`
    )
    .all() as Array<{
    id: string;
    repo: string;
    branch: string;
    github_enriched_at: string | null;
  }>;

  if (rows.length === 0) {
    console.log('No work units to enrich. Trail is up to date.');
    return { scanned: 0, enriched: 0, prFound: 0, skippedNoPr: 0 };
  }

  const gh = new GitHubService(token);
  const update = db.prepare(`
    UPDATE work_units
    SET pr_number = @pr_number,
        pr_title = @pr_title,
        pr_labels = @pr_labels,
        github_issue = @github_issue,
        feature_key = @feature_key,
        feature_name = @feature_name,
        status = @status,
        github_enriched_at = datetime('now')
    WHERE id = @id
  `);

  let prFound = 0;
  let enriched = 0;
  let skipped = 0;
  const delayMs = opts.delayMs ?? 250;

  for (const row of rows) {
    // Mainline branches don't have PRs by definition; mark enriched
    // so we don't keep hammering GitHub looking for them.
    if (isMainline(row.branch)) {
      update.run({
        id: row.id,
        pr_number: null,
        pr_title: null,
        pr_labels: null,
        github_issue: null,
        feature_key: applyAttr(row.repo, row.branch).featureKey,
        feature_name: applyAttr(row.repo, row.branch).featureName,
        status: 'active',
      });
      enriched++;
      skipped++;
      continue;
    }

    const parsed = parseRepoOwnerName(row.repo);
    if (!parsed) {
      skipped++;
      continue;
    }
    const pr = await gh.findPrByBranch(parsed.owner, parsed.repo, row.branch);
    if (!pr) {
      // Record the attempt so we don't keep retrying on every enrich run.
      update.run({
        id: row.id,
        pr_number: null,
        pr_title: null,
        pr_labels: null,
        github_issue: null,
        feature_key: applyAttr(row.repo, row.branch).featureKey,
        feature_name: applyAttr(row.repo, row.branch).featureName,
        status: 'active',
      });
      enriched++;
      skipped++;
      if (delayMs > 0) await sleep(delayMs);
      continue;
    }

    const attr = attribute({
      repo: row.repo,
      branch: row.branch,
      prLabels: pr.labels,
      prTitle: pr.title,
    });
    update.run({
      id: row.id,
      pr_number: pr.number,
      pr_title: pr.title,
      pr_labels: JSON.stringify(pr.labels),
      github_issue: pr.linkedIssue,
      feature_key: attr.featureKey,
      feature_name: attr.featureName,
      status: prStatus(pr),
    });
    prFound++;
    enriched++;
    console.log(`  enriched ${row.repo}#${row.branch} → ${attr.featureName} (PR #${pr.number})`);
    if (delayMs > 0) await sleep(delayMs);
  }

  console.log(
    `Enrich complete: ${enriched} updated, ${prFound} linked to a PR, ${skipped} without PR data.`
  );
  return { scanned: rows.length, enriched, prFound, skippedNoPr: skipped };
}

function isMainline(branch: string): boolean {
  return ['main', 'master', 'develop', 'staging'].includes(branch.toLowerCase());
}

function prStatus(
  pr: { mergedAt: string | null; state: 'open' | 'closed' }
): 'active' | 'merged' | 'closed' {
  if (pr.mergedAt) return 'merged';
  if (pr.state === 'closed') return 'closed';
  return 'active';
}

function applyAttr(repo: string, branch: string) {
  return attribute({ repo, branch });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
