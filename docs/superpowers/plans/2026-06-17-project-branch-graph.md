# Project branch graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-project "Branches" section that renders the project's non-mainline git branches as bezier arcs diverging from a trunk line, with cost, session count, and lifecycle status per branch.

**Architecture:** A new SQL-only data module (`branches.ts`) produces a typed lifecycle VM from `usage_events` + `session_prs` + `feature_rollups`. The renderer emits an HTML container + a `<script type="application/json">` blob. A new vanilla-JS function in `dashboard.js` reads the JSON and draws SVG (trunk line + one cubic-bezier `<path>` per branch + circle markers + labels). Zero new deps — matches the existing trail-elevation chart pattern.

**Tech Stack:** TypeScript, better-sqlite3, Fastify, vanilla SVG/JS. No frameworks, no client build step.

**Spec:** `docs/superpowers/specs/2026-06-17-project-branch-graph-design.md`

**Worktree:** `.worktrees/project-branch-graph` on branch `feat/project-branch-graph`. Branched from master at `36fff8c` (spec commit).

**Baseline tests:** 92/93 passing on master. The single pre-existing failure in `tests/overview-render.test.ts` (`No trail yet` copy from the parallel trail-map work) is unrelated and gates only on "no new failures."

---

## File Structure

- `src/dashboard/data/branches.ts` — **NEW** (~120 lines). Exports `buildBranchGraph(db, { projectKey, days })` + the `BranchLifecycle` / `BranchGraphVM` types. One responsibility: pull lifecycle records from SQL and assemble the VM.
- `tests/branches.test.ts` — **NEW** (~250 lines). 10 focused tests on lifecycle classification, cost rollup, mainline exclusion, PR matching, window filter, featureKey lookup, empty case.
- `src/dashboard/data/project.ts` — **MODIFY**. Add `branchGraph: BranchGraphVM | null` to `ProjectDetailVM`, call `buildBranchGraph()` in `buildProjectDetail()`.
- `src/dashboard/render/project.ts` — **MODIFY**. Render the "Branches" section (HTML container + JSON `<script>` blob) between the trail-elevation card and the features card.
- `src/dashboard/static/dashboard.js` — **MODIFY**. Add `renderBranchGraph()` function. Wire into the existing `DOMContentLoaded` handler.
- `src/dashboard/static/dashboard.css` — **MODIFY**. Add `.branch-graph*` styles (~40 lines).

---

## Important schema facts (read before Task 1)

These differ from common assumptions and the spec abbreviates them — the plan uses the real names:

- `session_prs.head_branch` is the branch column (NOT `branch`). PRs link to a branch via `(repo, head_branch)`.
- `usage_events.branch` is the SOURCE OF TRUTH for cost-per-branch. Clean, direct cost attribution.
- `session_commits.branch` is dirty (sometimes `"origin/foo, foo"` CSV junk). **Do NOT consult it.**
- `feature_rollups.branches` is a comma-joined string. Search by substring with comma sentinels (see Task 4).
- CSS variable names are `--color-ink`, `--color-ink-muted`, `--color-ink-subtle`, `--color-accent-green`, `--color-accent-bar`. The spec uses abbreviated names — the plan uses the real ones.
- The existing trail-elevation chart in `dashboard.js:96-249` is the gold-standard pattern. Read it before Task 8.
- `niceTimeTicks(minMs, maxMs, n)` and `fmtTickDate(ms)` are already defined in `dashboard.js:262-281` — reuse, don't duplicate.

---

## Task 1: Data module skeleton — types, empty case, lifecycle queries

**Files:**
- Create: `src/dashboard/data/branches.ts`
- Create: `tests/branches.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/branches.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildBranchGraph } from '../src/dashboard/data/branches.js';

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function insertEvent(db: Database.Database, opts: {
  id: string; sessionId: string; timestamp: string;
  repo: string | null; branch: string | null; cost?: number;
}) {
  db.prepare(
    `INSERT INTO usage_events
       (id, session_id, timestamp, repo, branch, model, estimated_cost_usd)
     VALUES (?, ?, ?, ?, ?, 'opus', ?)`
  ).run(opts.id, opts.sessionId, opts.timestamp, opts.repo, opts.branch, opts.cost ?? 0);
}

describe('buildBranchGraph — skeleton', () => {
  test('returns null when no events for the project at all', () => {
    const db = makeDb();
    const r = buildBranchGraph(db, { projectKey: 'repo:owner/empty', days: 30 });
    assert.equal(r, null);
  });

  test('returns null when only mainline branches exist (no feature branches)', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'master', cost: 5 });
    insertEvent(db, { id: 'e2', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'main', cost: 3 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 });
    assert.equal(r, null);
  });

  test('lifecycle reflects MIN and MAX timestamps for each non-mainline branch', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-10T10:00:00Z', repo: 'o/r', branch: 'feat/x', cost: 5 });
    insertEvent(db, { id: 'e2', sessionId: 's1', timestamp: '2026-06-14T11:00:00Z', repo: 'o/r', branch: 'feat/x', cost: 3 });
    insertEvent(db, { id: 'e3', sessionId: 's1', timestamp: '2026-06-12T08:00:00Z', repo: 'o/r', branch: 'feat/x', cost: 2 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.branches.length, 1);
    const b = r.branches[0]!;
    assert.equal(b.branch, 'feat/x');
    assert.equal(b.firstEventAt, '2026-06-10T10:00:00Z');
    assert.equal(b.lastEventAt, '2026-06-14T11:00:00Z');
  });

  test('mainline trunk detected — picks the branch with most events among master/main/trunk', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'main', cost: 1 });
    insertEvent(db, { id: 'e2', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'main', cost: 1 });
    insertEvent(db, { id: 'e3', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'master', cost: 1 });
    insertEvent(db, { id: 'e4', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 1 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.trunk, 'main');  // 2 events on main vs 1 on master
  });

  test('branches sorted by firstEventAt ascending', () => {
    const db = makeDb();
    insertEvent(db, { id: 'a', sessionId: 's1', timestamp: '2026-06-15T00:00:00Z', repo: 'o/r', branch: 'feat/b', cost: 1 });
    insertEvent(db, { id: 'b', sessionId: 's2', timestamp: '2026-06-10T00:00:00Z', repo: 'o/r', branch: 'feat/a', cost: 1 });
    insertEvent(db, { id: 'c', sessionId: 's3', timestamp: '2026-06-12T00:00:00Z', repo: 'o/r', branch: 'feat/c', cost: 1 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.deepEqual(r.branches.map((b) => b.branch), ['feat/a', 'feat/c', 'feat/b']);
  });
});

function nowIso(): string {
  return new Date().toISOString();
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test tests/branches.test.ts 2>&1 | tail -20`
Expected: 5 failures, all "Cannot find module '../src/dashboard/data/branches.js'"

