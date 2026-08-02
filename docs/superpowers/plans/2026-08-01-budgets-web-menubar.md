# Budgets Everywhere Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make budgets visible, settable from the web UI, per-source (Claude / Copilot / Cursor), and alerting on the native app — across web, CLI, API, and menu-bar.

**Architecture:** Budgets are a handful of scalars stored in the tokentrail **config file** (`.tokentrail.json` / `~/.config/tokentrail/config.json`) beside the existing `monthlyBudgetUsd`. A new narrow config **writer** (`saveBudgetConfig`) is the first writer for that file. `buildBudget` gains a per-source breakdown reusing the same source→spend mapping as the per-harness overview. The API carries `budget.sources[]`; the web renders a Budget sidebar card + a Settings fieldset (new `POST /api/budget`); the native app enriches its budget view, shows an empty state, and fires threshold notifications via a pure `newlyCrossed` decision function.

**Tech Stack:** Node.js + TypeScript, better-sqlite3, Fastify, commander, SwiftUI (single-file `swiftc` build). Tests: `node --import tsx --test`; native self-test via a `--selftest-notifications` CLI path.

## Global Constraints

- All costs are labeled **estimated** (constitution rule 3).
- Never hardcode API keys; config file holds no secrets — budget keys only.
- GitHub/Notion failures log cleanly and never crash the pipeline (rule 6) — not touched here, but the config writer must fail soft (log + skip) rather than throw into the request path.
- CLI language stays restrained and readable (rule 7); fantasy flavor only in microcopy (rule 8).
- Config file is **not** a JSONL source, so rule 9 (JSONL read-only) does not forbid writing it. The writer touches **only** budget keys and preserves every other key verbatim.
- Source→spend mapping is single-sourced: `claude = usage_events.source IN ('jsonl','hook')`, `copilot = usage_events.source = 'copilot'`, `cursor = cursor_daily_cost`. Budget and the source-scoped overview must not diverge.
- Colors via existing theme tokens (works light/dark). No new client JS for the web card (server-rendered).
- Cycle day is clamped 1–28. `projectionReliable` = `daysElapsed >= 3`, applied **independently** per source.
- Ship as **v0.12.0**. Native changes require the app-bundle rebuild+swap step of the release flow, not just `brew upgrade`.

**Type contract (defined in Task 2, referenced everywhere after):**

```ts
// src/dashboard/data/budget.ts
export type BudgetStatus = {
  budgetUsd: number; cycleStart: string; cycleEnd: string;
  spentUsd: number; projectedUsd: number; pctUsed: number; projectedPct: number;
  daysElapsed: number; daysInCycle: number; projectionReliable: boolean;
  state: 'ok' | 'warn' | 'over';
};
export type BudgetSourceKey = 'claude' | 'copilot' | 'cursor';
export type SourceBudgetStatus = BudgetStatus & { key: BudgetSourceKey; label: string };
export type BudgetReport = BudgetStatus & { sources: SourceBudgetStatus[] };
```

`buildBudget(...)` returns `BudgetReport | null`. Global fields stay flat on the object (backward-compatible with today's `BudgetStatus` consumers); `sources` is a (possibly empty) array.

---

### Task 1: Config model + `saveBudgetConfig` writer

**Files:**
- Modify: `src/lib/config.ts` (type at :52-72, `EMPTY_CONFIG` :74-87, `normalize` :138-160; add writer + `SourceBudgets` type + normalizer)
- Test: `tests/config-budget.test.ts` (create)

**Interfaces:**
- Produces: `type SourceBudgets = { claude: number | null; copilot: number | null; cursor: number | null }`; `TokentrailConfig.sourceBudgets: SourceBudgets`; `saveBudgetConfig(patch: BudgetPatch): { path: string }` where
  `type BudgetPatch = { monthlyBudgetUsd?: number | null; budgetCycleStartDay?: number; sourceBudgets?: Partial<SourceBudgets> }`.
- Consumes: existing `resolveConfigPath()` (currently private — export it or add an internal `configTargetPath()`), `resetConfigCache()`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/config-budget.test.ts
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigFrom, saveBudgetConfig, resetConfigCache } from '../src/lib/config.js';

