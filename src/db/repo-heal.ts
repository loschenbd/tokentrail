import type Database from 'better-sqlite3';

// Repo-identity heal.
//
// repoContextFor() stamps events `local/<basename>` when a checkout has no
// origin remote. Once a remote appears, the same directory produces
// `owner/<name>` — one project, two identities, fragmented rollups. The
// merge rule is provable, not guessed: a local/X repo is the same project
// as slug owner/N iff both were observed on the same usage_events.project_dir.

export type HealResult = {
  healed: Array<{ from: string; to: string }>;
  ambiguous: string[];
};

export function healLocalRepoIdentities(db: Database.Database): HealResult {
  const healed: HealResult['healed'] = [];
  const ambiguous: string[] = [];

  const locals = db
    .prepare(`SELECT DISTINCT repo FROM usage_events WHERE repo LIKE 'local/%'`)
    .all() as Array<{ repo: string }>;
  if (locals.length === 0) return { healed, ambiguous };

  const findSlugs = db.prepare(`
    SELECT DISTINCT ue2.repo AS slug
    FROM usage_events ue1
    JOIN usage_events ue2 ON ue2.project_dir = ue1.project_dir
    WHERE ue1.repo = ?
      AND ue1.project_dir IS NOT NULL
      AND ue2.repo IS NOT NULL AND ue2.repo != ''
      AND ue2.repo NOT LIKE 'local/%'
  `);

  for (const { repo: localRepo } of locals) {
    const slugs = findSlugs.all(localRepo) as Array<{ slug: string }>;
    if (slugs.length === 0) continue;           // genuinely local-only
    if (slugs.length > 1) {                     // ambiguous — never guess
      ambiguous.push(localRepo);
      continue;
    }
    rewriteRepo(db, localRepo, slugs[0]!.slug);
    healed.push({ from: localRepo, to: slugs[0]!.slug });
  }

  if (healed.length > 0) {
    const detail = healed.map((h) => `${h.from} -> ${h.to}`).join(', ');
    console.log(`Merged ${healed.length} local repo identit${healed.length === 1 ? 'y' : 'ies'}: ${detail}`);
  }
  for (const a of ambiguous) {
    console.log(`Skipped ${a}: multiple remote repos share its directory; left as-is.`);
  }
  return { healed, ambiguous };
}

function rewriteRepo(db: Database.Database, from: string, to: string): void {
  // Unconstrained repo columns: plain UPDATE.
  db.prepare(`UPDATE usage_events SET repo = ? WHERE repo = ?`).run(to, from);
  db.prepare(`UPDATE session_commits SET repo = ? WHERE repo = ?`).run(to, from);

  // Tables where repo participates in a unique constraint: the slug twin
  // wins; drop the local row when updating would collide, then update.
  db.prepare(`
    DELETE FROM work_units WHERE repo = @from AND EXISTS (
      SELECT 1 FROM work_units w2 WHERE w2.repo = @to AND w2.branch = work_units.branch)
  `).run({ from, to });
  db.prepare(`UPDATE work_units SET repo = @to WHERE repo = @from`).run({ from, to });

  db.prepare(`
    DELETE FROM session_prs WHERE repo = @from AND EXISTS (
      SELECT 1 FROM session_prs p2 WHERE p2.repo = @to
        AND p2.session_id = session_prs.session_id AND p2.pr_number = session_prs.pr_number)
  `).run({ from, to });
  db.prepare(`UPDATE session_prs SET repo = @to WHERE repo = @from`).run({ from, to });

  db.prepare(`
    DELETE FROM branch_merges WHERE repo = @from AND EXISTS (
      SELECT 1 FROM branch_merges b2 WHERE b2.repo = @to AND b2.branch = branch_merges.branch)
  `).run({ from, to });
  db.prepare(`UPDATE branch_merges SET repo = @to WHERE repo = @from`).run({ from, to });

  // feature_rollups.repo is a CSV — replace the entry, then dedupe.
  // Comma-sentinel needle matches whole entries only (same pattern as project.ts).
  const rows = db
    .prepare(`SELECT id, repo FROM feature_rollups WHERE (',' || repo || ',') LIKE ?`)
    .all(`%,${from},%`) as Array<{ id: string; repo: string }>;
  const updRollup = db.prepare(`UPDATE feature_rollups SET repo = ? WHERE id = ?`);
  for (const r of rows) {
    const entries = r.repo
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((e) => (e === from ? to : e));
    updRollup.run([...new Set(entries)].join(','), r.id);
  }
}

// Ingest-time prevention: when a checkout has no remote, prefer a slug
// already observed on the same directory over the local/<basename> fallback.
export function knownSlugForDir(db: Database.Database, projectDir: string): string | null {
  const rows = db
    .prepare(`
      SELECT DISTINCT repo FROM usage_events
      WHERE project_dir = ? AND repo IS NOT NULL AND repo != '' AND repo NOT LIKE 'local/%'
    `)
    .all(projectDir) as Array<{ repo: string }>;
  return rows.length === 1 ? rows[0]!.repo : null;
}
