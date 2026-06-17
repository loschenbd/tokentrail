# Anomaly dismiss/restore UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users dismiss and restore anomalies inline on `/worth-a-look`, and add a matching `tokentrail anomaly restore <id>` CLI command.

**Architecture:** Two new dashboard POST endpoints (`/api/anomalies/:id/dismiss` and `/restore`) back inline buttons added to the existing worth-a-look render. A small click handler in `dashboard.js` POSTs and mutates the row in-place — no full page reload. A `Show dismissed` checkbox reloads the page with `?showDismissed=1` to surface dismissed rows alongside active ones. A new `restoreAnomaly()` function in `src/commands/anomaly.ts` mirrors the existing `dismissAnomaly()`.

**Tech Stack:** TypeScript, Fastify (existing dashboard server), better-sqlite3, plain DOM JS (no framework — matches existing dashboard.js).

**Reference spec:** `docs/superpowers/specs/2026-06-16-anomaly-dismiss-ui-design.md`

---

## File structure (what each task creates/modifies)

| File                                              | Action  | Purpose                                                                     |
|---------------------------------------------------|---------|-----------------------------------------------------------------------------|
| `src/commands/anomaly.ts`                         | Modify  | Add `restoreAnomaly(id)` function next to existing `dismissAnomaly()`        |
| `src/index.ts`                                    | Modify  | Wire `restore` into the `anomaly` command action                             |
| `tests/anomaly-cli.test.ts`                       | Create  | Unit tests for `restoreAnomaly()` (happy, unknown id, already-active)        |
| `src/dashboard/server.ts`                         | Modify  | Add `POST /api/anomalies/:id/dismiss` and `/restore` handlers                |
| `tests/dashboard-anomaly-actions.test.ts`         | Create  | Integration tests for both POST endpoints via Fastify `inject()`             |
| `src/dashboard/data/worth-a-look.ts`              | Modify  | Accept `{ showDismissed: boolean }`; add `dismissed` per row + `dismissedCount` |
| `tests/worth-a-look-data.test.ts`                 | Create  | Tests for the VM with both toggle states                                     |
| `src/dashboard/render/worth-a-look.ts`            | Modify  | Add toggle header + dismiss/restore button per row                           |
| `src/dashboard/render/shell.ts`                   | Modify  | Add optional `showDismissed?` prop that emits `data-show-dismissed` on `<body>` |
| `src/dashboard/server.ts`                         | Modify  | Pass `showDismissed` query param into `buildWorthALook` and `renderShell`    |
| `src/dashboard/static/dashboard.js`               | Modify  | Add delegated click handler for `.anomaly-action` buttons                    |
| `src/dashboard/static/dashboard.css`              | Modify  | Add styles for `.anomaly-row.dismissed`, `.anomaly-action`, `.anomaly-error`, `.show-dismissed-toggle` |
| `README.md`                                       | Modify  | Drop "dashboard is read-only" claim; mention inline dismiss; add `restore` to Commands table |

---

## Task 1: Add `restoreAnomaly()` CLI function + tests

**Files:**
- Modify: `src/commands/anomaly.ts` (existing file, ~43 lines — append `restoreAnomaly` after `dismissAnomaly`)
- Modify: `src/index.ts:228-250` (the existing `program.command('anomaly')` block)
- Create: `tests/anomaly-cli.test.ts`

- [ ] **Step 1.1: Write failing tests for `restoreAnomaly`**

Create `tests/anomaly-cli.test.ts`:

```ts
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { restoreAnomaly, dismissAnomaly } from '../src/commands/anomaly.js';
import { closeDb } from '../src/db/db.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

function makeDb(): DatabaseType.Database {
  process.env.TRACKER_DB_PATH = ':memory:';
  closeDb();
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function insertAnomaly(db: DatabaseType.Database, opts: { dismissed: boolean }): number {
  // The (kind, date, feature_key, session_id) unique index requires non-null
  // feature_key when session_id is null, so vary feature_key per call.
  const r = db.prepare(
    `INSERT INTO anomalies (kind, date, feature_key, session_id, amount, baseline, multiplier, reason, dismissed_at)
     VALUES ('spike_day', '2026-06-01', 'feat-' || (abs(random()) % 1000000), NULL, 100, 30, 3.3, '$100 — 3.3×', ?)`
  ).run(opts.dismissed ? '2026-06-15T00:00:00Z' : null);
  return r.lastInsertRowid as number;
}

describe('restoreAnomaly', () => {
  let exitCode: number | undefined;
  let errorOutput: string[] = [];
  let logOutput: string[] = [];

  beforeEach(() => {
    exitCode = process.exitCode;
    process.exitCode = undefined;
    errorOutput = [];
    logOutput = [];
    // Capture stderr/stdout writes from the command.
    const origErr = console.error;
    const origLog = console.log;
    console.error = (msg: string) => { errorOutput.push(String(msg)); };
    console.log = (msg: string) => { logOutput.push(String(msg)); };
    (globalThis as any).__restoreConsole = () => {
      console.error = origErr;
      console.log = origLog;
    };
  });

  afterEach(() => {
    (globalThis as any).__restoreConsole?.();
    process.exitCode = exitCode;
  });

  test('clears dismissed_at on a dismissed anomaly', () => {
    // Need DB resolved via getDb() — point env at a temp file then use the same env.
    // The command's getDb() reads TRACKER_DB_PATH; we wire a temp DB and seed it.
    const db = makeDb();
    const id = insertAnomaly(db, { dismissed: true });

    restoreAnomaly(id);

    const row = db.prepare('SELECT dismissed_at FROM anomalies WHERE id = ?').get(id) as { dismissed_at: string | null };
    assert.equal(row.dismissed_at, null);
    assert.equal(process.exitCode, undefined);
    assert.ok(logOutput.some((l) => l.includes(`Restored anomaly ${id}.`)));
  });

  test('errors with exit code 1 on unknown id', () => {
    makeDb();

    restoreAnomaly(999999);

    assert.equal(process.exitCode, 1);
    assert.ok(errorOutput.some((l) => l.includes('No dismissed anomaly with id 999999.')));
  });

  test('errors with exit code 1 on already-active anomaly', () => {
    const db = makeDb();
    const id = insertAnomaly(db, { dismissed: false });

    restoreAnomaly(id);

    assert.equal(process.exitCode, 1);
    assert.ok(errorOutput.some((l) => l.includes(`No dismissed anomaly with id ${id}.`)));
  });
});
```

- [ ] **Step 1.2: Run the test, confirm failure**

```bash
npm test -- --test-name-pattern='restoreAnomaly'
```

Expected: 3 failures, all of the shape `restoreAnomaly is not a function` or similar import error.

- [ ] **Step 1.3: Implement `restoreAnomaly` in `src/commands/anomaly.ts`**

Append after the existing `dismissAnomaly` function (after line 14):

```ts
export function restoreAnomaly(id: number): void {
  const db = getDb();
  const result = db
    .prepare(`UPDATE anomalies SET dismissed_at = NULL WHERE id = ? AND dismissed_at IS NOT NULL`)
    .run(id);
  if (result.changes === 0) {
    console.error(`No dismissed anomaly with id ${id}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Restored anomaly ${id}.`);
}
```

- [ ] **Step 1.4: Wire `restore` into the CLI**

In `src/index.ts`, modify the existing `anomaly` command (around line 228-250) to accept `restore` as a third action. Current shape:

```ts
program
  .command('anomaly')
  .description('List or dismiss anomalies.')
  .argument('[action]', '"list" (default) or "dismiss".')
  .argument('[id]', 'Anomaly id when dismissing.')
  .action(async (action: string | undefined, id: string | undefined) => {
    const { dismissAnomaly, listAnomalies } = await import('./commands/anomaly.js');
    if (!action || action === 'list') {
      listAnomalies();
      return;
    }
    if (action === 'dismiss') {
      if (!id) {
        console.error('Usage: tokentrail anomaly dismiss <id>');
        process.exitCode = 1;
        return;
      }
      dismissAnomaly(Number.parseInt(id, 10));
      return;
    }
    console.error(`Unknown anomaly action: ${action}`);
    process.exitCode = 1;
  });
```

Replace with:

```ts
program
  .command('anomaly')
  .description('List, dismiss, or restore anomalies.')
  .argument('[action]', '"list" (default), "dismiss", or "restore".')
  .argument('[id]', 'Anomaly id when dismissing or restoring.')
  .action(async (action: string | undefined, id: string | undefined) => {
    const { dismissAnomaly, listAnomalies, restoreAnomaly } = await import('./commands/anomaly.js');
    if (!action || action === 'list') {
      listAnomalies();
      return;
    }
    if (action === 'dismiss' || action === 'restore') {
      if (!id) {
        console.error(`Usage: tokentrail anomaly ${action} <id>`);
        process.exitCode = 1;
        return;
      }
      const n = Number.parseInt(id, 10);
      if (action === 'dismiss') dismissAnomaly(n);
      else restoreAnomaly(n);
      return;
    }
    console.error(`Unknown anomaly action: ${action}`);
    process.exitCode = 1;
  });
```

- [ ] **Step 1.5: Run tests, confirm pass**

```bash
npm test -- --test-name-pattern='restoreAnomaly'
```

Expected: 3 passed.

- [ ] **Step 1.6: Full test suite passes (no regressions)**

```bash
npm test
```

Expected: all green, 3 new tests added to the count.

- [ ] **Step 1.7: Commit**

```bash
git add src/commands/anomaly.ts src/index.ts tests/anomaly-cli.test.ts
git commit -m "feat(anomaly): add tokentrail anomaly restore <id> command

Mirrors dismissAnomaly. Sets dismissed_at = NULL with a WHERE guard
that prevents restoring an already-active anomaly (returns exit 1 with
a clear error). The CLI dispatch in src/index.ts now accepts list,
dismiss, or restore as actions.

Tests cover the happy path, unknown id, and already-active id cases."
```