let dir: string;
let cfgPath: string;
const prevEnv = process.env.TOKENTRAIL_CONFIG;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-cfg-'));
  cfgPath = join(dir, 'config.json');
  process.env.TOKENTRAIL_CONFIG = cfgPath;
  resetConfigCache();
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.TOKENTRAIL_CONFIG;
  else process.env.TOKENTRAIL_CONFIG = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe('saveBudgetConfig', () => {
  test('merges budget keys, preserving unrelated keys', () => {
    writeFileSync(cfgPath, JSON.stringify({ copilotStorePath: '/x/y', monthlyBudgetUsd: 100 }, null, 2));
    saveBudgetConfig({ monthlyBudgetUsd: 250, sourceBudgets: { claude: 150 } });
    const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(raw.copilotStorePath, '/x/y');        // untouched
    assert.equal(raw.monthlyBudgetUsd, 250);           // updated
    assert.deepEqual(raw.sourceBudgets, { claude: 150 }); // merged
  });

  test('normalize exposes sourceBudgets with null defaults', () => {
    writeFileSync(cfgPath, JSON.stringify({ sourceBudgets: { claude: 150, copilot: 0, cursor: -5 } }));
    const cfg = loadConfigFrom(cfgPath);
    // 0 and negative coerce to null (no cap); positive kept.
    assert.deepEqual(cfg.sourceBudgets, { claude: 150, copilot: null, cursor: null });
  });

  test('explicit null clears a budget key', () => {
    writeFileSync(cfgPath, JSON.stringify({ monthlyBudgetUsd: 100, sourceBudgets: { claude: 150 } }));
    saveBudgetConfig({ monthlyBudgetUsd: null, sourceBudgets: { claude: null } });
    const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(raw.monthlyBudgetUsd, null);
    assert.equal(raw.sourceBudgets.claude, null);
  });

  test('creates the file when none exists', () => {
    resetConfigCache();
    const res = saveBudgetConfig({ monthlyBudgetUsd: 80 });
    assert.equal(res.path, cfgPath);
    const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(raw.monthlyBudgetUsd, 80);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test tests/config-budget.test.ts`
Expected: FAIL — `saveBudgetConfig` is not exported / `cfg.sourceBudgets` undefined.

- [ ] **Step 3: Add the type, normalizer, and default**

In `src/lib/config.ts`, add near the top-level types:

```ts
export type SourceBudgets = { claude: number | null; copilot: number | null; cursor: number | null };
```

Add to `TokentrailConfig` (after `budgetCycleStartDay`):

```ts
  /** Optional per-harness monthly caps. Each null = no cap for that source. */
  sourceBudgets: SourceBudgets;
```

Add to `EMPTY_CONFIG`:

```ts
  sourceBudgets: { claude: null, copilot: null, cursor: null },
```

Add a coercion helper and call it in `normalize()`'s returned object:

```ts
function positiveOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}
function normalizeSourceBudgets(v: unknown): SourceBudgets {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  return { claude: positiveOrNull(o.claude), copilot: positiveOrNull(o.copilot), cursor: positiveOrNull(o.cursor) };
}
```

In the object `normalize()` returns, add: `sourceBudgets: normalizeSourceBudgets(obj.sourceBudgets),`.

- [ ] **Step 4: Add the writer**

Append to `src/lib/config.ts` (import `writeFileSync`, `renameSync`, `mkdirSync` from `node:fs` — reuse existing `readFileSync`, `existsSync`, `resolve`, `join`, `homedir`):

```ts
export type BudgetPatch = {
  monthlyBudgetUsd?: number | null;
  budgetCycleStartDay?: number;
  sourceBudgets?: Partial<SourceBudgets>;
};

// Where a write should land: an existing config file if one is resolvable,
// else the user-level path (created on demand). Never invents a project-local
// file that doesn't already exist.
function configTargetPath(): string {
  return resolveConfigPath() ?? join(homedir(), '.config', 'tokentrail', 'config.json');
}

// The FIRST config writer. Narrow by design: touches only budget keys, keeps
// every unrelated key verbatim, writes atomically, and busts the cache so the
// next getConfig() reflects the change.
export function saveBudgetConfig(patch: BudgetPatch): { path: string } {
  const path = configTargetPath();
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf-8').trim();
    if (raw.length > 0) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) current = parsed as Record<string, unknown>;
    }
  }

  if ('monthlyBudgetUsd' in patch) {
    current.monthlyBudgetUsd = patch.monthlyBudgetUsd == null ? null : patch.monthlyBudgetUsd;
  }
  if ('budgetCycleStartDay' in patch && patch.budgetCycleStartDay !== undefined) {
    current.budgetCycleStartDay = Math.min(28, Math.max(1, Math.trunc(patch.budgetCycleStartDay)));
  }
  if (patch.sourceBudgets) {
    const existing = (typeof current.sourceBudgets === 'object' && current.sourceBudgets !== null
      ? current.sourceBudgets : {}) as Record<string, unknown>;
    for (const k of ['claude', 'copilot', 'cursor'] as const) {
      if (k in patch.sourceBudgets) existing[k] = patch.sourceBudgets[k] ?? null;
    }
    current.sourceBudgets = existing;
  }

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
  resetConfigCache();
  return { path };
}
```

Add `dirname` to the `node:path` import.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --test tests/config-budget.test.ts`
Expected: PASS (all 4).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/config.ts tests/config-budget.test.ts
git commit -m "feat(config): sourceBudgets model + saveBudgetConfig writer"
```

---

### Task 2: `buildBudget` per-source breakdown

**Files:**
- Modify: `src/lib/feature-aggregate.ts:28` (export `SOURCE_VALUES`)
- Modify: `src/dashboard/data/budget.ts` (add types, refactor to a pure status computer, add per-source loop)
- Test: `tests/budget.test.ts` (extend)

**Interfaces:**
- Consumes: `SourceBudgets` (Task 1), `SOURCE_VALUES` from feature-aggregate.
- Produces: `BudgetReport`, `SourceBudgetStatus`, `BudgetSourceKey` (see Type contract). `buildBudget(db, { budgetUsd, cycleStartDay, sourceBudgets?, today? }): BudgetReport | null`.

- [ ] **Step 1: Write the failing test** (append to `tests/budget.test.ts`)

```ts
import { runMigrations as _rm } from '../src/db/migrations.js'; // already imported above

