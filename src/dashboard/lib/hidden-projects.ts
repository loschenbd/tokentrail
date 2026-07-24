import type DatabaseType from 'better-sqlite3';
import { readSettings } from '../../lib/settings.js';
import { bucketProject } from './project-bucket.js';

// Display-layer filter for settings.hiddenProjects. A pattern hides a
// project when its normalized form appears as a substring of the project's
// normalized name, key, repo slug, feature key, or session project_dir —
// so one entry like "job-search" catches loschenbd/job-search,
// local/job-search-claude-code-setup, the "Job Search" outside bucket, and
// worktrees under ~/Projects/job-search alike.
//
// Deliberately NOT applied to canonicalProjectColors: hiding a project must
// not reshuffle every other project's hue, so hidden projects keep claiming
// their color slot — they just never render.

/** Lowercase and collapse runs of non-alphanumerics to '-', so
 *  "Job Search", "job_search", and "/Projects/job-search/" all compare
 *  equal to the pattern "job-search". */
export function normalizeProjectToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Normalized hiddenProjects patterns from settings.json. */
export function hiddenProjectPatterns(): string[] {
  return readSettings().hiddenProjects.map(normalizeProjectToken).filter((p) => p.length > 0);
}

export function matchesHiddenPattern(patterns: string[], ...values: Array<string | null | undefined>): boolean {
  if (patterns.length === 0) return false;
  for (const v of values) {
    if (!v) continue;
    const norm = normalizeProjectToken(v);
    if (norm && patterns.some((p) => norm.includes(p))) return true;
  }
  return false;
}

/**
 * Resolve which feature_keys belong to hidden projects. feature_rollups
 * rows only carry (feature_key, feature_name, repo), so the match runs
 * against the bucketed project identity plus the raw columns.
 */
export function hiddenFeatureKeys(db: DatabaseType.Database, patterns: string[]): string[] {
  if (patterns.length === 0) return [];
  const rows = db
    .prepare(`
      SELECT feature_key AS featureKey,
             MAX(feature_name) AS featureName,
             MAX(repo) AS repo
      FROM feature_rollups
      GROUP BY feature_key
    `)
    .all() as Array<{ featureKey: string; featureName: string; repo: string | null }>;
  const hidden: string[] = [];
  for (const r of rows) {
    const { projectKey, projectName } = bucketProject(r);
    if (matchesHiddenPattern(patterns, projectKey, projectName, r.repo, r.featureKey, r.featureName)) {
      hidden.push(r.featureKey);
    }
  }
  return hidden;
}

function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** WHERE fragment keeping only visible feature_rollups rows. Always truthy
 *  so call sites can interpolate it unconditionally inside AND chains. */
export function rollupVisiblePredicate(hiddenKeys: string[], column = 'feature_key'): string {
  if (hiddenKeys.length === 0) return '1=1';
  return `${column} NOT IN (${hiddenKeys.map(sqlQuote).join(', ')})`;
}

/** Visibility filter for the `anomalies` table specifically. Its feature_key
 *  can be NULL (day-level anomalies), so it's COALESCEd to '' — a bare
 *  `feature_key NOT IN (...)` evaluates to NULL for those rows and would
 *  silently drop them. Always truthy for AND-chain interpolation. */
export function anomalyVisiblePredicate(hiddenKeys: string[]): string {
  return rollupVisiblePredicate(hiddenKeys, `COALESCE(feature_key, '')`);
}

/**
 * Canonical WHERE fragment for anomalies SHOWN to the user: not dismissed AND
 * not on a hidden project. Every display surface that lists anomalies — the
 * menubar today API, the Worth a look page, the overview, the project detail
 * page — MUST filter through this so they can't disagree about which anomalies
 * are "active" (this pairing drifted once when the menubar API kept the
 * dismissed clause but dropped the visibility one). The project detail page
 * passes empty hiddenKeys on purpose: it is already scoped to one project's
 * feature_keys, so hidden-project filtering is a no-op there, but it still
 * shares the dismissed semantics. Pass includeDismissed to keep dismissed rows
 * (still visibility-filtered), e.g. Worth a look's "Show dismissed" toggle.
 * Always truthy.
 */
export function shownAnomalyPredicate(
  hiddenKeys: string[],
  opts: { includeDismissed?: boolean } = {}
): string {
  const visible = anomalyVisiblePredicate(hiddenKeys);
  return opts.includeDismissed ? visible : `dismissed_at IS NULL AND ${visible}`;
}

/** LIKE-escape for user patterns interpolated into NOT LIKE fragments. */
function likeEscape(s: string): string {
  return s.replace(/([\\%_])/g, '\\$1');
}

/** WHERE fragment keeping rows whose repo column matches no hidden pattern.
 *  Matches the raw slug case-insensitively (patterns are already lowercase
 *  and hyphen-normalized; repo slugs are hyphenated by convention). */
export function repoVisiblePredicate(patterns: string[], column = 'repo'): string {
  if (patterns.length === 0) return '1=1';
  return patterns
    .map((p) => `COALESCE(${column}, '') NOT LIKE ${sqlQuote(`%${likeEscape(p)}%`)} ESCAPE '\\'`)
    .join(' AND ');
}

/**
 * WHERE fragment for usage_events rows: hidden when the inferred feature
 * key is hidden OR the project_dir / repo matches a hidden pattern.
 */
export function eventsVisiblePredicate(
  patterns: string[],
  hiddenKeys: string[],
  alias = ''
): string {
  const col = (name: string): string => (alias ? `${alias}.${name}` : name);
  const parts: string[] = [];
  if (hiddenKeys.length > 0) {
    parts.push(`COALESCE(${col('inferred_feature_key')}, '') NOT IN (${hiddenKeys.map(sqlQuote).join(', ')})`);
  }
  if (patterns.length > 0) {
    parts.push(repoVisiblePredicate(patterns, col('project_dir')));
    parts.push(repoVisiblePredicate(patterns, col('repo')));
  }
  return parts.length > 0 ? `(${parts.join(' AND ')})` : '1=1';
}