---

## Task 2: Dashboard POST endpoints + tests

**Files:**
- Modify: `src/dashboard/server.ts` (add 2 handlers after the existing `/api/today` endpoint)
- Create: `tests/dashboard-anomaly-actions.test.ts`

- [ ] **Step 2.1: Write failing tests for the POST endpoints**

Create `tests/dashboard-anomaly-actions.test.ts`:

```ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildServer } from '../src/dashboard/server.js';
import { closeDb } from '../src/db/db.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

function makeDbWithAnomaly(opts: { dismissed: boolean }): { id: number; db: DatabaseType.Database } {
  process.env.TRACKER_DB_PATH = ':memory:';
  closeDb();
  const db = new Database(':memory:');
  runMigrations(db);
  // Re-point the singleton so buildServer's handlers read this DB.
  // The simplest way: write to a temp file and set TRACKER_DB_PATH to it.
  // But for `:memory:` we need a different approach — keep this db open
  // and have the server reuse it via the closeDb+TRACKER_DB_PATH dance.
  const r = db.prepare(
    `INSERT INTO anomalies (kind, date, feature_key, session_id, amount, baseline, multiplier, reason, dismissed_at)
     VALUES ('spike_day', '2026-06-01', 'feat-1', NULL, 100, 30, 3.3, '$100 — 3.3×', ?)`
  ).run(opts.dismissed ? '2026-06-15T00:00:00Z' : null);
  return { id: r.lastInsertRowid as number, db };
}

describe('POST /api/anomalies/:id/dismiss', () => {
  test('dismisses an active anomaly and returns 204', async () => {
    const { id, db } = makeDbWithAnomaly({ dismissed: false });
    const app = buildServer({ defaultDays: 30 });

    const res = await app.inject({ method: 'POST', url: `/api/anomalies/${id}/dismiss` });

    assert.equal(res.statusCode, 204);
    const row = db.prepare('SELECT dismissed_at FROM anomalies WHERE id = ?').get(id) as { dismissed_at: string | null };
    assert.ok(row.dismissed_at !== null, 'dismissed_at should be set');
    await app.close();
  });

  test('returns 404 for unknown id', async () => {
    makeDbWithAnomaly({ dismissed: false });
    const app = buildServer({ defaultDays: 30 });

    const res = await app.inject({ method: 'POST', url: '/api/anomalies/999999/dismiss' });

    assert.equal(res.statusCode, 404);
    await app.close();
  });

  test('returns 409 when already dismissed', async () => {
    const { id } = makeDbWithAnomaly({ dismissed: true });
    const app = buildServer({ defaultDays: 30 });

    const res = await app.inject({ method: 'POST', url: `/api/anomalies/${id}/dismiss` });

    assert.equal(res.statusCode, 409);
    await app.close();
  });

  test('returns 400 for malformed id', async () => {
    makeDbWithAnomaly({ dismissed: false });
    const app = buildServer({ defaultDays: 30 });

    const res = await app.inject({ method: 'POST', url: '/api/anomalies/not-a-number/dismiss' });

    assert.equal(res.statusCode, 400);
    await app.close();
  });
});

describe('POST /api/anomalies/:id/restore', () => {
  test('restores a dismissed anomaly and returns 204', async () => {
    const { id, db } = makeDbWithAnomaly({ dismissed: true });
    const app = buildServer({ defaultDays: 30 });

    const res = await app.inject({ method: 'POST', url: `/api/anomalies/${id}/restore` });

    assert.equal(res.statusCode, 204);
    const row = db.prepare('SELECT dismissed_at FROM anomalies WHERE id = ?').get(id) as { dismissed_at: string | null };
    assert.equal(row.dismissed_at, null);
    await app.close();
  });

  test('returns 404 for unknown id', async () => {
    makeDbWithAnomaly({ dismissed: true });
    const app = buildServer({ defaultDays: 30 });

    const res = await app.inject({ method: 'POST', url: '/api/anomalies/999999/restore' });

    assert.equal(res.statusCode, 404);
    await app.close();
  });

  test('returns 409 when already active', async () => {
    const { id } = makeDbWithAnomaly({ dismissed: false });
    const app = buildServer({ defaultDays: 30 });

    const res = await app.inject({ method: 'POST', url: `/api/anomalies/${id}/restore` });

    assert.equal(res.statusCode, 409);
    await app.close();
  });

  test('returns 400 for malformed id', async () => {
    makeDbWithAnomaly({ dismissed: true });
    const app = buildServer({ defaultDays: 30 });

    const res = await app.inject({ method: 'POST', url: '/api/anomalies/abc/restore' });

    assert.equal(res.statusCode, 400);
    await app.close();
  });
});
```