describe('buildBudget per-source', () => {
  function freshDb() {
    const db = new Database(':memory:');
    runMigrations(db);
    return db;
  }

  test('returns sources[] only for configured caps, cycle-scoped', () => {
    const db = freshDb();
    seedEvent(db, 'a', '2026-08-02', 40);   // claude (source jsonl)
    db.prepare(`INSERT INTO usage_events (id, session_id, timestamp, model, estimated_cost_usd, source)
                VALUES ('c1','s','2026-08-02T12:00:00.000Z','gpt','10','copilot')`).run();
    seedCursorDay(db, '2026-08-02', 5);
    const r = buildBudget(db, {
      budgetUsd: 200, cycleStartDay: 1, today: '2026-08-10',
      sourceBudgets: { claude: 150, copilot: null, cursor: 20 },
    })!;
    assert.equal(r.spentUsd, 55);                 // global blends all three
    const keys = r.sources.map((s) => s.key);
    assert.deepEqual(keys, ['claude', 'cursor']); // copilot has no cap → omitted
    const claude = r.sources.find((s) => s.key === 'claude')!;
    assert.equal(claude.spentUsd, 40);
    assert.equal(claude.budgetUsd, 150);
    const cursor = r.sources.find((s) => s.key === 'cursor')!;
    assert.equal(cursor.spentUsd, 5);
  });

  test('null when neither global nor any source cap is set', () => {
    const db = freshDb();
    assert.equal(buildBudget(db, { budgetUsd: null, cycleStartDay: 1,
      sourceBudgets: { claude: null, copilot: null, cursor: null } }), null);
  });

  test('source cap with no global budget still returns a report', () => {
    const db = freshDb();
    seedEvent(db, 'a', '2026-08-02', 40);
    const r = buildBudget(db, { budgetUsd: null, cycleStartDay: 1, today: '2026-08-10',
      sourceBudgets: { claude: 150, copilot: null, cursor: null } });
    assert.ok(r);
    assert.equal(r!.budgetUsd, 0);          // no global → 0 (UI hides global bar)
    assert.equal(r!.sources.length, 1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test tests/budget.test.ts`
Expected: FAIL — `sourceBudgets` opt not accepted / `r.sources` undefined.

- [ ] **Step 3: Export the source mapping**

In `src/lib/feature-aggregate.ts`, change `const SOURCE_VALUES` (:28) to `export const SOURCE_VALUES`.

- [ ] **Step 4: Refactor budget.ts to a pure status computer + per-source loop**

Add the new types (top of file) and a pure `computeStatus`, then rewrite `buildBudget`:

```ts
import { SOURCE_VALUES } from '../../lib/feature-aggregate.js';
import type { SourceBudgets } from '../../lib/config.js';

export type BudgetSourceKey = 'claude' | 'copilot' | 'cursor';
export type SourceBudgetStatus = BudgetStatus & { key: BudgetSourceKey; label: string };
export type BudgetReport = BudgetStatus & { sources: SourceBudgetStatus[] };

const SOURCE_LABELS: Record<BudgetSourceKey, string> = {
  claude: 'Claude Code', copilot: 'Copilot', cursor: 'Cursor',
};

// Pure: spend + budget + cycle position → the full status shape. Shared by the
// global budget and every per-source cap so the state logic can't diverge.
function computeStatus(
  spentUsd: number, budgetUsd: number, daysElapsed: number, daysInCycle: number,
  cycleStart: string, cycleEnd: string,
): BudgetStatus {
  const projectedUsd = round2(daysElapsed > 0 ? (spentUsd / daysElapsed) * daysInCycle : spentUsd);
  const pctUsed = round1((spentUsd / budgetUsd) * 100);
  const projectedPct = round1((projectedUsd / budgetUsd) * 100);
  const projectionReliable = daysElapsed >= PROJECTION_MIN_DAYS;
  const state: BudgetStatus['state'] = projectionReliable
    ? (pctUsed >= 100 || projectedPct > 100 ? 'over' : projectedPct >= 80 ? 'warn' : 'ok')
    : (pctUsed >= 100 ? 'over' : pctUsed >= 80 ? 'warn' : 'ok');
  return { budgetUsd, cycleStart, cycleEnd, spentUsd, projectedUsd, pctUsed,
    projectedPct, daysElapsed, daysInCycle, projectionReliable, state };
}

// Cycle-to-date spend for one source, using the SAME source→spend mapping as
// the per-harness overview (SOURCE_VALUES for usage_events; cursor_daily_cost
// for Cursor).
function sourceSpend(db: DatabaseType.Database, key: BudgetSourceKey, start: string, end: string): number {
  if (key === 'cursor') {
    return (db.prepare(`SELECT COALESCE(SUM(usd),0) AS u FROM cursor_daily_cost WHERE date >= ? AND date < ?`)
      .get(start, end) as { u: number }).u;
  }
  const vals = SOURCE_VALUES[key];                      // fixed whitelist, no injection
  const ph = vals.map(() => '?').join(',');
  return (db.prepare(
    `SELECT COALESCE(SUM(estimated_cost_usd),0) AS u FROM usage_events
      WHERE source IN (${ph}) AND date(timestamp) >= ? AND date(timestamp) < ?`
  ).get(...vals, start, end) as { u: number }).u;
}
```

Rewrite `buildBudget`'s signature and body:

```ts
export function buildBudget(
  db: DatabaseType.Database,
  opts: { budgetUsd: number | null; cycleStartDay: number; sourceBudgets?: SourceBudgets; today?: string }
): BudgetReport | null {
  const sb: SourceBudgets = opts.sourceBudgets ?? { claude: null, copilot: null, cursor: null };
  const hasGlobal = !!opts.budgetUsd && opts.budgetUsd > 0;
  const configuredSources = (Object.keys(sb) as BudgetSourceKey[]).filter((k) => sb[k] && sb[k]! > 0);
  if (!hasGlobal && configuredSources.length === 0) return null;

  const today = opts.today ??
    (db.prepare(`SELECT date('now', 'localtime') AS d`).get() as { d: string }).d;
  const { cycleStart, cycleEnd, daysElapsed, daysInCycle } = cycleBounds(today, opts.cycleStartDay);

  // Global blended spend (unchanged behavior): usage_events + cursor_daily_cost.
  const ueAll = (db.prepare(
    `SELECT COALESCE(SUM(estimated_cost_usd),0) AS u FROM usage_events
      WHERE date(timestamp) >= ? AND date(timestamp) < ?`).get(cycleStart, cycleEnd) as { u: number }).u;
  const curAll = (db.prepare(
    `SELECT COALESCE(SUM(usd),0) AS u FROM cursor_daily_cost
      WHERE date >= ? AND date < ?`).get(cycleStart, cycleEnd) as { u: number }).u;
  const globalSpent = round2(ueAll + curAll);

  // When there's no global budget we still return a report (for the source
  // caps); budgetUsd 0 signals "no global bar" to every UI.
  const global = computeStatus(globalSpent, hasGlobal ? opts.budgetUsd! : 0, daysElapsed, daysInCycle, cycleStart, cycleEnd);

  const sources: SourceBudgetStatus[] = configuredSources.map((key) => {
    const spent = round2(sourceSpend(db, key, cycleStart, cycleEnd));
    const s = computeStatus(spent, sb[key]!, daysElapsed, daysInCycle, cycleStart, cycleEnd);
    return { ...s, key, label: SOURCE_LABELS[key] };
  });

  return { ...global, sources };
}
```

Note: guarding `hasGlobal ? budgetUsd! : 0` avoids divide-by-zero producing `Infinity` pct — `computeStatus` with `budgetUsd 0` yields `pctUsed = Infinity`; clamp inside `computeStatus` when `budgetUsd <= 0` by returning `pctUsed: 0, projectedPct: 0, state: 'ok'`. Add at the top of `computeStatus`:

```ts
  if (budgetUsd <= 0) {
    const projectedUsd = round2(daysElapsed > 0 ? (spentUsd / daysElapsed) * daysInCycle : spentUsd);
    return { budgetUsd: 0, cycleStart, cycleEnd, spentUsd, projectedUsd, pctUsed: 0,
      projectedPct: 0, daysElapsed, daysInCycle, projectionReliable: daysElapsed >= PROJECTION_MIN_DAYS, state: 'ok' };
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --test tests/budget.test.ts`
Expected: PASS (existing cycleBounds + new per-source cases). Existing single-budget tests still pass because global fields remain flat.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (any `buildBudget(...)` caller referencing the old `BudgetStatus | null` return still compiles — `BudgetReport` extends `BudgetStatus`).

- [ ] **Step 7: Commit**

```bash
git add src/lib/feature-aggregate.ts src/dashboard/data/budget.ts tests/budget.test.ts
git commit -m "feat(budget): per-source breakdown via shared source→spend map"
```

---

### Task 3: API carries `budget.sources[]`

**Files:**
- Modify: `src/dashboard/data/api.ts:69` (type), `:104-106` (cache key), `:177-181` (assembly)
- Test: `tests/api-budget.test.ts` (create)

**Interfaces:**
- Consumes: `BudgetReport` (Task 2), `getConfig().sourceBudgets` (Task 1).
- Produces: `TodayResponse.budget: BudgetReport | null`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/api-budget.test.ts
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/db/migrations.js';
import { buildToday } from '../src/dashboard/data/api.js';
import { resetConfigCache } from '../src/lib/config.js';

let dir: string;
const prev = process.env.TOKENTRAIL_CONFIG;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tt-api-')); });
afterEach(() => {
  if (prev === undefined) delete process.env.TOKENTRAIL_CONFIG; else process.env.TOKENTRAIL_CONFIG = prev;
  resetConfigCache(); rmSync(dir, { recursive: true, force: true });
});

test('TodayResponse.budget carries per-source caps from config', () => {
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ monthlyBudgetUsd: 200, sourceBudgets: { claude: 150 } }));
  process.env.TOKENTRAIL_CONFIG = cfg; resetConfigCache();
  const db = new Database(':memory:'); runMigrations(db);
  db.prepare(`INSERT INTO usage_events (id, session_id, timestamp, model, estimated_cost_usd, source)
              VALUES ('a','s',date('now','localtime')||'T12:00:00Z','claude','40','jsonl')`).run();
  const t = buildToday(db);
  assert.ok(t.budget);
  assert.equal(t.budget!.sources.length, 1);
  assert.equal(t.budget!.sources[0].key, 'claude');
});
```

(Confirm the API entry is named `buildToday`; if it differs, match the real export — grep `export function` in `api.ts`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test tests/api-budget.test.ts`
Expected: FAIL — `sources` missing (buildBudget not passed `sourceBudgets`).

- [ ] **Step 3: Wire config through**

In `src/dashboard/data/api.ts`:
- Change the type import/usage: `budget: BudgetReport | null;` (import `BudgetReport` from `./budget.js`).
- Cache key (:106) — include source caps:

```ts
const sb = cfg.sourceBudgets;
const cacheKey = `${todayCacheKey(db)};hidden=${hidden.join(',')};budget=${cfg.monthlyBudgetUsd}:${cfg.budgetCycleStartDay}:${sb.claude},${sb.copilot},${sb.cursor}`;
```

- Assembly (:177):

```ts
    budget: buildBudget(db, {
      budgetUsd: cfg.monthlyBudgetUsd,
      cycleStartDay: cfg.budgetCycleStartDay,
      sourceBudgets: cfg.sourceBudgets,
    }),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test tests/api-budget.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc --noEmit && node --import tsx --test tests/*.test.ts`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/data/api.ts tests/api-budget.test.ts
git commit -m "feat(api): today.budget carries per-source caps"
```

---

### Task 4: Web Budget sidebar card (Overview)

**Files:**
- Modify: `src/dashboard/data/overview.ts` (OverviewVM type :26, `buildOverview` :138 — add `budget`)
- Create: `src/dashboard/render/budget-card.ts`
- Modify: `src/dashboard/render/overview.ts` (insert card between "Trail so far" and "This week")
- Modify: `src/dashboard/static/dashboard.css` (card styles)
- Test: `tests/budget-card-render.test.ts` (create)

**Interfaces:**
- Consumes: `BudgetReport` (Task 2), `getConfig()`.
- Produces: `renderBudgetCard(budget: BudgetReport | null): string`; `OverviewVM.budget: BudgetReport | null`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/budget-card-render.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBudgetCard } from '../src/dashboard/render/budget-card.js';
import type { BudgetReport } from '../src/dashboard/data/budget.js';

const base = {
  budgetUsd: 200, cycleStart: '2026-08-01', cycleEnd: '2026-09-01',
  spentUsd: 88, projectedUsd: 180, pctUsed: 44, projectedPct: 90,
  daysElapsed: 12, daysInCycle: 31, projectionReliable: true, state: 'warn' as const,
};

describe('renderBudgetCard', () => {
  test('empty state links to settings when null', () => {
    const html = renderBudgetCard(null);
    assert.match(html, /Set a monthly budget/);
    assert.match(html, /\/settings#budget/);
  });

  test('configured: shows spent/budget, projected, and a per-source row', () => {
    const r: BudgetReport = { ...base, sources: [
      { ...base, key: 'claude', label: 'Claude Code', budgetUsd: 150, spentUsd: 60, pctUsed: 40 },
    ]};
    const html = renderBudgetCard(r);
    assert.match(html, /\$88 \/ \$200/);
    assert.match(html, /90%/);
    assert.match(html, /Claude Code/);
    assert.match(html, /budget-state-warn/);  // state class drives the tint
  });

  test('too-early forecast when projection unreliable', () => {
    const html = renderBudgetCard({ ...base, projectionReliable: false, sources: [] });
    assert.match(html, /too early/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test tests/budget-card-render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `renderBudgetCard`**

```ts
// src/dashboard/render/budget-card.ts
import type { BudgetReport, BudgetStatus, SourceBudgetStatus } from '../data/budget.js';

const usd0 = (n: number) => '$' + Math.round(n);

// Filled = spent%, caret = projected% (only when it exceeds spend and is reliable).
function bar(b: BudgetStatus): string {
  const spentFrac = Math.min(100, Math.max(0, b.pctUsed));
  const projFrac = b.projectionReliable ? Math.min(100, Math.max(0, b.projectedPct)) : spentFrac;
  const caret = projFrac > spentFrac
    ? `<span class="budget-caret" style="left:${projFrac}%"></span>` : '';
  return `<div class="budget-bar budget-state-${b.state}">
    <span class="budget-fill" style="width:${spentFrac}%"></span>${caret}
  </div>`;
}

function sourceRow(s: SourceBudgetStatus): string {
  return `<li class="budget-source budget-state-${s.state}">
    <span class="budget-source-label">${s.label}</span>
    ${bar(s)}
    <span class="budget-source-figs">${usd0(s.spentUsd)} / ${usd0(s.budgetUsd)}</span>
  </li>`;
}

export function renderBudgetCard(budget: BudgetReport | null): string {
  if (!budget) {
    return `<div class="card budget-card">
      <div class="label">Budget</div>
      <div class="muted">Set a monthly budget to track burn rate.</div>
      <div class="footer-link"><a href="/settings#budget">Set a budget →</a></div>
    </div>`;
  }
  const hasGlobal = budget.budgetUsd > 0;
  const projLine = !hasGlobal ? ''
    : budget.projectionReliable
      ? `<div class="muted">projected ${usd0(budget.projectedUsd)} · ${Math.round(budget.projectedPct)}%</div>`
      : `<div class="muted">too early to forecast</div>`;
  const globalBlock = hasGlobal ? `
    ${bar(budget)}
    <div class="budget-figs">${usd0(budget.spentUsd)} / ${usd0(budget.budgetUsd)}</div>
    ${projLine}` : '';
  const sourceBlock = budget.sources.length
    ? `<ul class="budget-sources">${budget.sources.map(sourceRow).join('')}</ul>` : '';
  return `<div class="card budget-card">
    <div class="label">Budget</div>
    ${globalBlock}
    ${sourceBlock}
  </div>`;
}
```

- [ ] **Step 4: Add `budget` to the Overview VM**

In `src/dashboard/data/overview.ts`:
- Add to `OverviewVM`: `budget: import('./budget.js').BudgetReport | null;` (or a top-of-file import).
- In `buildOverview`, near the return, compute it (import `getConfig` and `buildBudget`):

```ts
  const cfg = getConfig();
  const budget = buildBudget(db, {
    budgetUsd: cfg.monthlyBudgetUsd, cycleStartDay: cfg.budgetCycleStartDay, sourceBudgets: cfg.sourceBudgets,
  });
```

Add `budget` to the returned object.

- [ ] **Step 5: Insert the card in the overview render**

In `src/dashboard/render/overview.ts`, import `renderBudgetCard`, and between the "Trail so far" hero-card (`:36`) and the "This week" card (`:38`) insert:

```ts
    ${renderBudgetCard(vm.budget)}
```

- [ ] **Step 6: Add CSS**

Append to `src/dashboard/static/dashboard.css` (uses existing theme tokens):

```css
.budget-card .budget-bar { position: relative; height: 6px; border-radius: 3px;
  background: var(--color-fill-track); overflow: hidden; margin: 6px 0; }
.budget-card .budget-fill { position: absolute; inset: 0 auto 0 0; height: 100%;
  background: var(--color-accent); }
.budget-state-warn .budget-fill { background: var(--color-warm); }
.budget-state-over .budget-fill { background: var(--color-warm-deep); }
.budget-card .budget-caret { position: absolute; top: -1px; width: 2px; height: 8px;
  background: var(--color-ink); transform: translateX(-1px); }
.budget-card .budget-figs { font-family: var(--font-mono); font-size: var(--size-small); }
.budget-sources { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }
.budget-source { display: grid; grid-template-columns: 1fr; gap: 2px; font-size: var(--size-small); }
.budget-source-label { color: var(--color-ink-muted); }
.budget-source-figs { font-family: var(--font-mono); color: var(--color-ink-subtle); }
```

(The `budget-bar` caret color is `--color-ink`; overflow is hidden so the fill clips — the caret sits above via `top:-1px` outside the clip since it's a sibling, not inside `.budget-fill`. If overflow clips the caret, move `.budget-caret` out of the bar into a wrapper; verify in Step 8.)

- [ ] **Step 7: Run the render test**

Run: `node --import tsx --test tests/budget-card-render.test.ts`
Expected: PASS.

- [ ] **Step 8: Visual check (dev server)**

Run: `npm run dev -- dashboard` then open `http://127.0.0.1:4920/`. Confirm: with a budget set, the card sits between "Trail so far" and "This week", bar + caret render, per-source rows appear; toggle dark mode — colors track tokens. With no budget, the empty state + `/settings#budget` link show. Stop the dev server.

- [ ] **Step 9: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/dashboard/data/overview.ts src/dashboard/render/budget-card.ts src/dashboard/render/overview.ts src/dashboard/static/dashboard.css tests/budget-card-render.test.ts
git commit -m "feat(web): budget sidebar card on the overview"
```

---

### Task 5: Web Settings "Budget" fieldset + `POST /api/budget`

**Files:**
- Modify: `src/dashboard/data/settings.ts` (SettingsViewModel + `buildSettingsVM` — add budget values)
- Modify: `src/dashboard/render/settings.ts` (Budget fieldset with `id="budget"`)
- Modify: `src/dashboard/static/settings.js` (budget form submit)
- Modify: `src/dashboard/server.ts` (`POST /api/budget`)
- Test: `tests/settings-budget.test.ts` (create; VM prefill + endpoint validation)

**Interfaces:**
- Consumes: `getConfig()` (Task 1), `saveBudgetConfig` (Task 1).
- Produces: `SettingsViewModel.budget: { monthlyBudgetUsd: number | null; budgetCycleStartDay: number; sourceBudgets: SourceBudgets }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/settings-budget.test.ts
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSettingsVM } from '../src/dashboard/data/settings.js';
import { saveBudgetConfig, resetConfigCache } from '../src/lib/config.js';

let dir: string, cfg: string;
const prev = process.env.TOKENTRAIL_CONFIG;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tt-set-')); cfg = join(dir, 'config.json');
  process.env.TOKENTRAIL_CONFIG = cfg; resetConfigCache(); });
afterEach(() => { if (prev === undefined) delete process.env.TOKENTRAIL_CONFIG; else process.env.TOKENTRAIL_CONFIG = prev;
  resetConfigCache(); rmSync(dir, { recursive: true, force: true }); });

test('settings VM pre-fills budget values from config', () => {
  writeFileSync(cfg, JSON.stringify({ monthlyBudgetUsd: 200, budgetCycleStartDay: 5, sourceBudgets: { claude: 150 } }));
  resetConfigCache();
  const vm = buildSettingsVM();
  assert.equal(vm.budget.monthlyBudgetUsd, 200);
  assert.equal(vm.budget.budgetCycleStartDay, 5);
  assert.equal(vm.budget.sourceBudgets.claude, 150);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test tests/settings-budget.test.ts`
Expected: FAIL — `vm.budget` undefined.

- [ ] **Step 3: Extend the settings VM**

In `src/dashboard/data/settings.ts`, add to `SettingsViewModel`:

```ts
  budget: {
    monthlyBudgetUsd: number | null;
    budgetCycleStartDay: number;
    sourceBudgets: import('../../lib/config.js').SourceBudgets;
  };
```

In `buildSettingsVM`, read `getConfig()` (import it) and add to the returned object:

```ts
    budget: {
      monthlyBudgetUsd: cfg.monthlyBudgetUsd,
      budgetCycleStartDay: cfg.budgetCycleStartDay,
      sourceBudgets: cfg.sourceBudgets,
    },
```

- [ ] **Step 4: Run VM test to verify it passes**

Run: `node --import tsx --test tests/settings-budget.test.ts`
Expected: PASS.

- [ ] **Step 5: Render the Budget fieldset**

In `src/dashboard/render/settings.ts`, add before the LLM `<form>` (a standalone form so it saves independently, mirroring hidden-projects). Insert after `${hiddenProjectsUI}`:

```ts
  ${renderBudgetFieldset(vm)}
```

And add the helper in the same file:

```ts
function num(v: number | null): string { return v == null ? '' : String(v); }

function renderBudgetFieldset(vm: SettingsViewModel): string {
  const b = vm.budget;
  return `
  <form id="budget-form">
    <fieldset id="budget">
      <legend>Budget</legend>
      <p class="hidden-projects-hint">Monthly spend caps (estimated). Leave a field blank for no cap.</p>
      <label>Monthly budget $ <input name="monthlyBudgetUsd" type="number" min="0" step="1" value="${num(b.monthlyBudgetUsd)}"></label>
      <label>Cycle start day <input name="budgetCycleStartDay" type="number" min="1" max="28" step="1" value="${b.budgetCycleStartDay}"></label>
      <label>Claude Code cap $ <input name="claude" type="number" min="0" step="1" value="${num(b.sourceBudgets.claude)}"></label>
      <label>Copilot cap $ <input name="copilot" type="number" min="0" step="1" value="${num(b.sourceBudgets.copilot)}"></label>
      <label>Cursor cap $ <input name="cursor" type="number" min="0" step="1" value="${num(b.sourceBudgets.cursor)}"></label>
      <button type="submit">Save budget</button>
    </fieldset>
  </form>`;
}
```

- [ ] **Step 6: Client submit handler**

Append to `src/dashboard/static/settings.js`:

```js
// Budget form: blank field = null (no cap). Numbers post to /api/budget.
const budgetForm = document.getElementById('budget-form');
if (budgetForm) {
  budgetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(budgetForm);
    const numOrNull = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : Number(s); };
    const body = {
      monthlyBudgetUsd: numOrNull(fd.get('monthlyBudgetUsd')),
      budgetCycleStartDay: Number(fd.get('budgetCycleStartDay') || 1),
      sourceBudgets: {
        claude: numOrNull(fd.get('claude')),
        copilot: numOrNull(fd.get('copilot')),
        cursor: numOrNull(fd.get('cursor')),
      },
    };
    const r = await fetch('/api/budget', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r.ok) location.reload();
    else { const o = await r.json().catch(() => ({})); alert('Save failed: ' + (o.error || r.status)); }
  });
}
```

- [ ] **Step 7: Add `POST /api/budget` with validation**

In `src/dashboard/server.ts`, near the other settings routes (after `/api/settings`), add (import `saveBudgetConfig`):

```ts
  app.post('/api/budget', async (req, reply) => {
    const body = req.body as {
      monthlyBudgetUsd?: unknown; budgetCycleStartDay?: unknown;
      sourceBudgets?: { claude?: unknown; copilot?: unknown; cursor?: unknown };
    };
    const posOrNull = (v: unknown): number | null | undefined => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return undefined; // undefined = invalid
      return n;
    };
    const patch: import('../lib/config.js').BudgetPatch = {};
    if ('monthlyBudgetUsd' in body) {
      const m = posOrNull(body.monthlyBudgetUsd);
      if (m === undefined) { reply.code(400); return { error: 'monthlyBudgetUsd must be >= 0 or blank' }; }
      patch.monthlyBudgetUsd = m;
    }
    if ('budgetCycleStartDay' in body && body.budgetCycleStartDay != null) {
      const d = Number(body.budgetCycleStartDay);
      if (!Number.isInteger(d) || d < 1 || d > 28) { reply.code(400); return { error: 'budgetCycleStartDay must be 1-28' }; }
      patch.budgetCycleStartDay = d;
    }
    if (body.sourceBudgets) {
      const sb: Partial<import('../lib/config.js').SourceBudgets> = {};
      for (const k of ['claude', 'copilot', 'cursor'] as const) {
        if (k in body.sourceBudgets) {
          const v = posOrNull((body.sourceBudgets as Record<string, unknown>)[k]);
          if (v === undefined) { reply.code(400); return { error: `${k} cap must be >= 0 or blank` }; }
          sb[k] = v;
        }
      }
      patch.sourceBudgets = sb;
    }
    try {
      const { path } = saveBudgetConfig(patch);
      return { ok: true, path };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
```

- [ ] **Step 8: Add an endpoint validation test** (append to `tests/settings-budget.test.ts`)

```ts
import { buildDashboard } from '../src/dashboard/server.js'; // adjust to real factory export

test('POST /api/budget rejects out-of-range cycle day', async () => {
  const app = buildDashboard(/* opts as the real factory needs; use an in-memory db */);
  const res = await app.inject({ method: 'POST', url: '/api/budget',
    payload: { budgetCycleStartDay: 40 } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /api/budget saves and round-trips', async () => {
  const app = buildDashboard(/* ... */);
  const res = await app.inject({ method: 'POST', url: '/api/budget',
    payload: { monthlyBudgetUsd: 120, sourceBudgets: { cursor: 25 } } });
  assert.equal(res.statusCode, 200);
  resetConfigCache();
  const raw = JSON.parse(readFileSync(cfg, 'utf-8'));
  assert.equal(raw.monthlyBudgetUsd, 120);
  assert.equal(raw.sourceBudgets.cursor, 25);
  await app.close();
});
```

Before writing this step, grep `server.ts` for the actual app factory export name and its required options (db handle, defaultDays). Match the signature the existing server tests use — if there is no existing server-injection test, model the Fastify instance the same way `createServer`/`buildDashboard` is constructed in `server.ts`, pointing `TOKENTRAIL_CONFIG` at the temp `cfg`.

- [ ] **Step 9: Run the settings tests**

Run: `node --import tsx --test tests/settings-budget.test.ts`
Expected: PASS.

- [ ] **Step 10: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/dashboard/data/settings.ts src/dashboard/render/settings.ts src/dashboard/static/settings.js src/dashboard/server.ts tests/settings-budget.test.ts
git commit -m "feat(web): settings budget fieldset + POST /api/budget"
```

---

### Task 6: CLI per-source block

**Files:**
- Modify: `src/commands/budget.ts`
- Test: covered by `tests/budget.test.ts` (data) + a render smoke check here

**Interfaces:**
- Consumes: `BudgetReport` (Task 2), `getConfig().sourceBudgets`.

- [ ] **Step 1: Pass `sourceBudgets` into the command**

In `src/commands/budget.ts`, extend the `buildBudget` call:

```ts
  const b = buildBudget(db, {
    budgetUsd: cfg.monthlyBudgetUsd,
    cycleStartDay: cfg.budgetCycleStartDay,
    sourceBudgets: cfg.sourceBudgets,
  });
```

- [ ] **Step 2: Print the per-source block**

After the global `console.log('  (estimated · Claude + Copilot + Cursor)');` line, insert (before it, so the estimated tag stays last):

```ts
  if (b.sources.length) {
    console.log('');
    console.log('  By source:');
    for (const s of b.sources) {
      const sbar = renderBar(s.pctUsed, s.projectedPct);
      const stag = s.state === 'over' ? ' ⚠ over' : s.state === 'warn' ? ' ⚠ trending over' : '';
      const proj = s.projectionReliable ? `  →${usd(s.projectedUsd)} (${s.projectedPct}%)` : '';
      console.log(`    ${s.label.padEnd(12)} ${sbar} ${usd(s.spentUsd)}/${usd(s.budgetUsd)}${proj}${stag}`);
    }
  }
```

Note `usd` is defined in `runBudget`'s scope — keep the block inside `runBudget` after `b` is known.

Also guard the case where there's no global budget but source caps exist: the current early-return prints "No budget set" only when `!b`. Since `buildBudget` now returns a report when only source caps exist (global `budgetUsd = 0`), branch the global print so it's skipped when `b.budgetUsd === 0`:

```ts
  if (b.budgetUsd > 0) {
    // ... existing global bar / Spent / Projected lines ...
  } else {
    console.log('Budget — per-source caps only (no global budget)');
    console.log('─'.repeat(64));
  }
```

- [ ] **Step 3: Manual smoke test**

Run: `node --import tsx src/index.ts budget` (or the built CLI) with a config that sets `monthlyBudgetUsd` + a `sourceBudgets.claude`. Confirm the global block prints, then a "By source:" block with the Claude row. With no budget at all, confirm the existing "No budget set" help still prints.

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/commands/budget.ts
git commit -m "feat(cli): per-source budget block in tokentrail budget"
```

---

### Task 7: Native — Decodable + enriched view + empty state

**Files:**
- Modify: `scripts/menubar-native/Sources/Tokentrail.swift` (`Budget` struct :32, `budgetView` :675, panel body :546, `Store`/app-entry for notifications in Task 8)

**Interfaces:**
- Consumes: `/api/today` `budget.sources[]` (Task 3).
- Produces: `struct SourceBudget`, enriched `budgetView`, empty-state row.

- [ ] **Step 1: Extend the Decodable model**

In `Tokentrail.swift`, add after the `Budget` struct:

```swift
struct SourceBudget: Decodable, Identifiable {
    let key: String
    let label: String
    let budgetUsd: Double
    let spentUsd: Double
    let projectedUsd: Double
    let pctUsed: Double
    let projectedPct: Double
    let projectionReliable: Bool
    let state: String
    var id: String { key }
}
```

Add `let sources: [SourceBudget]` to `struct Budget`. (JSON always includes `sources` — Task 3 sends `[]` when empty — so it's non-optional; if you want resilience against an old daemon, make it `let sources: [SourceBudget]?` and coalesce with `?? []` at use sites. Prefer optional for release-skew safety, matching the codebase's "degrade gracefully against old server" pattern.)

- [ ] **Step 2: Enrich `budgetView`**

Replace the header row and add a cycle sub-line + per-source rows. Inside `budgetView(_ b: Budget)`, after the projected/state `HStack` (before the closing `}` of the outer `VStack`), append:

```swift
            Text("\(Fmt.monthDay(b.cycleStart)) – \(Fmt.monthDay(b.cycleEnd)) · day \(b.daysElapsed)/\(b.daysInCycle)")
                .font(.system(size: 10)).foregroundStyle(.tertiary)
            ForEach((b.sources ?? [])) { s in sourceBudgetRow(s) }
```

Add the row builder:

```swift
    private func sourceBudgetRow(_ s: SourceBudget) -> some View {
        let tint: Color = s.state == "over" ? Color(hex: "#b5533f")
            : s.state == "warn" ? Color(hex: "#b88a3a") : Color(hex: "#5f6f5e")
        let frac = min(1.0, max(0.0, s.pctUsed / 100.0))
        return HStack(spacing: 6) {
            Text(s.label).font(.system(size: 10)).foregroundStyle(.secondary).frame(width: 78, alignment: .leading)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.18))
                    Capsule().fill(tint).frame(width: max(2, geo.size.width * frac))
                }
            }.frame(height: 4)
            Text("\(Fmt.usd(s.spentUsd))/\(Fmt.usd(s.budgetUsd))")
                .font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
        }
    }
```

(Confirm `Fmt.monthDay` accepts a `YYYY-MM-DD` string; the anomaly view already calls `Fmt.monthDay(a.date)` at :738, so it does.)

- [ ] **Step 3: Add the empty state**

In the panel body (`:546`), replace:

```swift
                    if sourceTab == .all, let b = t.budget { budgetView(b) }
```

with:

```swift
                    if sourceTab == .all {
                        if let b = t.budget { budgetView(b) } else { budgetEmptyView() }
                    }
```

Add:

```swift
    private func budgetEmptyView() -> some View {
        Link(destination: URL(string: Api.base + "/settings#budget")!) {
            HStack(spacing: 6) {
                Image(systemName: "target").font(.system(size: 11)).foregroundStyle(.secondary)
                Text("Set a budget in Settings").font(.system(size: 12)).foregroundStyle(.secondary)
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 10)).foregroundStyle(.tertiary)
            }
        }.buttonStyle(.plain)
    }
