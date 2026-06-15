import { getDb } from '../db/db.js';

export type SessionsOptions = {
  top?: number;
  outsideOnly?: boolean;
  feature?: string;
};

type Row = {
  session_id: string;
  title: string | null;
  project_dir: string | null;
  repo: string | null;
  branch: string | null;
  feature_key: string | null;
  override_key: string | null;
  override_name: string | null;
  cost: number;
  events: number;
  first_seen_at: string | null;
  commit_count: number;
  first_commit_subject: string | null;
};

export async function runSessions(opts: SessionsOptions): Promise<void> {
  const db = getDb();
  const top = Math.max(1, opts.top ?? 20);

  // Join sessions to their dominant (repo, branch) and rollup-feature.
  // A single session might span multiple branches (rare) — we pick the
  // one with the most events to label it.
  const filterClauses: string[] = [];
  if (opts.outsideOnly) {
    filterClauses.push(`(e.repo IS NULL OR e.repo = '')`);
  }
  if (opts.feature) {
    // Match against the session's override OR its work-unit-derived key,
    // so the filter agrees with what `tokentrail report` uses as the
    // bucket name.
    filterClauses.push(
      `(COALESCE(s.feature_override, '') LIKE '%' || @feature || '%'
        OR COALESCE(w.feature_key, '') LIKE '%' || @feature || '%')`
    );
  }
  const where = filterClauses.length ? `WHERE ${filterClauses.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT
         s.session_id,
         s.title,
         s.project_dir,
         s.feature_override AS override_key,
         s.feature_override_name AS override_name,
         e.repo,
         e.branch,
         w.feature_key,
         SUM(e.estimated_cost_usd) AS cost,
         COUNT(*) AS events,
         MIN(e.timestamp) AS first_seen_at,
         (SELECT COUNT(*) FROM session_commits c WHERE c.session_id = s.session_id) AS commit_count,
         (SELECT c.subject FROM session_commits c WHERE c.session_id = s.session_id
            ORDER BY c.authored_at LIMIT 1) AS first_commit_subject
       FROM usage_events e
       JOIN sessions s ON s.session_id = e.session_id
       LEFT JOIN work_units w ON w.repo = e.repo AND w.branch = e.branch
       ${where}
       GROUP BY s.session_id
       ORDER BY cost DESC
       LIMIT @top`
    )
    .all({ top, feature: opts.feature ?? '' }) as Row[];

  if (rows.length === 0) {
    console.log('No sessions match.');
    return;
  }

  console.log(`Top ${rows.length} session${rows.length === 1 ? '' : 's'} by cost:`);
  console.log('─'.repeat(96));
  for (const r of rows) {
    const date = (r.first_seen_at ?? '').slice(0, 10);
    const cost = '$' + (r.cost ?? 0).toFixed(2);
    const bucket = r.repo
      ? `${r.repo}#${r.branch ?? '?'}`
      : trimHome(r.project_dir) ?? '(no project dir)';
    const title = r.title ?? '(no first prompt)';
    const labelTag = r.override_key
      ? `  [label: ${r.override_key}]`
      : '';
    console.log(`${date}  ${cost.padStart(10)}  ${bucket}${labelTag}`);
    console.log(`           ${r.session_id.slice(0, 8)}…  ${title}`);
    if (r.commit_count > 0 && r.first_commit_subject) {
      const more = r.commit_count > 1 ? ` (+${r.commit_count - 1} more)` : '';
      console.log(`           commits: ${r.first_commit_subject}${more}`);
    }
    console.log('');
  }
}

function trimHome(p: string | null): string | null {
  if (!p) return null;
  const home = process.env.HOME ?? '';
  if (home && p.startsWith(home + '/')) return '~' + p.slice(home.length);
  if (home && p === home) return '~';
  return p;
}