**Note on DB plumbing:** the existing `api.test.ts` uses the same `closeDb()` + `:memory:` pattern. Refer to `tests/api.test.ts:137-145` for the precedent.

- [ ] **Step 2.2: Run tests, confirm failure**

```bash
npm test -- --test-name-pattern='POST /api/anomalies'
```

Expected: all 8 tests fail with 404 (Fastify reports unregistered routes as 404).

- [ ] **Step 2.3: Implement the endpoints in `src/dashboard/server.ts`**

After the existing `/api/today` handler (around line 75), add:

```ts
  app.post<{ Params: { id: string } }>('/api/anomalies/:id/dismiss', async (req, reply) => {
    return setAnomalyDismissed(req.params.id, true, reply);
  });

  app.post<{ Params: { id: string } }>('/api/anomalies/:id/restore', async (req, reply) => {
    return setAnomalyDismissed(req.params.id, false, reply);
  });
```

Then add a private helper at the bottom of `server.ts` (before the closing `}` of the file):

```ts
function setAnomalyDismissed(rawId: string, dismiss: boolean, reply: import('fastify').FastifyReply): unknown {
  const id = Number.parseInt(rawId, 10);
  if (!Number.isFinite(id) || id <= 0 || String(id) !== rawId) {
    return reply.code(400).send({ error: 'invalid id' });
  }
  const db = getDb();
  const row = db.prepare('SELECT dismissed_at FROM anomalies WHERE id = ?').get(id) as { dismissed_at: string | null } | undefined;
  if (!row) {
    return reply.code(404).send({ error: 'not found' });
  }
  const isCurrentlyDismissed = row.dismissed_at !== null;
  if (dismiss && isCurrentlyDismissed) {
    return reply.code(409).send({ error: 'already dismissed' });
  }
  if (!dismiss && !isCurrentlyDismissed) {
    return reply.code(409).send({ error: 'already active' });
  }
  if (dismiss) {
    db.prepare(`UPDATE anomalies SET dismissed_at = datetime('now') WHERE id = ? AND dismissed_at IS NULL`).run(id);
  } else {
    db.prepare(`UPDATE anomalies SET dismissed_at = NULL WHERE id = ? AND dismissed_at IS NOT NULL`).run(id);
  }
  return reply.code(204).send();
}
```

- [ ] **Step 2.4: Run tests, confirm pass**

```bash
npm test -- --test-name-pattern='POST /api/anomalies'
```

Expected: 8 passed.

- [ ] **Step 2.5: Full test suite passes (no regressions)**

```bash
npm test
```

Expected: all green.

- [ ] **Step 2.6: Commit**

```bash
git add src/dashboard/server.ts tests/dashboard-anomaly-actions.test.ts
git commit -m "feat(dashboard): POST /api/anomalies/:id/dismiss + /restore endpoints

Two new endpoints that back the upcoming inline dismiss/restore UI on
/worth-a-look. Response codes: 204 on state flip, 404 on unknown id,
409 when already in the requested state, 400 on malformed id. Shared
helper does the lookup-then-update with a WHERE guard so concurrent
double-clicks can't double-flip.

No CSRF or auth — server binds 127.0.0.1, single-user tool, matches
the existing GET endpoints' threat model."
```

---

## Task 3: Extend `buildWorthALook` to support `showDismissed`

**Files:**
- Modify: `src/dashboard/data/worth-a-look.ts`
- Create: `tests/worth-a-look-data.test.ts`

- [ ] **Step 3.1: Write failing tests for the extended VM**

Create `tests/worth-a-look-data.test.ts`:

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildWorthALook } from '../src/dashboard/data/worth-a-look.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

function makeDb(): DatabaseType.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seed(db: DatabaseType.Database, rows: Array<{ kind: string; date: string; featureKey: string; reason: string; multiplier: number; dismissed: boolean }>): void {
  const stmt = db.prepare(
    `INSERT INTO anomalies (kind, date, feature_key, session_id, amount, baseline, multiplier, reason, dismissed_at)
     VALUES (?, ?, ?, NULL, 100, 30, ?, ?, ?)`
  );
  for (const r of rows) {
    stmt.run(r.kind, r.date, r.featureKey, r.multiplier, r.reason, r.dismissed ? '2026-06-15T00:00:00Z' : null);
  }
}