```

- [ ] **Step 4: Build headless + render a PNG to verify**

```bash
bash scripts/menubar-native/build.sh
TT_SOURCE=All scripts/menubar-native/dist/Tokentrail.app/Contents/MacOS/Tokentrail --render-png /tmp/tt-budget.png
```

Point `TT_DASHBOARD_URL` at a daemon whose config has a budget + a source cap; confirm the PNG shows the enriched bar + a per-source row. With no budget, confirm the empty-state row renders. (Segmented picker + Links show as yellow placeholders in ImageRenderer — a known headless artifact.)

- [ ] **Step 5: Commit**

```bash
git add scripts/menubar-native/Sources/Tokentrail.swift
git commit -m "feat(native): enriched budget view + per-source rows + empty state"
```

---

### Task 8: Native — threshold notifications (pure `newlyCrossed` + wiring)

**Files:**
- Modify: `scripts/menubar-native/Sources/Tokentrail.swift` (add `newlyCrossed`, `Store.refresh` hook, auth request, `--selftest-notifications` entry)

**Interfaces:**
- Consumes: `Budget` + `SourceBudget` (Task 7).
- Produces: pure `func newlyCrossed(prevMarkers: Set<String>, statuses: [(key: String, pctUsed: Double, cycleStart: String)]) -> (fired: [(key: String, threshold: Int)], next: Set<String>)`.

- [ ] **Step 1: Write the pure decision function**

Add near the top-level helpers:

```swift
// Pure threshold-crossing decision. For each budget (global + sources), fire a
// notification the FIRST time cycle-to-date pctUsed crosses 80 or 100 within a
// cycle. Markers are keyed "<cycleStart>:<key>:<threshold>" so they auto-expire
// when the cycle rolls (a new cycleStart yields fresh keys). Uses actual spend
// (pctUsed), never the noisy projection. Testable without UNUserNotification.
func newlyCrossed(
    prevMarkers: Set<String>,
    statuses: [(key: String, pctUsed: Double, cycleStart: String)]
) -> (fired: [(key: String, threshold: Int)], next: Set<String>) {
    var next = prevMarkers
    var fired: [(key: String, threshold: Int)] = []
    for s in statuses {
        for threshold in [80, 100] {
            let marker = "\(s.cycleStart):\(s.key):\(threshold)"
            if s.pctUsed >= Double(threshold) && !next.contains(marker) {
                next.insert(marker)
                fired.append((key: s.key, threshold: threshold))
            }
        }
    }
    return (fired, next)
}
```

- [ ] **Step 2: Add a `--selftest-notifications` entry that asserts and exits**

In `enum Main`, before `TokentrailApp.main()` dispatch:

```swift
        if CommandLine.arguments.contains("--selftest-notifications") {
            runNotificationSelftest()
            return
        }