- [ ] **Step 3: Create the data module**

```ts
// src/dashboard/data/branches.ts
import type DatabaseType from 'better-sqlite3';

export type BranchLifecycle = {
  branch: string;
  firstEventAt: string;
  lastEventAt: string;
  mergedAt: string | null;
  status: 'merged' | 'open' | 'stale';
  totalUsd: number;
  sessionCount: number;
  prNumber: number | null;
  prUrl: string | null;
  featureKey: string | null;
};

export type BranchGraphVM = {
  trunk: string;
  windowStart: string;
  windowEnd: string;
  branches: BranchLifecycle[];
  totalBranches: number;
  totalUsd: number;
};

const MAINLINE = new Set(['master', 'main', 'trunk']);

// Parses repo: / local: / feature: project keys. Returns null for feature:
// projects since branch lifecycle is a per-repo concept; feature-bucket
// projects have no repo and therefore no branch graph.
function parseRepoFromProjectKey(projectKey: string): string | null {
  if (projectKey.startsWith('repo:')) return projectKey.slice(5);
  if (projectKey.startsWith('local:')) return 'local/' + projectKey.slice(6);
  return null;
}

export function buildBranchGraph(
  db: DatabaseType.Database,
  opts: { projectKey: string; days: number }
): BranchGraphVM | null {
  const repo = parseRepoFromProjectKey(opts.projectKey);
  if (!repo) return null;

  const days = Math.max(1, opts.days);
  const windowStart = (db
    .prepare(`SELECT date('now', '-${days - 1} days', 'localtime') AS d`)
    .get() as { d: string }).d;
  const windowEnd = (db
    .prepare(`SELECT date('now', 'localtime') AS d`)
    .get() as { d: string }).d;

  // Detect trunk: among master/main/trunk, pick whichever has the most
  // events for this repo. Default master if none seen.
  const trunkRow = db
    .prepare(
      `SELECT branch, COUNT(*) AS n FROM usage_events
        WHERE repo = ? AND branch IN ('master','main','trunk')
        GROUP BY branch ORDER BY n DESC LIMIT 1`
    )
    .get(repo) as { branch: string; n: number } | undefined;
  const trunk = trunkRow?.branch ?? 'master';

  // Per-branch lifecycle aggregate from usage_events. lastEventAt filter
  // implements the window: branches with no recent activity drop out.
  const rows = db
    .prepare(
      `SELECT branch,
              MIN(timestamp) AS firstEventAt,
              MAX(timestamp) AS lastEventAt
         FROM usage_events
        WHERE repo = ?
          AND branch IS NOT NULL
          AND branch != ''
          AND branch NOT IN ('master','main','trunk')
          AND date(timestamp, 'localtime') >= ?
        GROUP BY branch
        ORDER BY firstEventAt ASC`
    )
    .all(repo, windowStart) as Array<{
      branch: string;
      firstEventAt: string;
      lastEventAt: string;
    }>;

  if (rows.length === 0) return null;

  // Stub remaining fields — later tasks populate PR data, status,
  // featureKey, cost rollup, and session count.
  const branches: BranchLifecycle[] = rows.map((r) => ({
    branch: r.branch,
    firstEventAt: r.firstEventAt,
    lastEventAt: r.lastEventAt,
    mergedAt: null,
    status: 'open' as const,
    totalUsd: 0,
    sessionCount: 0,
    prNumber: null,
    prUrl: null,
    featureKey: null,
  }));

  return {
    trunk,
    windowStart,
    windowEnd,
    branches,
    totalBranches: branches.length,
    totalUsd: 0,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test tests/branches.test.ts 2>&1 | tail -20`
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/data/branches.ts tests/branches.test.ts
git commit -m "feat(branches): data module skeleton + lifecycle queries"
```

---

## Task 2: PR matching — mergedAt, status='merged', prNumber, prUrl

**Files:**
- Modify: `src/dashboard/data/branches.ts`
- Test: `tests/branches.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/branches.test.ts`:

```ts
function insertPr(db: Database.Database, opts: {
  sessionId: string; repo: string; prNumber: number;
  headBranch: string; state?: string; mergedAt?: string | null;
  url?: string | null; title?: string | null;
}) {
  db.prepare(
    `INSERT INTO session_prs
       (session_id, repo, pr_number, pr_title, pr_url, pr_state, head_branch, merged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.sessionId, opts.repo, opts.prNumber,
    opts.title ?? null,
    opts.url ?? `https://github.com/${opts.repo}/pull/${opts.prNumber}`,
    opts.state ?? 'merged',
    opts.headBranch,
    opts.mergedAt ?? null,
  );
}