describe('buildWorthALook', () => {
  test('default: returns only active anomalies', () => {
    const db = makeDb();
    seed(db, [
      { kind: 'spike_day', date: '2026-06-02', featureKey: 'f1', reason: 'active 1', multiplier: 3.1, dismissed: false },
      { kind: 'spike_day', date: '2026-06-01', featureKey: 'f2', reason: 'dismissed 1', multiplier: 4.0, dismissed: true },
    ]);

    const vm = buildWorthALook(db, { showDismissed: false });

    assert.equal(vm.showDismissed, false);
    assert.equal(vm.dismissedCount, 1);
    assert.equal(vm.items.length, 1);
    assert.equal(vm.items[0]!.reason, 'active 1');
    assert.equal(vm.items[0]!.dismissed, false);
  });

  test('showDismissed=true: returns both, active first', () => {
    const db = makeDb();
    seed(db, [
      { kind: 'spike_day', date: '2026-06-01', featureKey: 'f1', reason: 'dismissed old', multiplier: 5.0, dismissed: true },
      { kind: 'spike_day', date: '2026-06-02', featureKey: 'f2', reason: 'active newer', multiplier: 3.1, dismissed: false },
    ]);

    const vm = buildWorthALook(db, { showDismissed: true });

    assert.equal(vm.showDismissed, true);
    assert.equal(vm.dismissedCount, 1);
    assert.equal(vm.items.length, 2);
    // Active first regardless of date.
    assert.equal(vm.items[0]!.dismissed, false);
    assert.equal(vm.items[1]!.dismissed, true);
  });

  test('empty: counts are zero', () => {
    const db = makeDb();
    const vm = buildWorthALook(db, { showDismissed: true });
    assert.equal(vm.items.length, 0);
    assert.equal(vm.dismissedCount, 0);
  });
});
```

- [ ] **Step 3.2: Run tests, confirm failure**

```bash
npm test -- --test-name-pattern='buildWorthALook'
```

Expected: TypeScript compile error or runtime error — `buildWorthALook` currently takes no second arg, returns no `showDismissed`/`dismissedCount`/`dismissed` fields.

- [ ] **Step 3.3: Update `src/dashboard/data/worth-a-look.ts`**

Replace the entire file with:

```ts
import type DatabaseType from 'better-sqlite3';

export type WorthALookVM = {
  showDismissed: boolean;
  dismissedCount: number;
  items: Array<{
    id: number;
    kind: string;
    date: string;
    featureKey: string | null;
    sessionId: string | null;
    amount: number;
    reason: string;
    multiplier: number;
    dismissed: boolean;
  }>;
};

export type BuildWorthALookOptions = {
  showDismissed: boolean;
};

export function buildWorthALook(
  db: DatabaseType.Database,
  opts: BuildWorthALookOptions = { showDismissed: false }
): WorthALookVM {
  const dismissedCount = (db
    .prepare(`SELECT COUNT(*) AS n FROM anomalies WHERE dismissed_at IS NOT NULL`)
    .get() as { n: number }).n;

  // Active rows always; dismissed rows only when requested. ORDER BY
  // `dismissed ASC` puts active (dismissed=0) before dismissed (dismissed=1)
  // and tie-breaks by date desc then multiplier desc within each group.
  const whereClause = opts.showDismissed ? '' : 'WHERE dismissed_at IS NULL';
  const items = db
    .prepare(`
      SELECT id, kind, date,
             feature_key AS featureKey,
             session_id  AS sessionId,
             ROUND(amount, 2)     AS amount,
             ROUND(multiplier, 2) AS multiplier,
             reason,
             CASE WHEN dismissed_at IS NULL THEN 0 ELSE 1 END AS dismissedInt
      FROM anomalies
      ${whereClause}
      ORDER BY dismissedInt ASC, date DESC, multiplier DESC
    `)
    .all() as Array<Omit<WorthALookVM['items'][number], 'dismissed'> & { dismissedInt: number }>;

  return {
    showDismissed: opts.showDismissed,
    dismissedCount,
    items: items.map(({ dismissedInt, ...rest }) => ({ ...rest, dismissed: dismissedInt === 1 })),
  };
}
```

- [ ] **Step 3.4: Run tests, confirm pass**

```bash
npm test -- --test-name-pattern='buildWorthALook'
```

Expected: 3 passed.

- [ ] **Step 3.5: Full test suite — server.ts and render still consume old shape, may fail**

```bash
npm test
```

Expected: passes still. `renderWorthALook` reads `vm.items` (same field name); the new `dismissed`/`showDismissed`/`dismissedCount` fields are simply unused for now. `server.ts` calls `buildWorthALook(getDb())` with no second arg — the new signature has a default of `{ showDismissed: false }`, so behavior is unchanged. Confirm by running the suite.

- [ ] **Step 3.6: Commit**

```bash
git add src/dashboard/data/worth-a-look.ts tests/worth-a-look-data.test.ts
git commit -m "feat(worth-a-look): VM accepts showDismissed; adds dismissed flag + count

Extends buildWorthALook with an optional { showDismissed } argument
(defaults to false for back-compat). The VM now exposes:
- showDismissed: the toggle state, echoed back to the renderer
- dismissedCount: total dismissed rows in the DB (for header label)
- items[].dismissed: per-row flag for renderer to style appropriately