```

Add:

```swift
    static func runNotificationSelftest() {
        func check(_ cond: Bool, _ msg: String) {
            if !cond { FileHandle.standardError.write("FAIL: \(msg)\n".data(using: .utf8)!); exit(1) }
        }
        // First crossing of 80 fires; 100 not yet.
        var (fired, markers) = newlyCrossed(prevMarkers: [], statuses: [("global", 85, "2026-08-01")])
        check(fired.count == 1 && fired[0].threshold == 80, "80 should fire once")
        // Same cycle, same pct: no re-fire.
        (fired, markers) = newlyCrossed(prevMarkers: markers, statuses: [("global", 85, "2026-08-01")])
        check(fired.isEmpty, "no re-fire within a cycle")
        // Crossing 100 now fires only 100.
        (fired, markers) = newlyCrossed(prevMarkers: markers, statuses: [("global", 102, "2026-08-01")])
        check(fired.count == 1 && fired[0].threshold == 100, "100 fires once")
        // New cycle resets — 80 fires again under the new cycleStart.
        (fired, _) = newlyCrossed(prevMarkers: markers, statuses: [("global", 85, "2026-09-01")])
        check(fired.count == 1 && fired[0].threshold == 80, "new cycle re-arms 80")
        FileHandle.standardError.write("selftest-notifications OK\n".data(using: .utf8)!)
        exit(0)
    }
