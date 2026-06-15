import { getDb } from '../db/db.js';
import { slugify } from '../lib/attribution.js';

export type LabelSetOptions = {
  sessionPrefix: string;
  featureKey: string;
  featureName?: string;
};

export type LabelClearOptions = {
  sessionPrefix: string;
};

// Set a per-session feature override. The session is matched by id prefix
// (≥4 chars, must resolve to exactly one session) so you can paste from
// `tokentrail sessions` output without typing a full UUID.
export async function setLabel(opts: LabelSetOptions): Promise<void> {
  const db = getDb();
  const session = resolveSession(db, opts.sessionPrefix);
  if (!session) return;

  const key = slugify(opts.featureKey);
  const name = (opts.featureName ?? humanize(opts.featureKey)).trim();
  db.prepare(
    `UPDATE sessions
     SET feature_override = @key,
         feature_override_name = @name
     WHERE session_id = @id`
  ).run({ id: session.session_id, key, name });

  console.log(
    `Labeled ${shortId(session.session_id)} → ${key} (${name})`
  );
  console.log(
    `  Title: ${session.title ?? '(none)'}`
  );
  console.log(
    `  Run \`tokentrail rollup\` to re-bucket this session's usage.`
  );
}

export async function clearLabel(opts: LabelClearOptions): Promise<void> {
  const db = getDb();
  const session = resolveSession(db, opts.sessionPrefix);
  if (!session) return;
  db.prepare(
    `UPDATE sessions
     SET feature_override = NULL, feature_override_name = NULL
     WHERE session_id = @id`
  ).run({ id: session.session_id });
  console.log(`Cleared label on ${shortId(session.session_id)}.`);
}

export async function listLabels(): Promise<void> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.session_id, s.title, s.feature_override AS key,
              s.feature_override_name AS name,
              COALESCE(SUM(e.estimated_cost_usd), 0) AS cost
       FROM sessions s
       LEFT JOIN usage_events e ON e.session_id = s.session_id
       WHERE s.feature_override IS NOT NULL
       GROUP BY s.session_id
       ORDER BY cost DESC`
    )
    .all() as Array<{
    session_id: string;
    title: string | null;
    key: string;
    name: string;
    cost: number;
  }>;

  if (rows.length === 0) {
    console.log('No session labels set.');
    console.log('Set one with: tokentrail label <session-id-prefix> <feature-key>');
    return;
  }

  console.log(`${rows.length} labeled session${rows.length === 1 ? '' : 's'}:`);
  console.log('─'.repeat(96));
  for (const r of rows) {
    const cost = '$' + r.cost.toFixed(2);
    console.log(`${shortId(r.session_id)}  ${cost.padStart(10)}  ${r.key} (${r.name})`);
    if (r.title) console.log(`           ${r.title.slice(0, 84)}`);
    console.log('');
  }
}

function resolveSession(
  db: ReturnType<typeof getDb>,
  prefix: string
): { session_id: string; title: string | null } | null {
  if (prefix.length < 4) {
    console.error('Session prefix must be at least 4 characters.');
    return null;
  }
  const matches = db
    .prepare(
      `SELECT session_id, title FROM sessions
       WHERE session_id LIKE @p
       LIMIT 5`
    )
    .all({ p: `${prefix}%` }) as Array<{ session_id: string; title: string | null }>;

  if (matches.length === 0) {
    console.error(`No session matches prefix "${prefix}".`);
    return null;
  }
  if (matches.length > 1) {
    console.error(
      `Prefix "${prefix}" matches ${matches.length} sessions — be more specific:`
    );
    for (const m of matches) {
      console.error(`  ${shortId(m.session_id)}  ${m.title ?? '(no title)'}`);
    }
    return null;
  }
  return matches[0]!;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function humanize(s: string): string {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}