Active rows always sort before dismissed rows when both are returned."
```

---

## Task 4: Render dismiss/restore UI + shell `data-show-dismissed`

**Files:**
- Modify: `src/dashboard/render/shell.ts`
- Modify: `src/dashboard/render/worth-a-look.ts`
- Modify: `src/dashboard/server.ts`

This is a render-only change. Manual visual check after, no new automated tests (matching repo convention — `renderWorthALook` has no existing tests either).

- [ ] **Step 4.1: Update `src/dashboard/render/shell.ts` to accept `showDismissed`**

Change the `ShellOptions` type and the `<body>` tag. Find the existing `<body>` line and the `ShellOptions` definition.

Current `ShellOptions`:

```ts
export type ShellOptions = {
  title: string;
  activeTab?: 'overview' | 'today' | 'feature' | 'project' | 'worth-a-look';
  days: number;
  showBack?: boolean;
};
```

Replace with:

```ts
export type ShellOptions = {
  title: string;
  activeTab?: 'overview' | 'today' | 'feature' | 'project' | 'worth-a-look';
  days: number;
  showBack?: boolean;
  showDismissed?: boolean;
};
```

Find the `<body>` line in `renderShell` (the HTML template literal):

```html
<body>
```

Replace with:

```ts
<body${opts.showDismissed ? ' data-show-dismissed="1"' : ''}>
```

- [ ] **Step 4.2: Update `src/dashboard/render/worth-a-look.ts` to render the toggle + actions**

Replace the entire file with:

```ts
import type { WorthALookVM } from '../data/worth-a-look.js';
import { escapeHtml } from './shell.js';

export function renderWorthALook(vm: WorthALookVM): string {
  const activeCount = vm.items.filter((i) => !i.dismissed).length;

  // Toggle: a GET form that posts back to the same page with ?showDismissed.
  // Plain checkbox + onchange.submit() — no JS needed for the toggle itself.
  const toggleChecked = vm.showDismissed ? ' checked' : '';
  const toggleHtml = `
    <form method="get" action="/worth-a-look" class="show-dismissed-toggle">
      <label>
        <input type="checkbox" name="showDismissed" value="1"${toggleChecked} onchange="this.form.submit()">
        Show dismissed (${vm.dismissedCount})
      </label>
    </form>
  `;

  if (vm.items.length === 0) {
    const headline = vm.showDismissed
      ? 'Trail is calm — no anomalies recorded.'
      : 'Trail is calm — no active anomalies.';
    return `
<div class="single-col">
  <div class="card">
    <div class="row-between">
      <div class="label">Worth a look</div>
      ${toggleHtml}
    </div>
    <div class="hero">${escapeHtml(headline)}</div>
  </div>
</div>
    `;
  }

  const rows = vm.items.map((a) => renderRow(a)).join('');
  const summary = vm.showDismissed
    ? `${activeCount} active · ${vm.dismissedCount} dismissed`
    : `${activeCount} active`;

  return `
<div class="single-col">
  <div class="card">
    <div class="row-between">
      <div class="label">Worth a look · ${summary}</div>
      ${toggleHtml}
    </div>
    ${rows}
  </div>
</div>
  `;
}

function renderRow(a: WorthALookVM['items'][number]): string {
  const href = a.featureKey
    ? `/feature/${encodeURIComponent(a.featureKey)}`
    : null;
  const target = href
    ? `<a href="${escapeHtml(href)}">${escapeHtml(a.featureKey ?? '')}</a>`
    : (a.sessionId ? `<span class="sha">${escapeHtml(a.sessionId.slice(0, 8))}…</span>` : '');
  const action = a.dismissed ? 'restore' : 'dismiss';
  const dismissedClass = a.dismissed ? ' dismissed' : '';
  return `
    <div class="anomaly-row anomaly-full${dismissedClass}" data-anomaly-id="${a.id}">
      <span class="anomaly-date">${escapeHtml(a.date)}</span>
      <span class="anomaly-kind">${escapeHtml(a.kind)}</span>
      <span class="anomaly-target">${target}</span>
      <span class="anomaly-reason">${escapeHtml(a.reason)}</span>
      <button class="anomaly-action" data-action="${action}">${action}</button>
    </div>
  `;
}
```

- [ ] **Step 4.3: Update `src/dashboard/server.ts` to thread `showDismissed`**

Find the existing `/worth-a-look` handler:

```ts
  app.get('/worth-a-look', async (_req, reply) => {
    const vm = buildWorthALook(getDb());
    reply.type('text/html; charset=utf-8');
    return renderShell({ title: 'Worth a look · Tokentrail', activeTab: 'worth-a-look', days: opts.defaultDays, showBack: true }, renderWorthALook(vm));
  });
```

Replace with:

```ts
  app.get('/worth-a-look', async (req, reply) => {
    const showDismissed = parseShowDismissed(req.query);
    const vm = buildWorthALook(getDb(), { showDismissed });
    reply.type('text/html; charset=utf-8');
    return renderShell(
      { title: 'Worth a look · Tokentrail', activeTab: 'worth-a-look', days: opts.defaultDays, showBack: true, showDismissed },
      renderWorthALook(vm)
    );
  });