describe('buildBranchGraph — PR matching', () => {
  test('merged PR populates mergedAt, prNumber, prUrl, status=merged', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-10T10:00:00Z', repo: 'o/r', branch: 'feat/x', cost: 5 });
    insertPr(db, { sessionId: 's1', repo: 'o/r', prNumber: 42, headBranch: 'feat/x', state: 'merged', mergedAt: '2026-06-14T12:00:00Z' });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    const b = r.branches.find((x) => x.branch === 'feat/x')!;
    assert.equal(b.status, 'merged');
    assert.equal(b.mergedAt, '2026-06-14T12:00:00Z');
    assert.equal(b.prNumber, 42);
    assert.equal(b.prUrl, 'https://github.com/o/r/pull/42');
  });

  test('PR with origin/ prefix on head_branch matches a usage_event branch without the prefix', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-10T10:00:00Z', repo: 'o/r', branch: 'feat/y', cost: 5 });
    insertPr(db, { sessionId: 's1', repo: 'o/r', prNumber: 7, headBranch: 'origin/feat/y', state: 'merged', mergedAt: '2026-06-14T00:00:00Z' });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    const b = r.branches.find((x) => x.branch === 'feat/y')!;
    assert.equal(b.status, 'merged');
    assert.equal(b.mergedAt, '2026-06-14T00:00:00Z');
  });

  test('open PR (pr_state != merged) does NOT set mergedAt', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: '2026-06-10T10:00:00Z', repo: 'o/r', branch: 'feat/z', cost: 5 });
    insertPr(db, { sessionId: 's1', repo: 'o/r', prNumber: 9, headBranch: 'feat/z', state: 'open', mergedAt: null });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    const b = r.branches.find((x) => x.branch === 'feat/z')!;
    assert.equal(b.mergedAt, null);
    assert.notEqual(b.status, 'merged');
    // prNumber/prUrl still populated — useful for the click-through.
    assert.equal(b.prNumber, 9);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test tests/branches.test.ts 2>&1 | tail -20`
Expected: 3 new failures (status='merged' not set, mergedAt null).

- [ ] **Step 3: Add PR matching to the data module**

Replace the `branches: BranchLifecycle[] = rows.map(...)` block in `src/dashboard/data/branches.ts` with:

```ts
  // PR matching: for each unique branch, find a matching session_prs row
  // by (repo, head_branch). Tolerate 'origin/' prefix on either side.
  // Prefer merged PRs; if multiple match, the lowest pr_number wins.
  const branchNames = rows.map((r) => r.branch);
  const prRows = branchNames.length === 0
    ? []
    : db
      .prepare(
        `SELECT pr.repo, pr.pr_number AS prNumber, pr.pr_url AS prUrl,
                pr.pr_state AS prState, pr.head_branch AS headBranch,
                pr.merged_at AS mergedAt
           FROM session_prs pr
          WHERE pr.repo = ?
            AND (pr.head_branch IN (SELECT value FROM json_each(?))
                 OR pr.head_branch IN (SELECT 'origin/' || value FROM json_each(?))
                 OR REPLACE(pr.head_branch, 'origin/', '') IN (SELECT value FROM json_each(?)))`
      )
      .all(
        repo,
        JSON.stringify(branchNames),
        JSON.stringify(branchNames),
        JSON.stringify(branchNames),
      ) as Array<{
        repo: string;
        prNumber: number;
        prUrl: string | null;
        prState: string | null;
        headBranch: string;
        mergedAt: string | null;
      }>;

  // Index PRs by the normalized branch name (strip origin/).
  type PrMatch = { prNumber: number; prUrl: string | null; mergedAt: string | null };
  const prByBranch = new Map<string, PrMatch>();
  for (const pr of prRows) {
    const key = pr.headBranch.replace(/^origin\//, '');
    const isMerged = pr.prState === 'merged' && pr.mergedAt !== null;
    const existing = prByBranch.get(key);
    // Prefer merged PRs over open; among same status, prefer lower pr_number.
    if (!existing) {
      prByBranch.set(key, { prNumber: pr.prNumber, prUrl: pr.prUrl, mergedAt: isMerged ? pr.mergedAt : null });
      continue;
    }
    const existingMerged = existing.mergedAt !== null;
    if (isMerged && !existingMerged) {
      prByBranch.set(key, { prNumber: pr.prNumber, prUrl: pr.prUrl, mergedAt: pr.mergedAt });
    } else if (isMerged === existingMerged && pr.prNumber < existing.prNumber) {
      prByBranch.set(key, { prNumber: pr.prNumber, prUrl: pr.prUrl, mergedAt: isMerged ? pr.mergedAt : null });
    }
  }

  const branches: BranchLifecycle[] = rows.map((r) => {
    const pr = prByBranch.get(r.branch);
    const mergedAt = pr?.mergedAt ?? null;
    return {
      branch: r.branch,
      firstEventAt: r.firstEventAt,
      lastEventAt: r.lastEventAt,
      mergedAt,
      status: (mergedAt !== null ? 'merged' : 'open') as 'merged' | 'open' | 'stale',
      totalUsd: 0,
      sessionCount: 0,
      prNumber: pr?.prNumber ?? null,
      prUrl: pr?.prUrl ?? null,
      featureKey: null,
    };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test tests/branches.test.ts 2>&1 | tail -20`
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/data/branches.ts tests/branches.test.ts
git commit -m "feat(branches): PR matching for mergedAt + status=merged"
```

---

## Task 3: Stale vs open classification + cost rollup + session count

**Files:**
- Modify: `src/dashboard/data/branches.ts`
- Test: `tests/branches.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/branches.test.ts`:

```ts
describe('buildBranchGraph — status, cost, session count', () => {
  test('open status when no merge and lastEvent is within 7 days', () => {
    const db = makeDb();
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: twoDaysAgo, repo: 'o/r', branch: 'feat/recent', cost: 5 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.branches[0]!.status, 'open');
  });

  test('stale status when no merge and lastEvent is older than 7 days', () => {
    const db = makeDb();
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: tenDaysAgo, repo: 'o/r', branch: 'feat/old', cost: 5 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.branches[0]!.status, 'stale');
  });

  test('totalUsd sums all events on the branch', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 5.50 });
    insertEvent(db, { id: 'e2', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 3.25 });
    insertEvent(db, { id: 'e3', sessionId: 's2', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 1.00 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.branches[0]!.totalUsd, 9.75);
  });

  test('sessionCount is distinct count of session_ids on the branch', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 1 });
    insertEvent(db, { id: 'e2', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 1 });
    insertEvent(db, { id: 'e3', sessionId: 's2', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 1 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.branches[0]!.sessionCount, 2);
  });

  test('totalUsd at the graph level sums all branches (including stub trunk cost = 0 for now)', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/a', cost: 10 });
    insertEvent(db, { id: 'e2', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/b', cost: 7 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.totalUsd, 17);
    assert.equal(r.totalBranches, 2);
  });

  test('window filter excludes events older than days window', () => {
    const db = makeDb();
    const oldTimestamp = new Date(Date.now() - 60 * 86400000).toISOString();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: oldTimestamp, repo: 'o/r', branch: 'feat/ancient', cost: 5 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 });
    assert.equal(r, null);  // no branches in window -> null
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test tests/branches.test.ts 2>&1 | tail -20`
Expected: 5 new failures (status stays 'open' always, totalUsd/sessionCount stay 0). The window-filter test should already pass from Task 1.

- [ ] **Step 3: Add cost/session/status classification**

In `src/dashboard/data/branches.ts`, replace the `const branches: BranchLifecycle[] = rows.map(...)` block with:

```ts
  // Cost + session aggregates per branch, single query for all branches.
  const aggRows = branchNames.length === 0
    ? []
    : db
      .prepare(
        `SELECT branch,
                ROUND(SUM(estimated_cost_usd), 2) AS totalUsd,
                COUNT(DISTINCT session_id) AS sessionCount
           FROM usage_events
          WHERE repo = ?
            AND branch IN (SELECT value FROM json_each(?))
          GROUP BY branch`
      )
      .all(repo, JSON.stringify(branchNames)) as Array<{
        branch: string;
        totalUsd: number;
        sessionCount: number;
      }>;
  const aggByBranch = new Map(aggRows.map((r) => [r.branch, r]));

  const STALE_THRESHOLD_MS = 7 * 86400000;
  const now = Date.now();

  const branches: BranchLifecycle[] = rows.map((r) => {
    const pr = prByBranch.get(r.branch);
    const mergedAt = pr?.mergedAt ?? null;
    const agg = aggByBranch.get(r.branch);
    const ageMs = now - new Date(r.lastEventAt).getTime();
    let status: 'merged' | 'open' | 'stale';
    if (mergedAt !== null) status = 'merged';
    else if (ageMs > STALE_THRESHOLD_MS) status = 'stale';
    else status = 'open';
    return {
      branch: r.branch,
      firstEventAt: r.firstEventAt,
      lastEventAt: r.lastEventAt,
      mergedAt,
      status,
      totalUsd: agg?.totalUsd ?? 0,
      sessionCount: agg?.sessionCount ?? 0,
      prNumber: pr?.prNumber ?? null,
      prUrl: pr?.prUrl ?? null,
      featureKey: null,
    };
  });

  const totalUsd = Math.round(branches.reduce((sum, b) => sum + b.totalUsd, 0) * 100) / 100;
```

And update the return to use `totalUsd`:

```ts
  return {
    trunk,
    windowStart,
    windowEnd,
    branches,
    totalBranches: branches.length,
    totalUsd,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test tests/branches.test.ts 2>&1 | tail -20`
Expected: all 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/data/branches.ts tests/branches.test.ts
git commit -m "feat(branches): cost rollup, session count, stale/open classification"
```

---

## Task 4: featureKey lookup from feature_rollups

**Files:**
- Modify: `src/dashboard/data/branches.ts`
- Test: `tests/branches.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/branches.test.ts`:

```ts
function insertRollup(db: Database.Database, opts: {
  date: string; featureKey: string; repo: string | null;
  branches: string;  // comma-joined
  cost?: number; sessions?: number; sessionIds?: string;
}) {
  db.prepare(
    `INSERT INTO feature_rollups
       (id, date, feature_key, feature_name, repo, branches,
        total_input_tokens, total_output_tokens, total_cost_usd,
        sessions_count, session_ids)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
  ).run(
    `${opts.date}::${opts.featureKey}`,
    opts.date, opts.featureKey, opts.featureKey, opts.repo,
    opts.branches, opts.cost ?? 1, opts.sessions ?? 1, opts.sessionIds ?? 's1',
  );
}

describe('buildBranchGraph — featureKey lookup', () => {
  test('featureKey populated when feature_rollups.branches contains the branch', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 5 });
    insertRollup(db, {
      date: todayLocal(db), featureKey: 'feat-x', repo: 'o/r',
      branches: 'feat/x,origin/feat/x',
    });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.branches[0]!.featureKey, 'feat-x');
  });

  test('featureKey is null when no feature_rollups row contains the branch', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/orphan', cost: 5 });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.branches[0]!.featureKey, null);
  });

  test('substring match on branches CSV does not produce false positives (comma sentinels)', () => {
    const db = makeDb();
    insertEvent(db, { id: 'e1', sessionId: 's1', timestamp: nowIso(), repo: 'o/r', branch: 'feat/x', cost: 5 });
    // Different feature whose branches list contains a SUBSTRING of 'feat/x'.
    insertRollup(db, {
      date: todayLocal(db), featureKey: 'feat-xy', repo: 'o/r',
      branches: 'feat/xy-but-not-feat/x',
    });
    const r = buildBranchGraph(db, { projectKey: 'repo:o/r', days: 30 })!;
    assert.equal(r.branches[0]!.featureKey, null);
  });
});

function todayLocal(db: Database.Database): string {
  return (db.prepare(`SELECT date('now', 'localtime') AS d`).get() as { d: string }).d;
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test tests/branches.test.ts 2>&1 | tail -20`
Expected: 1 new failure (first test — featureKey stays null even when a matching rollup exists).
The other 2 tests pass already because the current code returns null.

- [ ] **Step 3: Add featureKey lookup**

In `src/dashboard/data/branches.ts`, add this block BEFORE the `const branches: BranchLifecycle[] = rows.map(...)` line:

```ts
  // featureKey lookup: scan feature_rollups in the same window for rows
  // whose `branches` CSV contains any of our branch names. Use comma
  // sentinels to avoid substring false positives (e.g. 'feat/x' should
  // NOT match a CSV containing 'feat/xy').
  const featureKeyByBranch = new Map<string, string>();
  if (branchNames.length > 0) {
    const fkRows = db
      .prepare(
        `SELECT feature_key AS featureKey, branches
           FROM feature_rollups
          WHERE repo = ? AND date >= ?`
      )
      .all(repo, windowStart) as Array<{ featureKey: string; branches: string | null }>;
    for (const row of fkRows) {
      if (!row.branches) continue;
      const sentinel = ',' + row.branches + ',';
      for (const name of branchNames) {
        if (featureKeyByBranch.has(name)) continue;
        if (sentinel.includes(',' + name + ',')) {
          featureKeyByBranch.set(name, row.featureKey);
        }
      }
    }
  }
```

Then update the `branches: BranchLifecycle[] = rows.map(...)` to use it:

```ts
      featureKey: featureKeyByBranch.get(r.branch) ?? null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test tests/branches.test.ts 2>&1 | tail -20`
Expected: all 16 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/data/branches.ts tests/branches.test.ts
git commit -m "feat(branches): featureKey lookup from feature_rollups CSV"
```

---

## Task 5: Wire `branchGraph` into `ProjectDetailVM`

**Files:**
- Modify: `src/dashboard/data/project.ts`

- [ ] **Step 1: Add `branchGraph` field to the VM type and call `buildBranchGraph`**

In `src/dashboard/data/project.ts`:

1. Add the import at the top, after the existing import:

```ts
import { buildBranchGraph, type BranchGraphVM } from './branches.js';
```

2. Add `branchGraph` to `ProjectDetailVM` (after `anomalies`):

```ts
  branchGraph: BranchGraphVM | null;
```

3. At the end of `buildProjectDetail`, just before the `return` statement, call:

```ts
  const branchGraph = buildBranchGraph(db, { projectKey: opts.projectKey, days });
```

4. Add `branchGraph` to the returned object:

```ts
  return {
    // ... existing fields
    anomalies,
    branchGraph,
  };
```

- [ ] **Step 2: Run the project tests to verify no regression**

Run: `node --import tsx --test tests/project.test.ts 2>&1 | tail -10` (if a project test file exists; otherwise: `npm test 2>&1 | grep "fail" | head -10` to confirm only the pre-existing overview-render failure)
Expected: no new failures beyond baseline.

- [ ] **Step 3: Verify TypeScript builds**

Run: `npm run build 2>&1 | tail -5`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/data/project.ts
git commit -m "feat(branches): expose branchGraph on ProjectDetailVM"
```

---

## Task 6: Render the "Branches" section HTML + JSON blob

**Files:**
- Modify: `src/dashboard/render/project.ts`

- [ ] **Step 1: Add the branch-graph card to `renderProject`**

In `src/dashboard/render/project.ts`, between the trail-elevation card (lines 14-23) and the features card (line 25-28), insert:

```ts
  ${vm.branchGraph === null ? '' : `
  <div class="card chart-card">
    <div class="label">Branches · last ${getWindowDays(vm)}d · ${vm.branchGraph.totalBranches} branch${vm.branchGraph.totalBranches === 1 ? '' : 'es'} · $${vm.branchGraph.totalUsd.toFixed(0)} total</div>
    <div id="branch-graph" data-branch-graph style="width:100%;min-height:120px"></div>
    <script type="application/json" id="branch-graph-data">${jsonForScriptTag(vm.branchGraph)}</script>
  </div>`}
```

The `getWindowDays(vm)` helper computes the day count from the window dates — add it as a private helper at the bottom of the file:

```ts
function getWindowDays(vm: ProjectDetailVM): number {
  if (!vm.branchGraph) return 30;
  const start = new Date(vm.branchGraph.windowStart + 'T00:00:00').getTime();
  const end = new Date(vm.branchGraph.windowEnd + 'T00:00:00').getTime();
  return Math.round((end - start) / 86400000) + 1;
}
```

- [ ] **Step 2: Manually verify the page renders without errors**

Start the dashboard from the worktree, then curl the project page:

```bash
npm run dev -- dashboard --no-open 2>&1 &
sleep 2
curl -s http://127.0.0.1:4920/project/repo%3Aloschenbd%2Ftokentrail | grep -A 2 "branch-graph"
```

Expected: HTML output containing a `<div id="branch-graph"` element and a `<script type="application/json" id="branch-graph-data">` blob with JSON.

Kill the dev server: `pkill -f "tsx src/index.ts" 2>/dev/null || true`

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/render/project.ts
git commit -m "feat(branches): render branch-graph card on project page"
```

---

## Task 7: CSS for `.branch-graph*`

**Files:**
- Modify: `src/dashboard/static/dashboard.css`

- [ ] **Step 1: Append the branch-graph styles**

Append to `src/dashboard/static/dashboard.css` (after the existing `.trail-marker:hover` block at ~line 339):

```css
/* Branch graph — bezier-arc lifecycle visualization per project */
.branch-graph { display: block; font-family: var(--font-sans); }
.branch-graph-trunk {
  fill: none;
  stroke: var(--color-ink);
  stroke-width: 2;
  shape-rendering: crispEdges;
}
.branch-graph-grid {
  stroke: rgba(139,111,71,0.15);
  stroke-width: 1;
  stroke-dasharray: 2 3;
  shape-rendering: crispEdges;
}
.branch-graph-axis-label {
  fill: var(--color-ink-muted);
  font-size: var(--size-small);
  font-family: var(--font-mono);
}
.branch-graph-arc {
  fill: none;
  stroke-width: 1.5;
  cursor: pointer;
  transition: stroke-width 120ms ease-out;
}
.branch-graph-arc:hover { stroke-width: 2.5; }
.branch-graph-arc.merged { stroke: var(--color-ink-muted); }
.branch-graph-arc.open   { stroke: var(--color-accent-green); stroke-width: 2; }
.branch-graph-arc.stale  { stroke: var(--color-ink-subtle); }
.branch-graph-marker {
  stroke: var(--color-parchment-top, #f8f3e7);
  stroke-width: 2;
}
.branch-graph-marker.merged { fill: var(--color-ink-muted); }
.branch-graph-marker.open   { fill: var(--color-accent-green); }
.branch-graph-marker.stale  { fill: var(--color-ink-subtle); }
.branch-graph-marker.open-end { fill: var(--color-parchment-top, #f8f3e7); stroke: var(--color-accent-green); stroke-width: 2; }
.branch-graph-marker.stale-end { fill: var(--color-parchment-top, #f8f3e7); stroke: var(--color-ink-subtle); stroke-width: 2; }
.branch-graph-label {
  fill: var(--color-ink);
  font-size: var(--size-small);
  font-family: var(--font-sans);
  pointer-events: none;
}
.branch-graph-label.muted { fill: var(--color-ink-muted); }
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/static/dashboard.css
git commit -m "feat(branches): styles for branch-graph arcs, markers, labels"
```

---

## Task 8: `renderBranchGraph()` — SVG drawing in `dashboard.js`

**Files:**
- Modify: `src/dashboard/static/dashboard.js`

- [ ] **Step 1: Add `renderBranchGraph` function**

In `src/dashboard/static/dashboard.js`, insert this function BEFORE the `function niceTicks(...)` definition at ~line 251:

```js
  function renderBranchGraph() {
    const node = document.getElementById('branch-graph');
    const dataNode = document.getElementById('branch-graph-data');
    if (!node || !dataNode) return;
    let vm;
    try { vm = JSON.parse(dataNode.textContent || 'null'); } catch (e) { return; }
    if (!vm || !Array.isArray(vm.branches) || vm.branches.length === 0) return;

    const branches = vm.branches.slice();
    // Sort by firstEventAt ascending — earliest branches stack at the top.
    branches.sort(function (a, b) {
      return a.firstEventAt < b.firstEventAt ? -1 : a.firstEventAt > b.firstEventAt ? 1 : 0;
    });

    // Vertical layout: 0-24 date axis, 24-48 title row, 48 = trunk Y,
    // then 36px per lane.
    const TRUNK_Y = 48;
    const LANE_HEIGHT = 36;
    const W = node.clientWidth || 800;
    const H = TRUNK_Y + branches.length * LANE_HEIGHT + 16;
    const pad = { l: 40, r: 40 };

    const windowStartMs = new Date(vm.windowStart + 'T00:00:00').getTime();
    const windowEndMs = new Date(vm.windowEnd + 'T23:59:59').getTime();

    function xAt(iso) {
      const t = new Date(iso).getTime();
      const clamped = Math.max(windowStartMs, Math.min(windowEndMs, t));
      const span = windowEndMs - windowStartMs;
      if (span <= 0) return pad.l + (W - pad.l - pad.r) / 2;
      return pad.l + ((clamped - windowStartMs) / span) * (W - pad.l - pad.r);
    }

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', H);
    svg.setAttribute('class', 'branch-graph');

    // Date axis ticks (above the trunk line).
    const xTicks = niceTimeTicks(windowStartMs, windowEndMs, 6);
    for (let i = 0; i < xTicks.length; i++) {
      const tx = xAt(new Date(xTicks[i]).toISOString());
      const tickLabel = document.createElementNS(ns, 'text');
      tickLabel.setAttribute('x', tx);
      tickLabel.setAttribute('y', 18);
      tickLabel.setAttribute('class', 'branch-graph-axis-label');
      tickLabel.setAttribute('text-anchor', 'middle');
      tickLabel.textContent = fmtTickDate(xTicks[i]);
      svg.appendChild(tickLabel);

      const grid = document.createElementNS(ns, 'line');
      grid.setAttribute('x1', tx); grid.setAttribute('x2', tx);
      grid.setAttribute('y1', TRUNK_Y); grid.setAttribute('y2', H - 4);
      grid.setAttribute('class', 'branch-graph-grid');
      svg.appendChild(grid);
    }

    // Trunk line.
    const trunkLine = document.createElementNS(ns, 'line');
    trunkLine.setAttribute('x1', pad.l); trunkLine.setAttribute('x2', W - pad.r);
    trunkLine.setAttribute('y1', TRUNK_Y); trunkLine.setAttribute('y2', TRUNK_Y);
    trunkLine.setAttribute('class', 'branch-graph-trunk');
    svg.appendChild(trunkLine);

    // One row per branch.
    for (let i = 0; i < branches.length; i++) {
      const b = branches[i];
      const laneY = TRUNK_Y + (i + 1) * LANE_HEIGHT;
      const x1 = xAt(b.firstEventAt);
      const endIso = b.mergedAt || b.lastEventAt;
      const x2 = xAt(endIso);
      const span = Math.max(20, x2 - x1);
      const cp = Math.min(40, span * 0.25);  // bezier handle offset
      const flatInset = Math.min(20, span * 0.15);

      const d =
        'M ' + x1 + ',' + TRUNK_Y +
        ' C ' + (x1 + cp) + ',' + TRUNK_Y + ' ' + (x1 + cp) + ',' + laneY + ' ' + (x1 + flatInset) + ',' + laneY +
        ' L ' + (x2 - flatInset) + ',' + laneY +
        ' C ' + (x2 - cp) + ',' + laneY + ' ' + (x2 - cp) + ',' + TRUNK_Y + ' ' + x2 + ',' + TRUNK_Y;

      const arc = document.createElementNS(ns, 'path');
      arc.setAttribute('d', d);
      arc.setAttribute('class', 'branch-graph-arc ' + b.status);
      arc.setAttribute('data-branch', b.branch);
      svg.appendChild(arc);

      // Click handler — featureKey wins, then prUrl, else no-op.
      const target = b.featureKey
        ? '/feature/' + encodeURIComponent(b.featureKey)
        : (b.prUrl || null);
      if (target) {
        arc.style.cursor = 'pointer';
        arc.addEventListener('click', function () {
          if (b.featureKey) window.location.href = target;
          else window.open(target, '_blank', 'noopener');
        });
      } else {
        arc.style.cursor = 'default';
      }

      // Start marker. If the branch pre-dates the window (firstEventAt is
      // before windowStart), draw an inward « chevron at the clamped x1
      // instead of a closed circle — communicates "this branch existed
      // before the window starts."
      const preDates = new Date(b.firstEventAt).getTime() < windowStartMs;
      if (preDates) {
        const chevron = document.createElementNS(ns, 'text');
        chevron.setAttribute('x', x1 - 2);
        chevron.setAttribute('y', TRUNK_Y + 4);
        chevron.setAttribute('text-anchor', 'middle');
        chevron.setAttribute('class', 'branch-graph-axis-label');
        chevron.textContent = '«';
        svg.appendChild(chevron);
      } else {
        const startMarker = document.createElementNS(ns, 'circle');
        startMarker.setAttribute('cx', x1); startMarker.setAttribute('cy', TRUNK_Y);
        startMarker.setAttribute('r', 4);
        startMarker.setAttribute('class', 'branch-graph-marker ' + b.status);
        svg.appendChild(startMarker);
      }

      // End marker: closed circle if merged, open circle if open/stale.
      const endMarker = document.createElementNS(ns, 'circle');
      endMarker.setAttribute('cx', x2); endMarker.setAttribute('cy', TRUNK_Y);
      endMarker.setAttribute('r', 4);
      const endClass = b.status === 'merged'
        ? 'branch-graph-marker merged'
        : (b.status === 'open' ? 'branch-graph-marker open-end' : 'branch-graph-marker stale-end');
      endMarker.setAttribute('class', endClass);
      svg.appendChild(endMarker);

      // Label — placed at the lane midpoint, truncated if too long.
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', (x1 + x2) / 2);
      label.setAttribute('y', laneY + 4);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'branch-graph-label');
      const statusText = b.status === 'merged' && b.mergedAt
        ? 'merged ' + fmtTickDate(new Date(b.mergedAt).getTime())
        : b.status;
      const raw = b.branch + '  $' + Math.round(b.totalUsd) + ' · ' + b.sessionCount + ' ' + (b.sessionCount === 1 ? 'session' : 'sessions') + ' · ' + statusText;
      label.textContent = truncate(raw, 56);
      const tooltip = document.createElementNS(ns, 'title');
      tooltip.textContent = b.branch + ' — $' + b.totalUsd.toFixed(2) + ' · ' + b.sessionCount + ' sessions · ' + b.status;
      label.appendChild(tooltip);
      svg.appendChild(label);
    }

    node.innerHTML = '';
    node.appendChild(svg);
  }

  function truncate(s, n) {
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
  }
```

- [ ] **Step 2: Wire `renderBranchGraph()` into the init handler**

Find the existing `DOMContentLoaded` listener at ~line 310:

```js
  document.addEventListener('DOMContentLoaded', () => {
    renderTrend();
    renderTrailElevation();
    setupRowExpanders();
    setupClusterJumps();
  });
```

Add `renderBranchGraph();` after `renderTrailElevation();`:

```js
  document.addEventListener('DOMContentLoaded', () => {
    renderTrend();
    renderTrailElevation();
    renderBranchGraph();
    setupRowExpanders();
    setupClusterJumps();
  });
```

- [ ] **Step 3: Verify TypeScript still builds (the JS file isn't typechecked, but project.ts wiring is)**

Run: `npm run build 2>&1 | tail -5`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/static/dashboard.js
git commit -m "feat(branches): SVG rendering of branch arcs in dashboard.js"
```

---

## Task 9: Manual verification + polish iteration

**Files:** any of the above as needed for polish

- [ ] **Step 1: Start the dashboard from the worktree**

```bash
npm run dev -- dashboard --no-open 2>&1 &
sleep 3
```

- [ ] **Step 2: Open the tokentrail project page in a browser**

URL: `http://127.0.0.1:4920/project/repo%3Aloschenbd%2Ftokentrail`

Visually verify the checklist from the spec's "Manual verification" section:

1. **Section renders** below the trail-elevation card, above the features card.
2. **Trunk line** spans the chart width.
3. Each non-mainline branch with recent activity has an **arc**.
4. **Merged branches** show closed-circle markers; **open branches** show open-circle markers.
5. **Labels** are readable — no overlap, ellipsis works on long names.
6. **Click a branch arc**: navigates to its feature page (when matched), opens its PR (when matched), or does nothing (when neither).
7. **Empty case**: visit a project with no non-mainline branches (e.g. `/project/local:writing-mentor`) → no section renders, page is otherwise normal.
8. **High-N case**: visit `/project/repo:loschenbd/imessage-history` (~440 commits, many branches in `usage_events`) → no visual breakage.

- [ ] **Step 3: Take a screenshot of the rendered chart for review**

```bash
# Optional — use the user's preferred screenshot tool, or just describe what you see.
```

- [ ] **Step 4: If anything looks off, iterate**

Common polish points likely to need adjustment:
- Label overlap between adjacent lanes → bump `LANE_HEIGHT` from 36 to 40.
- Short arcs render too cramped → reduce `flatInset` minimum to 10.
- Long branch names truncate aggressively → bump the truncate length from 56 to 72 if labels fit.
- Trunk line color too dark → swap to `var(--color-ink-muted)`.

Each polish change is its own commit.

- [ ] **Step 5: Kill the dev server**

```bash
pkill -f "tsx src/index.ts" 2>/dev/null || true
```

- [ ] **Step 6: Run the full test suite to confirm no regressions**

```bash
npm test 2>&1 | tail -10
```

Expected: 92/93 + 16 new tests = 108/109 passing. The single pre-existing failure (overview-render "No trail yet") remains.

- [ ] **Step 7: Final commit (only if polish changes were made and not yet committed)**

```bash
git add src/dashboard/static/dashboard.js src/dashboard/static/dashboard.css
git commit -m "polish(branches): tune lane height / label truncation after eyeball"
```

---

## Summary

After all 9 tasks:

- **New files:** `src/dashboard/data/branches.ts` (~150 lines), `tests/branches.test.ts` (~250 lines)
- **Modified files:** `src/dashboard/data/project.ts`, `src/dashboard/render/project.ts`, `src/dashboard/static/dashboard.js`, `src/dashboard/static/dashboard.css`
- **New tests:** 16 unit tests covering lifecycle classification, PR matching with origin/ prefix, stale/open/merged status, cost rollup, distinct session count, featureKey lookup with comma sentinels, mainline exclusion, window filter, empty case, trunk detection, sort order.
- **No new dependencies.**

Use superpowers:finishing-a-development-branch to close out the worktree once the user confirms the chart looks right.
