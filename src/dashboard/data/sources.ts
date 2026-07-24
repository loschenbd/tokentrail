import type DatabaseType from 'better-sqlite3';

export type SourceCost = {
  key: 'claude' | 'cursor';
  label: string;
  usd: number;
  extra?: { aiLines?: number };
};
export type SourcesResponse = { days: number; totalUsd: number; sources: SourceCost[] };

// Dollars-only combined view. Claude's windowed dollars are passed in (they are
// already computed by the panel — todayUsd / last30Usd — so the combined total
// always matches the panel). Cursor's dollars come from the per-day rollup;
// Cursor AI-lines ride along in `extra` and are NEVER added into totalUsd.
export function buildSources(
  db: DatabaseType.Database,
  opts: { days: number; claudeUsd: number }
): SourcesResponse {
  const sources: SourceCost[] = [
    { key: 'claude', label: 'Claude Code', usd: round2(opts.claudeUsd) },
  ];

  // Cursor windowed dollars from the daily rollup. Stored dates are UTC; the
  // window boundary uses localtime to match the app's "today" convention
  // (minor accepted skew). days=1 -> today.
  const cutoff = `date('now','localtime','-${Math.max(0, opts.days - 1)} days')`;
  const cursorUsd = (db
    .prepare(`SELECT COALESCE(SUM(usd), 0) AS u FROM cursor_daily_cost WHERE date >= ${cutoff}`)
    .get() as { u: number }).u;
  const aiLines = (db
    .prepare(`SELECT COALESCE(SUM(ai_lines), 0) AS n FROM cursor_code_attribution WHERE repo IS NOT NULL`)
    .get() as { n: number }).n;

  // Include Cursor only when there's something to show (dollars or lines).
  if (cursorUsd > 0 || aiLines > 0) {
    sources.push({
      key: 'cursor', label: 'Cursor', usd: round2(cursorUsd),
      extra: aiLines > 0 ? { aiLines } : undefined,
    });
  }

  const totalUsd = round2(sources.reduce((sum, s) => sum + s.usd, 0));
  return { days: opts.days, totalUsd, sources };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
