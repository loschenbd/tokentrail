import { getDb } from '../db/db.js';

export type ReportOptions = {
  days?: number;
  repo?: string;
  feature?: string;
};

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