```

Add a helper alongside the existing `parseDays` at the bottom of the file:

```ts
function parseShowDismissed(query: unknown): boolean {
  if (typeof query !== 'object' || query === null) return false;
  const raw = (query as Record<string, unknown>).showDismissed;
  return raw === '1' || raw === 'true' || raw === 'on';
}
```

- [ ] **Step 4.4: Build + run tests — confirm no regressions**

```bash
npm run build && npm test
```

Expected: clean build, all tests pass.

- [ ] **Step 4.5: Manual visual check**

```bash
npm run tokentrail -- dashboard --no-open
open http://127.0.0.1:4920/worth-a-look
```

Verify:
- Header shows `Worth a look · N active` and a `☐ Show dismissed (M)` checkbox
- Each row has a `dismiss` button at the end (no styling yet — that's Task 5)
- Toggle the checkbox: page reloads with `?showDismissed=1`, dismissed rows appear (unstyled), each with a `restore` button
- Empty state messages render correctly when there are no rows

If the dashboard daemon is launchd-managed, restart it: `launchctl kickstart -k gui/$(id -u)/com.tokentrail.daemon`

- [ ] **Step 4.6: Commit**

```bash
git add src/dashboard/render/shell.ts src/dashboard/render/worth-a-look.ts src/dashboard/server.ts
git commit -m "feat(worth-a-look): render dismiss/restore buttons + Show dismissed toggle

