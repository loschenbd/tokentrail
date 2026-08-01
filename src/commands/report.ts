import type DatabaseType from 'better-sqlite3';
import { getDb } from '../db/db.js';

export type ReportOptions = {
  days?: number;
  repo?: string;
  feature?: string;
  /** Scope the whole report to one usage source: 'copilot' | 'claude'. */
  source?: string;
};

// Map a friendly --source name to the usage_events.source values it covers.
// Claude spans two source tags (JSONL ingest + Stop-hook snapshots).
function sourceFilter(name: string): string[] | null {
  const n = name.toLowerCase();
  if (n === 'copilot') return ['copilot'];
  if (n === 'claude') return ['jsonl', 'hook'];
  return null;
}

type Row = {
  feature_key: string;
  feature_name: string;
  cost: number;
  sessions: number;
  branches: string;
};

export async function runReport(opts: ReportOptions): Promise<void> {
  const db = getDb();
  const days = Math.max(1, opts.days ?? 30);

  // A --source scope reports directly from usage_events (feature_rollups has no
  // source column), grouped by repo/branch with a per-model breakdown — the
  // dedicated per-source view.
  if (opts.source) {
    const sources = sourceFilter(opts.source);
    if (!sources) {
      console.log(`Unknown source "${opts.source}". Try: copilot | claude.`);
      return;
    }
    runSourceReport(db, opts.source, sources, days, opts.repo);
    return;
  }

  const params: Record<string, string | number> = { days };
  let where = `date >= date('now', '-' || @days || ' days')`;
  if (opts.repo) {
    where += ` AND repo LIKE '%' || @repo || '%'`;
    params.repo = opts.repo;
  }
  if (opts.feature) {
    where += ` AND (feature_key LIKE '%' || @feature || '%' OR feature_name LIKE '%' || @feature || '%')`;
    params.feature = opts.feature;
  }

  const rows = db
    .prepare(
      `SELECT
         feature_key,
         feature_name,
         SUM(total_cost_usd)        AS cost,
         SUM(sessions_count)        AS sessions,
         GROUP_CONCAT(DISTINCT branches) AS branches
       FROM feature_rollups
       WHERE ${where}
       GROUP BY feature_key, feature_name
       ORDER BY cost DESC`
    )
    .all(params) as Row[];

  const title = buildTitle(days, opts);
  const sep = '─'.repeat(64);

  console.log(title);
  console.log(sep);

  if (rows.length === 0) {
    console.log('No trail found for this filter.');
    const cursorLane = renderCursorLane(db);
    if (cursorLane) {
      console.log(cursorLane);
    }
    return;
  }

  console.log(
    pad('Feature', 32) +
      pad('Cost', 12) +
      pad('Sessions', 10) +
      pad('Branches', 10)
  );

  let totalCost = 0;
  let totalSessions = 0;
  const allBranches = new Set<string>();

  for (const r of rows) {
    const branchCount = countBranches(r.branches);
    const label = r.feature_name.length > 30
      ? r.feature_name.slice(0, 29) + '…'
      : r.feature_name;
    console.log(
      pad(label, 32) +
        pad('$' + r.cost.toFixed(2), 12) +
        pad(String(r.sessions), 10) +
        pad(String(branchCount), 10)
    );
    totalCost += r.cost;
    totalSessions += r.sessions;
    for (const b of (r.branches ?? '').split(',')) {
      if (b) allBranches.add(b);
    }
  }

  console.log(sep);
  console.log(
    pad('Total', 32) +
      pad('$' + totalCost.toFixed(2), 12) +
      pad(String(totalSessions), 10) +
      pad(String(allBranches.size), 10)
  );

  const cursorLane = renderCursorLane(db);
  if (cursorLane) {
    console.log(cursorLane);
  }
}

