# Attribution Heal + Expandable "Other" Band Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge fragmented `local/X` / `owner/X` repo identities in the database so project attribution is correct, and make the "Other" legend row expandable to show its constituent tail projects.

**Architecture:** A new `src/db/repo-heal.ts` module owns the identity-merge rule (*a `local/X` repo is the same project as slug `owner/N` iff both were observed on the same `usage_events.project_dir`*). It is invoked from `runMigrations()` on every startup (idempotent) and from ingest to prevent new fragmentation. Display-side, `bucketProject()` prefers slug entries within a repo CSV, and the overview VM exposes the tail-project list that the legend renders as a collapsible sub-list.

**Tech Stack:** Node 20+, TypeScript via tsx, better-sqlite3, node:test (run with `npm test`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-02-attribution-heal-and-other-band-design.md`

## Global Constraints

- Migrations run on every startup and must be idempotent (project rule 1).
- GitHub/Notion/heal failures log cleanly, never crash the pipeline (rule 6).
- CLI/log language restrained and readable (rule 7).
- JSONL sources are read-only (rule 9) — we rewrite derived DB tables only.
- Attribution logic stays out of `src/lib/attribution.ts`'s domain — this work is repo *identity*, not session→feature attribution; keep it in `src/db/` and `src/dashboard/`.
- Tests use node:test + `assert/strict` with in-memory better-sqlite3 databases, matching `tests/dashboard-data.test.ts` conventions (createRequire for better-sqlite3).
- One deviation from the spec, already validated against the code: `feature:` project keys DO have working detail pages (`parseProjectKey` in `src/dashboard/data/project.ts:84` handles them), so ALL tail sub-rows are clickable links — no plain-text `outside:*` rows.

---

### Task 1: Repo-identity heal module

**Files:**
- Create: `src/db/repo-heal.ts`
- Modify: `src/db/migrations.ts` (call the heal after schema migrations)
- Test: `tests/repo-heal.test.ts`

**Interfaces:**
- Consumes: `usage_events`, `work_units`, `session_commits`, `session_prs`, `branch_merges`, `feature_rollups` tables (existing schema; `usage_events.project_dir` added by an existing migration).
- Produces:
  - `healLocalRepoIdentities(db: Database.Database): { healed: Array<{ from: string; to: string }>; ambiguous: string[] }` — exported from `src/db/repo-heal.ts`.
  - `knownSlugForDir(db: Database.Database, projectDir: string): string | null` — exported from `src/db/repo-heal.ts`; Task 3 imports this.

- [ ] **Step 1: Write the failing tests**

Create `tests/repo-heal.test.ts`:

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { healLocalRepoIdentities, knownSlugForDir } from '../src/db/repo-heal.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

function makeDb(): DatabaseType.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seedEvent(
  db: DatabaseType.Database,
  opts: { id: string; repo: string | null; projectDir: string | null }
): void {
  // model is NOT NULL with no default — must be supplied.
  db.prepare(`
    INSERT INTO usage_events (id, session_id, timestamp, repo, branch, project_dir, model,
                              input_tokens, output_tokens, estimated_cost_usd)
    VALUES (@id, 's1', '2026-06-26T12:00:00Z', @repo, 'main', @projectDir, 'test-model', 10, 10, 0.01)
  `).run({ id: opts.id, repo: opts.repo, projectDir: opts.projectDir });
}

describe('healLocalRepoIdentities', () => {
  test('rewrites local/X to the slug sharing its project_dir, across tables', () => {
    const db = makeDb();
    const dir = '/Users/ben/Projects/mud';
    seedEvent(db, { id: 'e1', repo: 'local/mud', projectDir: dir });
    seedEvent(db, { id: 'e2', repo: 'owner/mud', projectDir: dir });
    db.prepare(`INSERT INTO session_commits (session_id, commit_sha, repo) VALUES ('s1', 'abc', 'local/mud')`).run();
    db.prepare(`
      INSERT INTO feature_rollups (id, date, feature_key, feature_name, repo, total_cost_usd)
      VALUES ('r1', '2026-06-26', 'f1', 'F1', 'local/mud,owner/mud', 5)
    `).run();

    const result = healLocalRepoIdentities(db);

    assert.deepEqual(result.healed, [{ from: 'local/mud', to: 'owner/mud' }]);
    assert.equal(result.ambiguous.length, 0);
    const repos = db.prepare(`SELECT DISTINCT repo FROM usage_events ORDER BY repo`).all() as Array<{ repo: string }>;
    assert.deepEqual(repos.map((r) => r.repo), ['owner/mud']);
    const commit = db.prepare(`SELECT repo FROM session_commits WHERE commit_sha = 'abc'`).get() as { repo: string };
    assert.equal(commit.repo, 'owner/mud');
    // CSV entry replaced AND deduped
    const rollup = db.prepare(`SELECT repo FROM feature_rollups WHERE id = 'r1'`).get() as { repo: string };
    assert.equal(rollup.repo, 'owner/mud');
  });

  test('leaves genuinely local-only repos untouched', () => {
    const db = makeDb();
    seedEvent(db, { id: 'e1', repo: 'local/writing-mentor', projectDir: '/Users/ben/Projects/writing-mentor' });

    const result = healLocalRepoIdentities(db);

    assert.equal(result.healed.length, 0);
    const row = db.prepare(`SELECT repo FROM usage_events WHERE id = 'e1'`).get() as { repo: string };
    assert.equal(row.repo, 'local/writing-mentor');
  });

  test('skips and reports ambiguous local repos (two slugs share the dir)', () => {
    const db = makeDb();
    const dir = '/Users/ben/Projects/x';
    seedEvent(db, { id: 'e1', repo: 'local/x', projectDir: dir });
    seedEvent(db, { id: 'e2', repo: 'owner/x', projectDir: dir });
    seedEvent(db, { id: 'e3', repo: 'other/x', projectDir: dir });

    const result = healLocalRepoIdentities(db);

    assert.equal(result.healed.length, 0);
    assert.deepEqual(result.ambiguous, ['local/x']);
    const row = db.prepare(`SELECT repo FROM usage_events WHERE id = 'e1'`).get() as { repo: string };
    assert.equal(row.repo, 'local/x');
  });

  test('resolves UNIQUE(repo, branch) collisions in work_units by keeping the slug row', () => {
    const db = makeDb();
    const dir = '/Users/ben/Projects/mud';
    seedEvent(db, { id: 'e1', repo: 'local/mud', projectDir: dir });
    seedEvent(db, { id: 'e2', repo: 'owner/mud', projectDir: dir });
    const insertWu = db.prepare(`
      INSERT INTO work_units (id, repo, branch, feature_key, feature_name, first_seen_at, last_seen_at)
      VALUES (@id, @repo, 'main', 'f1', 'F1', '2026-06-26', '2026-06-26')
    `);
    insertWu.run({ id: 'wu-local', repo: 'local/mud' });
    insertWu.run({ id: 'wu-slug', repo: 'owner/mud' });

    healLocalRepoIdentities(db);

    const wus = db.prepare(`SELECT id, repo FROM work_units`).all() as Array<{ id: string; repo: string }>;
    assert.equal(wus.length, 1);
    assert.equal(wus[0]!.id, 'wu-slug');
    assert.equal(wus[0]!.repo, 'owner/mud');
  });

  test('is idempotent — second run heals nothing', () => {
    const db = makeDb();
    const dir = '/Users/ben/Projects/mud';
    seedEvent(db, { id: 'e1', repo: 'local/mud', projectDir: dir });
    seedEvent(db, { id: 'e2', repo: 'owner/mud', projectDir: dir });

    healLocalRepoIdentities(db);
    const second = healLocalRepoIdentities(db);

    assert.equal(second.healed.length, 0);
    assert.equal(second.ambiguous.length, 0);
  });
});

describe('knownSlugForDir', () => {
  test('returns the slug when exactly one non-local repo was seen on the dir', () => {
    const db = makeDb();
    seedEvent(db, { id: 'e1', repo: 'owner/mud', projectDir: '/p/mud' });
    assert.equal(knownSlugForDir(db, '/p/mud'), 'owner/mud');
  });

  test('returns null when zero or multiple slugs were seen', () => {
    const db = makeDb();
    assert.equal(knownSlugForDir(db, '/p/none'), null);
    seedEvent(db, { id: 'e1', repo: 'owner/x', projectDir: '/p/x' });
    seedEvent(db, { id: 'e2', repo: 'other/x', projectDir: '/p/x' });
    assert.equal(knownSlugForDir(db, '/p/x'), null);
  });
});

describe('runMigrations integration', () => {
  test('startup migration heals fragmented identities', () => {
    const db = new Database(':memory:');
    runMigrations(db);  // schema only, empty tables — must not throw
    const dir = '/Users/ben/Projects/mud';
    db.prepare(`
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, project_dir, model,
                                input_tokens, output_tokens, estimated_cost_usd)
      VALUES ('e1', 's1', '2026-06-26T12:00:00Z', 'local/mud', 'main', @dir, 'test-model', 10, 10, 0.01)
    `).run({ dir });
    db.prepare(`
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, project_dir, model,
                                input_tokens, output_tokens, estimated_cost_usd)
      VALUES ('e2', 's1', '2026-06-26T12:01:00Z', 'owner/mud', 'main', @dir, 'test-model', 10, 10, 0.01)
    `).run({ dir });

    runMigrations(db);  // second startup — heal fires

    const repos = db.prepare(`SELECT DISTINCT repo FROM usage_events ORDER BY repo`).all() as Array<{ repo: string }>;
    assert.deepEqual(repos.map((r) => r.repo), ['owner/mud']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test tests/repo-heal.test.ts`