Each anomaly row gets a small text button (\"dismiss\" or \"restore\")
that POSTs to the matching endpoint from Task 2. A header toggle
reloads the page with ?showDismissed=1 to surface dismissed rows
inline, styled with .dismissed class so CSS can mute them in Task 5.

Shell takes an optional showDismissed prop that emits
data-show-dismissed=\"1\" on <body>, which the click handler in Task 5
reads to decide whether to collapse the row after dismissal."
```

---

## Task 5: Click handler + CSS

**Files:**
- Modify: `src/dashboard/static/dashboard.js`
- Modify: `src/dashboard/static/dashboard.css`

- [ ] **Step 5.1: Append click handler to `src/dashboard/static/dashboard.js`**

Add at the end of the file (inside the existing IIFE — find the closing `})();` and add before it):

```js
  // Anomaly dismiss/restore actions. Delegated handler so we don't need
  // to re-bind after server-rendered re-renders.
  document.addEventListener('click', async function (e) {
    const btn = e.target.closest('.anomaly-action');
    if (!btn) return;
    const row = btn.closest('.anomaly-row');
    if (!row) return;
    const id = row.dataset.anomalyId;
    const action = btn.dataset.action;
    if (!id || (action !== 'dismiss' && action !== 'restore')) return;

    btn.disabled = true;
    try {
      const res = await fetch('/api/anomalies/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
      if (!res.ok) throw new Error('HTTP ' + res.status);

      // Flip the row's visual state.
      row.classList.toggle('dismissed');
      const newAction = action === 'dismiss' ? 'restore' : 'dismiss';
      btn.textContent = newAction;
      btn.dataset.action = newAction;
      btn.disabled = false;

      // If we're not showing dismissed rows and we just dismissed one,
      // collapse it out of view.
      const showDismissed = document.body.dataset.showDismissed === '1';
      if (!showDismissed && action === 'dismiss') {
        row.style.transition = 'opacity 200ms';
        row.style.opacity = '0';
        setTimeout(function () { row.remove(); }, 200);
      }
    } catch (err) {
      btn.disabled = false;
      // Inline ephemeral error message next to the button.
      const errSpan = document.createElement('span');
      errSpan.className = 'anomaly-error';
      errSpan.textContent = ' (failed — try again)';
      btn.parentElement.appendChild(errSpan);
      setTimeout(function () { errSpan.remove(); }, 4000);
    }
  });
```

- [ ] **Step 5.2: Append CSS to `src/dashboard/static/dashboard.css`**

Append at the end of the file:

```css
/* Worth-a-look dismiss/restore UI */

.show-dismissed-toggle { margin-left: auto; }
.show-dismissed-toggle label {
  font-size: var(--size-small);
  color: var(--color-ink-muted);
  cursor: pointer;
  user-select: none;
}
.show-dismissed-toggle input[type="checkbox"] {
  margin-right: 4px;
  vertical-align: middle;
}

.row-between {
  display: flex;
  align-items: center;
  gap: var(--space-m);
  margin-bottom: var(--space-s);
}

.anomaly-action {
  background: none;
  border: none;
  color: var(--color-ink-muted);
  font-family: var(--font-sans);
  font-size: var(--size-small);
  cursor: pointer;
  padding: 2px 6px;
  text-decoration: underline;
}
.anomaly-action:hover { color: var(--color-ink); }
.anomaly-action:disabled { opacity: 0.5; cursor: wait; }

.anomaly-row.dismissed {
  opacity: 0.55;
}
.anomaly-row.dismissed .anomaly-reason {
  text-decoration: line-through;
  text-decoration-color: var(--color-ink-subtle);
}

.anomaly-error {
  color: #a23a3a;
  font-size: var(--size-small);
  font-style: italic;
}
```

- [ ] **Step 5.3: Manual test the full flow**

```bash
# Restart the daemon if launchd-managed:
launchctl kickstart -k gui/$(id -u)/com.tokentrail.daemon
# Or start fresh:
npm run tokentrail -- dashboard --no-open
open http://127.0.0.1:4920/worth-a-look
```

Click through:
1. Click `dismiss` on an active row → row fades and disappears
2. Toggle `Show dismissed` → reloads, dismissed row reappears muted with strikethrough and a `restore` button
3. Click `restore` → row un-mutes, button flips back to `dismiss`, stays visible
4. Reload page → state persisted on the server
5. Click `dismiss` while offline (e.g. `pkill -STOP <daemon-pid>` in another shell) → button briefly disabled, ` (failed — try again)` appears next to the button and clears after 4s

If anything breaks, check the browser console for fetch errors; check the daemon log at `~/Library/Logs/tokentrail-daemon.log` for server errors.

- [ ] **Step 5.4: Commit**

```bash
git add src/dashboard/static/dashboard.js src/dashboard/static/dashboard.css
git commit -m "feat(dashboard): click handler + styles for anomaly dismiss/restore

A single delegated listener intercepts clicks on .anomaly-action,
POSTs to the matching endpoint, and flips the row's visual state
without a full reload. Reads body[data-show-dismissed] to decide
whether to collapse the row after dismissal.

CSS: muted color + strikethrough for .dismissed rows, a small text
button styled like footer links, and an inline error message that
auto-clears after 4s when a request fails."
```

---

## Task 6: README updates

**Files:**
- Modify: `README.md`

- [ ] **Step 6.1: Drop the "dashboard is read-only" line + add dismiss mention**

Find the line in the Dashboard section (currently near line 303):

```markdown
The dashboard is read-only. Labeling, anomaly dismissal, and sync stay on the
CLI. Stop it with Ctrl-C.
```

Replace with:

```markdown
Anomalies on `/worth-a-look` can be dismissed and restored inline. Labeling
and sync stay on the CLI for now. Stop the dashboard with Ctrl-C.
```

- [ ] **Step 6.2: Update the Commands table**

Find the existing `tokentrail anomaly` row in the Commands section. Currently it's likely absent or listed under a generic anomaly entry. Add or replace with:

```
tokentrail anomaly [list|dismiss|restore] [id]  # List, dismiss, or restore anomalies.
```

(If the Commands table doesn't currently include `anomaly`, add this row to the table.)

- [ ] **Step 6.3: Commit**

```bash
git add README.md
git commit -m "docs(readme): mention inline anomaly dismiss/restore + new restore command"
```

---

## Self-Review

**Spec coverage:**
- ✅ Goal: dismiss/restore on /worth-a-look + CLI restore — Tasks 1-5
- ✅ Non-goals respected: no other anomaly pages, no toast undo, no CSRF — none of those appear in tasks
- ✅ No schema changes — confirmed, no migration step
- ✅ CLI restore — Task 1
- ✅ POST endpoints with the four response codes — Task 2
- ✅ Show dismissed toggle, button markup, body data attribute — Task 4
- ✅ Click handler with state flip, collapse, error span — Task 5
- ✅ Empty states for all 4 combinations — Task 4 (single `vm.items.length === 0` branch with `vm.showDismissed` conditional, covers the 3 zero cases from the spec table; the "0 active + showDismissed=on with some dismissed" case is the non-empty path since `vm.items.length > 0` when dismissed rows are included)
- ✅ README updates — Task 6
- ✅ Risks (`<body data-show-dismissed>` plumbing, concurrent double-click) — addressed by Step 4.1 and the WHERE guard in Step 2.3 respectively

**Placeholder scan:** No "TBD", "TODO", or vague "handle errors appropriately". Every code block is concrete.

**Type consistency:**
- `WorthALookVM.items[number]` has `dismissed: boolean` — used in Tasks 3, 4
- `BuildWorthALookOptions.showDismissed: boolean` — Task 3 defines, Task 4 calls with same name
- `ShellOptions.showDismissed?: boolean` — Task 4 defines, Task 4 server change consumes
- `data-anomaly-id` / `data-action` / `data-show-dismissed` — used consistently across Tasks 4 and 5
- POST endpoint URLs `/api/anomalies/:id/dismiss` and `/restore` — consistent across Tasks 2, 4, 5

**One ambiguity flagged for the implementer:** the test file in Step 2.1 uses an in-memory DB pattern that depends on the dashboard's `getDb()` singleton being re-pointed via the `closeDb() + TRACKER_DB_PATH = ':memory:'` dance. This pattern is in use in `tests/api.test.ts:137-145` — refer there if it behaves unexpectedly. If reusing the same DB instance across server+test proves tricky with `:memory:`, fall back to a temp file via `mkdtempSync`.