// Dedicated per-source view. Reads usage_events (filtered by source) rather
// than feature_rollups: spend by repo/branch plus a per-model breakdown —
// Copilot's distinguishing dimension (it routes GPT/Gemini/Claude).
export function runSourceReport(
  db: DatabaseType.Database,
  sourceLabel: string,
  sources: string[],
  days: number,
  repo?: string
): void {
  const placeholders = sources.map(() => '?').join(',');
  const params: Array<string | number> = [...sources, days];
  let where = `source IN (${placeholders}) AND date(timestamp) >= date('now', '-' || ? || ' days')`;
  if (repo) {
    where += ` AND repo LIKE '%' || ? || '%'`;
    params.push(repo);
  }

  const byBranch = db
    .prepare(
      `SELECT COALESCE(repo, '(unattributed)') AS repo,
              COALESCE(branch, '(none)')       AS branch,
              SUM(estimated_cost_usd)          AS cost,
              COUNT(DISTINCT session_id)       AS sessions,
              COUNT(*)                         AS events
       FROM usage_events
       WHERE ${where}
       GROUP BY repo, branch
       ORDER BY cost DESC`
    )
    .all(...params) as Array<{ repo: string; branch: string; cost: number; sessions: number; events: number }>;

  const byModel = db
    .prepare(
      `SELECT model, SUM(estimated_cost_usd) AS cost, COUNT(*) AS events
       FROM usage_events
       WHERE ${where}
       GROUP BY model
       ORDER BY cost DESC`
    )
    .all(...params) as Array<{ model: string; cost: number; events: number }>;

  const sep = '─'.repeat(64);
  console.log(`Tokentrail — Last ${days} day${days === 1 ? '' : 's'} · source=${sourceLabel} (estimated)`);
  console.log(sep);

  if (byBranch.length === 0) {
    console.log(`No ${sourceLabel} usage found for this window.`);
    return;
  }

  console.log(pad('Repo · Branch', 40) + pad('Cost', 12) + pad('Sessions', 10));
  let totalCost = 0;
  let totalSessions = 0;
  for (const r of byBranch) {
    const label = `${r.repo} · ${r.branch}`;
    const shown = label.length > 38 ? label.slice(0, 37) + '…' : label;
    console.log(pad(shown, 40) + pad('$' + r.cost.toFixed(2), 12) + pad(String(r.sessions), 10));
    totalCost += r.cost;
    totalSessions += r.sessions;
  }
  console.log(sep);
  console.log(pad('Total', 40) + pad('$' + totalCost.toFixed(2), 12) + pad(String(totalSessions), 10));

  console.log('\nBy model');
  for (const m of byModel) {
    console.log(
      `  ${pad(m.model, 30)} $${m.cost.toFixed(2)} · ${m.events} turn${m.events === 1 ? '' : 's'}`
    );
  }
}

export function renderCursorLane(db: DatabaseType.Database): string {
  const byFeature = db
    .prepare(
      `SELECT repo, branch, SUM(ai_lines) AS ai, SUM(human_lines) AS human,
              COUNT(*) AS commits
       FROM cursor_code_attribution
       WHERE repo IS NOT NULL
       GROUP BY repo, branch
       ORDER BY ai DESC
       LIMIT 20`
    )
    .all() as Array<{ repo: string; branch: string; ai: number; human: number; commits: number }>;
  const usage = db
    .prepare(`SELECT membership_type, plan_pct_used, metered_usd, truncated, stale
              FROM cursor_usage WHERE id = 1`)
    .get() as {
      membership_type: string | null; plan_pct_used: number | null;
      metered_usd: number | null; truncated: number; stale: number;
    } | undefined;

  if (byFeature.length === 0 && !usage) return '';

  const lines: string[] = ['', 'Cursor (all-time)'];
  if (usage) {
    const plan = usage.membership_type ?? 'unknown';
    const usd = usage.metered_usd != null ? `$${usage.metered_usd.toFixed(2)}` : 'n/a';
    const pct = usage.plan_pct_used != null ? ` · ${usage.plan_pct_used}% of included usage` : '';
    const partial = usage.truncated ? ' (partial)' : '';
    const staleTag = usage.stale ? ' (stale)' : '';
    lines.push(
      `  Usage (account-wide, estimated): ${plan} · ${usd} metered this cycle${partial}${pct}${staleTag} — not attributable per-feature.`
    );
  }
  for (const r of byFeature) {
    const pct = r.ai + r.human > 0 ? Math.round((r.ai / (r.ai + r.human)) * 100) : 0;
    lines.push(`  ${r.repo} ${r.branch}: ${r.ai} AI lines across ${r.commits} commit${r.commits === 1 ? '' : 's'} (${pct}% AI)`);
  }
  return lines.join('\n');
}

function buildTitle(days: number, opts: ReportOptions): string {
  const range = `Last ${days} day${days === 1 ? '' : 's'}`;
  const bits: string[] = [];
  if (opts.repo) bits.push(`repo=${opts.repo}`);
  if (opts.feature) bits.push(`feature=${opts.feature}`);
  return `Tokentrail — ${range}${bits.length ? ' · ' + bits.join(' · ') : ''}`;
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function countBranches(csv: string | null): number {
  if (!csv) return 0;
  const set = new Set<string>();
  for (const b of csv.split(',')) {
    if (b.trim()) set.add(b.trim());
  }
  return set.size;
}
