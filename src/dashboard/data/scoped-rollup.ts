import { randomUUID } from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import { aggregateFeatureBuckets, type UsageSource } from '../../lib/feature-aggregate.js';

// A harness scope for the overview. 'all' is the blended default (reads the
// real feature_rollups); the others render a source-scoped overview.
export type SourceScope = 'all' | UsageSource | 'cursor';
export const SOURCE_SCOPES: SourceScope[] = ['all', 'claude', 'copilot', 'cursor'];

export function isSourceScope(v: unknown): v is SourceScope {
  return typeof v === 'string' && (SOURCE_SCOPES as string[]).includes(v);
}

// Human labels for the picker, matching the sources/native-app vocabulary.
export const SCOPE_LABELS: Record<SourceScope, string> = {
  all: 'All sources',
  claude: 'Claude Code',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
};

// Which scopes actually have data, so the picker only offers real sources.
// 'all' is always present. Claude/Copilot key off usage_events.source; Cursor
// off its daily-cost table. Mirrors the native app's "only show sources with
// activity" rule.
export function presentScopes(db: DatabaseType.Database): SourceScope[] {
  const scopes: SourceScope[] = ['all'];
  const hasSource = (vals: string[]): boolean => {
    const inList = vals.map((v) => `'${v}'`).join(', ');
    const row = db
      .prepare(`SELECT 1 FROM usage_events WHERE source IN (${inList}) LIMIT 1`)
      .get();
    return row != null;
  };
  if (hasSource(['jsonl', 'hook'])) scopes.push('claude');
  if (hasSource(['copilot'])) scopes.push('copilot');
  const hasCursor = db
    .prepare(`SELECT 1 FROM cursor_daily_cost WHERE usd > 0 LIMIT 1`)
    .get();
  if (hasCursor != null) scopes.push('cursor');
  return scopes;
}

// The one temp table the scoped overview reads from. Per-connection (SQLite
// TEMP), and better-sqlite3 is synchronous so populate-then-query within a
// single request never interleaves with another. Same column shape as
// feature_rollups for the subset of columns buildOverview reads.
const SCOPED_TABLE = 'scoped_rollup';

function ensureTable(db: DatabaseType.Database): void {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${SCOPED_TABLE} (
    id                    TEXT PRIMARY KEY,
    date                  TEXT NOT NULL,
    project_key           TEXT,
    feature_key           TEXT NOT NULL,
    feature_name          TEXT NOT NULL,
    repo                  TEXT,
    branches              TEXT,
    total_input_tokens    INTEGER NOT NULL DEFAULT 0,
    total_output_tokens   INTEGER NOT NULL DEFAULT 0,
    total_cost_usd        REAL NOT NULL DEFAULT 0,
    sessions_count        INTEGER NOT NULL DEFAULT 0
  )`);
}

// Materialize the rollup rows for a single harness into the scoped temp table
// and return its name. For 'all' this is a no-op that returns the real
// feature_rollups table (the blended default path is untouched). Callers pass
// the returned name to buildOverview({ rollupTable }).
export function materializeScopedRollup(db: DatabaseType.Database, scope: SourceScope): string {
  if (scope === 'all') return 'feature_rollups';

  ensureTable(db);
  db.exec(`DELETE FROM ${SCOPED_TABLE}`);

  const insert = db.prepare(`
    INSERT INTO ${SCOPED_TABLE}
      (id, date, feature_key, feature_name, repo, branches,
       total_input_tokens, total_output_tokens, total_cost_usd, sessions_count)
    VALUES
      (@id, @date, @feature_key, @feature_name, @repo, @branches,
       @in_tokens, @out_tokens, @cost, @sessions)
  `);

  const tx = db.transaction(() => {
    if (scope === 'cursor') {
      populateCursor(db, insert);
    } else {
      populateUsageSource(db, insert, scope);
    }
  });
  tx();
  return SCOPED_TABLE;
}

// Claude / Copilot: reuse the exact same (date, feature) aggregation the rollup
// writer uses, scoped to the harness's usage_events.source values, so a
// source-scoped overview attributes spend identically to the blended one.
function populateUsageSource(
  db: DatabaseType.Database,
  insert: DatabaseType.Statement,
  source: UsageSource
): void {
  const buckets = aggregateFeatureBuckets(db, { source });
  for (const b of buckets.values()) {
    insert.run({
      id: randomUUID(),
      date: b.date,
      feature_key: b.featureKey,
      feature_name: b.featureName,
      repo: [...b.repos].sort().join(',') || null,
      branches: [...b.branches].sort().join(','),
      in_tokens: b.inTokens,
      out_tokens: b.outTokens,
      cost: round2(b.cost),
      sessions: b.sessionIds.size,
    });
  }
}

// Cursor is metered, not per-event: its store gives a per-DAY dollar figure
// (cursor_daily_cost) with no repo/feature breakdown of cost. So a Cursor
// "overview" is a single metered band over time — honest to what Cursor's API
// exposes. (AI-authored lines live in cursor_code_attribution but are counts,
// not cost, so they can't populate a cost band.)
function populateCursor(db: DatabaseType.Database, insert: DatabaseType.Statement): void {
  const rows = db
    .prepare(`SELECT date, usd FROM cursor_daily_cost WHERE usd > 0 ORDER BY date`)
    .all() as Array<{ date: string; usd: number }>;
  for (const r of rows) {
    insert.run({
      id: randomUUID(),
      date: r.date,
      feature_key: 'cursor-metered',
      feature_name: 'Cursor (metered)',
      repo: null,
      branches: '',
      in_tokens: 0,
      out_tokens: 0,
      cost: round2(r.usd),
      sessions: 0,
    });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