Expected: FAIL — `Cannot find module '../src/db/repo-heal.js'`

- [ ] **Step 3: Implement `src/db/repo-heal.ts`**

```ts
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
```

- [ ] **Step 4: Wire into `runMigrations()`**

In `src/db/migrations.ts`, add the import at the top:

```ts
import { healLocalRepoIdentities } from './repo-heal.js';
```

and at the end of `runMigrations()`, after `tx();` (its own transaction so a heal failure can't roll back schema migrations; log-and-continue per rule 6):

```ts
  try {
    db.transaction(() => healLocalRepoIdentities(db))();
  } catch (err) {
    console.error(`Repo identity heal skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --import tsx --test tests/repo-heal.test.ts`
Expected: PASS (all 8 tests)

- [ ] **Step 6: Run the full suite to catch regressions**

Run: `npm test`
Expected: PASS. (Existing tests call `runMigrations` on empty in-memory DBs — the heal is a no-op there.)

- [ ] **Step 7: Commit**

```bash
git add src/db/repo-heal.ts src/db/migrations.ts tests/repo-heal.test.ts
git commit -m "feat(db): heal fragmented local/ repo identities on startup"
```

---

### Task 2: `bucketProject()` slug preference + `otherProjects` on the overview VM

**Files:**
- Modify: `src/dashboard/data/overview.ts` (VM type ~line 44; `tailProj` block ~line 262; `bucketProject` ~line 458; return statement ~line 449)
- Test: `tests/dashboard-data.test.ts` (append), `tests/overview-render.test.ts` (`emptyVM()` at line 6 gains the new field)

**Interfaces:**
- Consumes: existing `tailProj` computation inside `buildOverview` (`src/dashboard/data/overview.ts:262`).
- Produces: `OverviewVM.otherProjects: Array<{ key: string; name: string; totalUsd: number }>` sorted descending by `totalUsd` — Task 4's renderer consumes this. `bucketProject` behavior change: within a repo CSV, the first non-`local/` entry wins.

- [ ] **Step 1: Write the failing tests**

Append to `tests/dashboard-data.test.ts` (uses the existing `makeDb`, `seedRollups`, `daysAgo` helpers in that file):

```ts
import { bucketProject } from '../src/dashboard/data/overview.js';

describe('bucketProject slug preference', () => {
  test('prefers the slug entry over a local/ entry regardless of CSV order', () => {
    const r = { featureKey: 'f', featureName: 'F', repo: 'local/mud,owner/mud' };
    assert.deepEqual(bucketProject(r), { projectKey: 'repo:owner/mud', projectName: 'mud' });
  });

  test('falls back to the local/ entry when no slug is present', () => {
    const r = { featureKey: 'f', featureName: 'F', repo: 'local/mud' };
    assert.deepEqual(bucketProject(r), { projectKey: 'local:mud', projectName: 'mud' });
  });
});

describe('otherProjects', () => {
  test('exposes tail projects (rank 7+) sorted descending', () => {
    const db = makeDb();
    // 8 projects: $80, $70, ... $10. Top 6 get bands; $20 and $10 are the tail.
    seedRollups(
      db,
      Array.from({ length: 8 }, (_, i) => ({
        date: daysAgo(1),
        cost: 80 - i * 10,
        featureKey: `feat-${i}`,
        featureName: `Feat ${i}`,
        repo: `owner/proj-${i}`,
      }))
    );
    const vm = buildOverview({ db, days: 30 });
    assert.deepEqual(
      vm.otherProjects.map((p) => ({ key: p.key, totalUsd: p.totalUsd })),
      [
        { key: 'repo:owner/proj-6', totalUsd: 20 },
        { key: 'repo:owner/proj-7', totalUsd: 10 },
      ]
    );
  });

  test('is empty when six or fewer projects exist', () => {
    const db = makeDb();
    seedRollups(db, [{ date: daysAgo(1), cost: 10, featureKey: 'f', featureName: 'F', repo: 'owner/p' }]);
    const vm = buildOverview({ db, days: 30 });
    assert.deepEqual(vm.otherProjects, []);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test tests/dashboard-data.test.ts`
Expected: FAIL — `bucketProject` returns `local:mud` for the CSV case; `vm.otherProjects` is undefined.

- [ ] **Step 3: Implement**

In `src/dashboard/data/overview.ts`:

(a) Add to the `OverviewVM` type, after the `projects` field (~line 44):

```ts
  // Tail projects (rank 7+) collapsed into the Other band; the legend
  // renders these as an expandable sub-list. Sorted descending by spend.
  otherProjects: Array<{ key: string; name: string; totalUsd: number }>;
```

(b) In `bucketProject` (~line 462), replace the first-entry pick:

```ts
    // CSV-resilient: take the first non-empty repo string.
    const firstRepo = r.repo.split(',').map((s) => s.trim()).find((s) => s.length > 0) ?? r.repo;
```

with a slug-preferring pick (a `local/` entry only wins when no slug exists — the heal migration covers proven duplicates; this covers anything it couldn't prove):

```ts
    // CSV-resilient: prefer the first slug-style entry; a local/ alias of
    // the same project only wins when no remote slug was ever observed.
    const entries = r.repo.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    const firstRepo = entries.find((s) => !s.startsWith('local/')) ?? entries[0] ?? r.repo;
```

(c) After the `hasOther` block (~line 284), build the list:

```ts
  const otherProjects: OverviewVM['otherProjects'] = tailProj.map((r) => ({
    key: r.projKey,
    name: r.projName,
    totalUsd: r.total,
  }));
```

(d) Add `otherProjects,` to the returned object (next to `projects,` ~line 449).

(e) In `tests/overview-render.test.ts`, add `otherProjects: [],` to the object literal in `emptyVM()` (line 6) so the file typechecks.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test tests/dashboard-data.test.ts tests/overview-render.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/data/overview.ts tests/dashboard-data.test.ts tests/overview-render.test.ts
git commit -m "feat(dashboard): prefer slug repos in bucketProject; expose otherProjects"
```

---

### Task 3: Ingest-time prevention

**Files:**
- Modify: `src/commands/ingest.ts` (~line 119, inside the event loop where `repoContextFor` is called)

**Interfaces:**
- Consumes: `knownSlugForDir(db, projectDir)` from Task 1.
- Produces: nothing new — ingest stamps events with the known slug instead of the `local/` fallback. Behavior is covered by Task 1's `knownSlugForDir` unit tests; this task is wiring only.

- [ ] **Step 1: Wire the helper in**

In `src/commands/ingest.ts`, add the import:

```ts
import { knownSlugForDir } from '../db/repo-heal.js';
```

Then in the event loop (~line 119), after `ctx = repoContextFor(dir);` and before `repoCache.set(...)`:

```ts
      ctx = repoContextFor(dir);
      // A local/<basename> fallback for a dir that previously produced a
      // remote slug is the same project — stamp the slug, don't fragment.
      if (ctx.repo?.startsWith('local/')) {
        const known = knownSlugForDir(db, dir);
        if (known) ctx = { ...ctx, repo: known };
      }
      repoCache.set(event.projectDirEncoded, ctx);
```

(The `repoCache` already memoizes per directory, so the lookup runs at most once per project dir per ingest run. `db` is already in scope in this function.)

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS (no behavior change for remoteful repos; local-only dirs with no slug history are unchanged).

- [ ] **Step 3: Commit**

```bash
git add src/commands/ingest.ts
git commit -m "feat(ingest): prevent repo identity fragmentation at insert time"
```

---

### Task 4: Expandable "Other" legend row

**Files:**
- Modify: `src/dashboard/render/overview.ts` (legend markup: `renderTrendLegend` at line 136, call site at line 17)
- Modify: `src/dashboard/static/dashboard.css` (after line 459, the `.trend-legend-row` block)
- Modify: `src/dashboard/static/dashboard.js` (legend wiring at lines 238–250)
- Test: `tests/overview-render.test.ts` (append)

**Interfaces:**
- Consumes: `vm.otherProjects` from Task 2; `OTHER_KEY` (`'__other__'`) already imported in the render module's data counterpart — import it in `render/overview.ts` from `../lib/feature-colors.js`.
- Produces: legend DOM contract for dashboard.js — the Other row carries `data-expandable="1"` and a `.chevron` span; sub-rows are sibling `<li class="trend-legend-subrow" data-project-key="...">` elements, hidden until `#trend-legend` has the `other-expanded` class.

- [ ] **Step 1: Write the failing render tests**

Append to `tests/overview-render.test.ts` (uses the existing `makeVm` helper; `makeVm` sets `totalUsd: 67` so the standard layout renders):

```ts
describe('expandable Other legend row', () => {
  const otherVm = () =>
    makeVm({
      projects: [
        { key: 'repo:o/a', name: 'a', color: '#0072B2', totalUsd: 50, clickable: true, stackPosition: 0 },
        { key: '__other__', name: 'Other', color: '#999', totalUsd: 30, clickable: false, stackPosition: 6 },
      ],
      otherProjects: [
        { key: 'repo:o/tail1', name: 'tail1', totalUsd: 20 },
        { key: 'feature:outside:projects-root', name: 'Projects (root)', totalUsd: 10 },
      ],
    });

  test('Other row gets the expandable marker and chevron', () => {
    const html = renderOverview(otherVm());
    assert.match(html, /data-project-key="__other__"[^>]*data-expandable="1"/);
    assert.match(html, /class="chevron"/);
  });

  test('renders one clickable sub-row per tail project with amounts', () => {
    const html = renderOverview(otherVm());
    assert.match(html, /trend-legend-subrow" data-project-key="repo:o\/tail1"/);
    assert.match(html, /trend-legend-subrow" data-project-key="feature:outside:projects-root"/);
    assert.match(html, /\$20/);
    assert.match(html, /\$10/);
  });

  test('no marker or sub-rows when the tail is empty', () => {
    const vm = makeVm({
      projects: [{ key: 'repo:o/a', name: 'a', color: '#0072B2', totalUsd: 50, clickable: true, stackPosition: 0 }],
      otherProjects: [],
    });
    const html = renderOverview(vm);
    assert.doesNotMatch(html, /data-expandable/);
    assert.doesNotMatch(html, /trend-legend-subrow/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test tests/overview-render.test.ts`
Expected: FAIL — no `data-expandable` / `trend-legend-subrow` in output.

- [ ] **Step 3: Implement the renderer**

In `src/dashboard/render/overview.ts`:

(a) Add `OTHER_KEY` to the module's existing feature-colors import (line 5):

```ts
import { colorFor, STRIPED_SENTINEL, OTHER_KEY } from '../lib/feature-colors.js';
```

(b) Change the call site (line 17) to pass the tail:

```ts
          ${renderTrendLegend(vm.projects, vm.otherProjects)}
```

(c) Replace `renderTrendLegend` (line 136) with:

```ts
function renderTrendLegend(
  projects: OverviewVM['projects'],
  otherProjects: OverviewVM['otherProjects']
): string {
  // Sort descending by stackPosition: top-of-legend mirrors top-of-stack.
  // __other__ (highest stackPosition) appears first; largest real project appears last.
  const rows = [...projects].sort((a, b) => b.stackPosition - a.stackPosition);
  return rows.map((p) => {
    const clickable = p.clickable ? '1' : '0';
    const expandable = p.key === OTHER_KEY && otherProjects.length > 0;
    const row = `<li class="trend-legend-row" data-project-key="${escapeHtml(p.key)}" data-project-color="${escapeHtml(p.color)}" data-clickable="${clickable}"${expandable ? ' data-expandable="1"' : ''}>
      <span class="swatch" style="background:${escapeHtml(p.color)}"></span>
      <span class="name">${escapeHtml(p.name)}${expandable ? ' <span class="chevron">&#9656;</span>' : ''}</span>
      <span class="amt">$${p.totalUsd.toFixed(0)}</span>
    </li>`;
    if (!expandable) return row;
    // Sub-rows are flat siblings (not a nested list): the legend <ul> is a
    // flex column and each row is its own grid, so nesting would fight both.
    const subRows = otherProjects.map((o) => `<li class="trend-legend-subrow" data-project-key="${escapeHtml(o.key)}">
      <span class="name">${escapeHtml(o.name)}</span>
      <span class="amt">$${o.totalUsd.toFixed(0)}</span>
    </li>`).join('');
    return row + subRows;
  }).join('');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test tests/overview-render.test.ts`
Expected: PASS

- [ ] **Step 5: Style the sub-rows**

In `src/dashboard/static/dashboard.css`, after the `.trend-legend-row .amt` rule (line 459):

```css
.trend-legend-row .chevron { color: #8b6f47; font-size: 11px; }
.trend-legend-subrow {
  display: none;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 6px;
  padding: 2px 4px 2px 24px;   /* indent past the swatch column */
  border-radius: 4px;
  cursor: pointer;
  color: #6b563d;
}
.trend-legend.other-expanded .trend-legend-subrow { display: grid; }
.trend-legend-subrow:hover { background: rgba(139,111,71,0.08); }
.trend-legend-subrow .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.trend-legend-subrow .amt { font-variant-numeric: tabular-nums; }
```

- [ ] **Step 6: Wire the toggle in dashboard.js**

In `src/dashboard/static/dashboard.js`, inside the `if (legend) { ... }` block (lines 238–250), the existing per-row loop stays as-is; append after it, still inside the `if (legend)` block:

```js
      // Expandable Other row: toggle the tail-project sub-list.
      const otherRow = legend.querySelector('[data-expandable="1"]');
      if (otherRow) {
        otherRow.addEventListener('click', () => {
          const expanded = legend.classList.toggle('other-expanded');
          const chevron = otherRow.querySelector('.chevron');
          if (chevron) chevron.textContent = expanded ? '▾' : '▸';
        });
      }
      // Sub-rows navigate to their project page. No band highlight on hover:
      // the Other band is an aggregate — there is nothing to isolate.
      legend.querySelectorAll('.trend-legend-subrow').forEach((li) => {
        const key = li.getAttribute('data-project-key');
        if (!key) return;
        li.addEventListener('click', (ev) => {
          ev.stopPropagation();
          window.location.href = '/project/' + encodeURIComponent(key);
        });
      });
```

(The Other row has `data-clickable="0"`, so the existing click-to-navigate wiring never attaches to it — the toggle is its only click handler. Its existing mouseenter/mouseleave band highlight is untouched.)

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/dashboard/render/overview.ts src/dashboard/static/dashboard.css src/dashboard/static/dashboard.js tests/overview-render.test.ts
git commit -m "feat(dashboard): expandable Other legend row with tail projects"
```

---

### Task 5: Manual verification against the real database

Per CLAUDE.md: verify database contents / terminal output after the phase. The live DB is at `/Users/benjaminloschen/Projects/tokentrail/data/tracker.db` (the deployed checkout is `~/Projects/tokentrail`, not this repo).

- [ ] **Step 1: Rehearse the heal on a copy**

```bash
cp /Users/benjaminloschen/Projects/tokentrail/data/tracker.db /tmp/tracker-heal-test.db
TRACKER_DB_PATH=/tmp/tracker-heal-test.db npx tsx -e "
import { getDb } from './src/db/db.js';
getDb();  // runMigrations runs on open — heal fires here
"
sqlite3 /tmp/tracker-heal-test.db "SELECT DISTINCT repo FROM usage_events WHERE repo LIKE 'local/%';"
```

Expected console output: `Merged 2 local repo identities: local/mudandsilicon -> loschenbd/mudandsilicon, local/tokentrail -> loschenbd/tokentrail`
Expected query result: only `local/writing-mentor` and `local/pm-os` remain (genuinely local-only).

- [ ] **Step 2: Verify the dashboard on the healed copy**

```bash
TRACKER_DB_PATH=/tmp/tracker-heal-test.db npx tsx src/index.ts dashboard
```

Open the printed URL and check:
- mudandsilicon band ≈ $1,500 (was $916), now 4th largest.
- Other band ≈ $701 (was $1,286).
- Clicking "Other" in the legend expands sub-rows (pm-os, gemify-universal, Projects (root), …), chevron flips to ▾.
- Clicking a sub-row navigates to that project's detail page.

- [ ] **Step 3: Clean up and note anything odd**

```bash
rm /tmp/tracker-heal-test.db
```

If numbers deviate from the estimates above, investigate before applying to the live DB (the live DB heals itself on the next real startup — that is the deliverable, not a manual step).