```

- [ ] **Step 3: Run the self-test**

```bash
swiftc -parse-as-library -O -o /tmp/tt-selftest scripts/menubar-native/Sources/Tokentrail.swift
/tmp/tt-selftest --selftest-notifications
```

Expected: prints `selftest-notifications OK`, exit 0. (If it fails, exit 1 with the failing message.)

- [ ] **Step 4: Wire markers + posting into `Store`**

Add `import UserNotifications` at the top. In `Store`:

```swift
    private var budgetMarkers: Set<String> =
        Set(UserDefaults.standard.stringArray(forKey: "budgetMarkers") ?? [])
    private var didRequestAuth = false

    private func maybeNotify(_ t: TodayResponse) {
        guard let b = t.budget else { return }
        if !didRequestAuth {
            didRequestAuth = true
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
        var statuses: [(key: String, pctUsed: Double, cycleStart: String)] = []
        if b.budgetUsd > 0 { statuses.append(("global", b.pctUsed, b.cycleStart)) }
        for s in (b.sources ?? []) { statuses.append((s.key, s.pctUsed, s.cycleStart)) }
        let (fired, next) = newlyCrossed(prevMarkers: budgetMarkers, statuses: statuses)
        if next != budgetMarkers {
            budgetMarkers = next
            UserDefaults.standard.set(Array(next), forKey: "budgetMarkers")
        }
        for f in fired {
            let name = f.key == "global" ? "Budget" : label(for: f.key, in: b)
            let content = UNMutableNotificationContent()
            content.title = f.threshold >= 100 ? "\(name): over budget" : "\(name): trending over"
            content.body = f.threshold >= 100
                ? "Cycle-to-date spend has passed 100% of the cap."
                : "Cycle-to-date spend has passed 80% of the cap."
            let req = UNNotificationRequest(identifier: "tt-\(f.key)-\(f.threshold)-\(b.cycleStart)",
                content: content, trigger: nil)
            UNUserNotificationCenter.current().add(req)
        }
    }

    private func label(for key: String, in b: Budget) -> String {
        (b.sources ?? []).first { $0.key == key }?.label ?? key
    }
```

Call it at the end of the success branch of `refresh()`:

```swift
    func refresh() async {
        do {
            let t = try await Api.fetch()
            today = t
            error = nil
            maybeNotify(t)
        } catch {
            self.error = "dashboard not running"
        }
    }
```

- [ ] **Step 5: Rebuild + confirm it compiles into the bundle**

```bash
bash scripts/menubar-native/build.sh
```

Expected: compiles clean; `dist/Tokentrail.app` built. (Live notification delivery needs a signed/authorized run — the pure logic is covered by the self-test; delivery is verified during the release smoke test.)

- [ ] **Step 6: Commit**

```bash
git add scripts/menubar-native/Sources/Tokentrail.swift
git commit -m "feat(native): budget threshold notifications (once per threshold per cycle)"
```

---

### Task 9: Full suite, typecheck, and release v0.12.0

**Files:** none (verification + release)

- [ ] **Step 1: Full test + typecheck**

Run: `npx tsc --noEmit && node --import tsx --test tests/*.test.ts`
Expected: all green.

- [ ] **Step 2: Native self-test**

Run: `swiftc -parse-as-library -O -o /tmp/tt-selftest scripts/menubar-native/Sources/Tokentrail.swift && /tmp/tt-selftest --selftest-notifications`
Expected: `selftest-notifications OK`.

- [ ] **Step 3: Open a PR, squash-merge** (per tokentrail-release-flow skill).

- [ ] **Step 4: Version bump + release**

```bash
npm version 0.12.0 --no-git-tag-version
git add package.json package-lock.json && git commit -m "release: v0.12.0" && git push
git tag v0.12.0 && git push origin v0.12.0
gh release create v0.12.0 --title "v0.12.0 — budgets everywhere" --notes "Settable budgets + per-source caps on web, CLI, API, and the native app with threshold notifications."
```

- [ ] **Step 5: Wait for tap auto-bump, upgrade, restart daemon**

```bash
cd ~/Projects/homebrew-tokentrail && git pull --ff-only && grep -E 'url |sha256 ' Formula/tokentrail.rb
brew update && brew upgrade tokentrail
launchctl kickstart -k gui/$(id -u)/com.tokentrail.daemon
```

- [ ] **Step 6: Rebuild + swap the native bundle** (required — Swift-side changes):

```bash
cd ~/Projects/tokentrail
bash scripts/menubar-native/build.sh
/usr/bin/pkill -f "Tokentrail.app/Contents/MacOS/Tokentrail" || true
mv ~/Applications/Tokentrail.app ~/Applications/Tokentrail.app.bak-pre-0.12.0
cp -R scripts/menubar-native/dist/Tokentrail.app ~/Applications/Tokentrail.app
launchctl kickstart -k gui/$(id -u)/com.benjaminloschen.tokentrail.menubar
```

- [ ] **Step 7: Verify both layers on 0.12.0**

```bash
curl -s http://127.0.0.1:4920/api/today | jq '.budget.sources'
tokentrail --version
defaults read ~/Applications/Tokentrail.app/Contents/Info.plist CFBundleShortVersionString
```

Expected: daemon and app both read `0.12.0`; `/api/today` `.budget.sources` is an array; the menu-bar panel shows the enriched budget (or empty state).

---

## Self-Review

**Spec coverage:**
- §1 Config model + writer → Task 1. ✔
- §2 buildBudget per-source (shared source→spend map, independent projectionReliable, null only when nothing configured) → Task 2. ✔
- §3 API `sources[]` + cache key includes `sourceBudgets` → Task 3. ✔
- §4 Web Budget sidebar card (configured + empty states, between Trail-so-far and This-week, theme tokens, server-rendered) → Task 4. ✔
- §5 Web Settings Budget fieldset + `POST /api/budget` + VM prefill → Task 5. ✔
- §6 Native Decodable + enriched view + empty state + threshold notifications (pure `newlyCrossed`, UserDefaults markers keyed by cycleStart, auth once) → Tasks 7–8. ✔
- §7 CLI per-source block → Task 6. ✔
- Testing bullets (config round-trip/merge/null/create, per-source sums+null, shared-map parity, notification dedupe/reset, web render + validation) → Tasks 1,2,3,4,5,8. ✔ The "shared source→spend map parity" bullet is implicitly covered by Task 2's per-source sums matching seeded rows; add an explicit parity assertion against the scoped-overview total if desired (optional, low risk).
- Rollout as v0.12.0 with native bundle swap → Task 9. ✔

**Placeholder scan:** No TBD/TODO. Two steps say "adjust to real factory export / grep for the actual name" (Task 5 Step 8, Task 3 Step 1) — these are honest instructions to match an existing symbol whose exact name I could not see, not placeholder logic. Flagged inline with the grep to run.

**Type consistency:** `BudgetReport` (extends `BudgetStatus`, adds `sources`), `SourceBudgetStatus` (`BudgetStatus & {key,label}`), `BudgetSourceKey`, `SourceBudgets`, `BudgetPatch` used consistently across Tasks 1–6. Swift `SourceBudget` mirrors `SourceBudgetStatus`'s JSON. `newlyCrossed` signature identical in Task 8 Steps 1, 2, 4. `saveBudgetConfig`/`resetConfigCache`/`loadConfigFrom` names match `config.ts`.

**Ambiguity resolved:** budget card renders on **all** overview scopes (global concept), but the empty-state's discoverability matters most on the default `all` view; native restricts its budget block to the `.all` tab (matching existing code). Global `budgetUsd = 0` is the sentinel for "no global bar, source caps only" across web card, CLI, and native.
