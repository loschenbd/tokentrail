# Budgets everywhere: web UI, settable config, per-source caps, menubar alerts

**Date:** 2026-08-01
**Status:** Approved design → implementation plan next
**Feature area:** budgets / burn-rate (extends v0.9.0)

## Problem

v0.9.0 shipped a single global monthly budget with a burn-rate forecast to the
CLI, the API (`TodayResponse.budget`), and the native menu-bar app. But the
feature is **effectively invisible**:

1. The **web dashboard renders no budget at all** — the primary gap.
2. The only way to *set* a budget is hand-editing `~/.config/tokentrail/config.json`;
   `getConfig()` reads `monthlyBudgetUsd` but nothing writes it and no UI exposes
   it. So users never set one → the native panel's budget bar (which only renders
   when a budget is configured) shows nothing, and it looks like the feature
   doesn't exist.

This iteration makes budgets **visible, settable from the UI, per-source, and
alerting** across every surface.

## Goals

- Budget is **settable from the web UI** (Settings), so it's discoverable without editing JSON.
- Budget is **visible on the web dashboard** (sidebar card on the Overview).
- Support a **global monthly budget plus optional per-source caps** (Claude Code, GitHub Copilot, Cursor).
- Native app: **enrich** the in-panel bar, show an **empty state** when unset, and fire **threshold notifications** (once per threshold per cycle).
- CLI `tokentrail budget` shows the per-source breakdown too.

## Non-goals (YAGNI now)

- Per-repo / per-branch / per-dev / per-team budgets (higher cardinality → a
  future `budgets` SQLite table; see *Future*).
- Budget history / cycle-over-cycle charts.
- Editing budgets from the native app (native shows + links to web Settings).
- Surfacing budget state in the always-visible menu-bar **title** (the user did
  not pick this; the panel bar + notifications cover awareness).

## Storage decision — config file, not a table

Budgets at this scope are a handful of scalars: one global amount, one cycle-start
day, and up to three source caps. They live in the **tokentrail config file**
(`.tokentrail.json` / `~/.config/tokentrail/config.json`) beside the existing
`monthlyBudgetUsd`, which the CLI, API, and native app already read via
`getConfig()`. One source of truth, no migration, no CRUD.

A SQLite `budgets` table only earns its cost at higher cardinality (per-repo /
per-branch). That's the clean migration path later, not now.

```jsonc
// ~/.config/tokentrail/config.json (or project .tokentrail.json)
{
  "budgetCycleStartDay": 1,           // existing (1–28)
  "monthlyBudgetUsd": 200,            // existing (global; null = no global budget)
  "sourceBudgets": {                  // NEW — each key optional; absent/null = no cap
    "claude": 150,
    "copilot": 30,
    "cursor": 20
  }
}
```

## Components

### 1. Config model + writer (`src/lib/config.ts`)

- Extend `TokentrailConfig` with
  `sourceBudgets: { claude: number | null; copilot: number | null; cursor: number | null }`.
  `normalize()` coerces each to a positive number or `null`. `EMPTY_CONFIG`
  defaults all three to `null`.
- **New writer** `saveBudgetConfig(patch: { monthlyBudgetUsd?; budgetCycleStartDay?; sourceBudgets? })`:
  - Reads the current on-disk config JSON if present (raw parse, not normalized),
    **merges only the budget keys**, and writes the file back pretty-printed —
    preserving every unrelated key (cursor paths, `copilotStorePath`, mainline
    overrides, …).
  - Target path = `resolveConfigPath()` if a config file already exists (so "what
    you read is what you write"), else create `~/.config/tokentrail/config.json`
    (mkdir -p the dir). Never writes a project-local file that doesn't already exist.
  - Clears a key when passed an explicit `null` (e.g. removing the global budget).
  - This is the **first config writer** — today `config.ts` is read-only — so it's
    deliberately narrow: only budget keys, atomic write (temp file + rename), and
    it invalidates the in-process config cache so the next `getConfig()` sees it.
- Constitution check: config is not a JSONL source, so rule 9 (JSONL read-only)
  doesn't apply; keys are validated; no secrets involved.

### 2. Budget computation (`src/dashboard/data/budget.ts`)

- `buildBudget` returns the existing global `BudgetStatus`, now with an added
  `sources: SourceBudgetStatus[]` — one entry per source that has a configured
  cap. Each entry is a `BudgetStatus` shape plus `{ key, label }`.
- Per-source cycle-to-date spend reuses the **same source→spend mapping as the
  per-harness views** (`claude = usage_events.source in ('jsonl','hook')`,
  `copilot = 'copilot'`, `cursor = cursor_daily_cost`). Factor that mapping into a
  shared helper so budget and the source-scoped overview cannot diverge.
- Each source status computes spent / projected / pctUsed / projectedPct / state
  and its own `projectionReliable` (per-source spend is choppier, so the early-cycle
  suppression applies **independently** per source).
- Returns `null` only when there is **no** global budget **and no** source caps.

### 3. API (`src/dashboard/data/api.ts`)

- `TodayResponse.budget` gains `sources: SourceBudgetStatus[]` (empty array when no
  per-source caps). Cache key already includes budget config; extend it to include
  `sourceBudgets` so edits take effect on the next poll.

### 4. Web — Budget sidebar card (`render/overview.ts` + `dashboard.css`)

- New card in the Overview **right column**, placed between "Trail so far" and
  "This week".
- **Configured state:** global bar (filled = spent %, caret = projected %, colored
  ok / warn / over), a `$spent / $budget` line, and a `projected $X · N%` line
  (or "too early to forecast"). When source caps exist, a compact list of per-source
  mini-rows: label, small bar, `$spent / $cap`, state tint.
- **Empty state:** "Set a monthly budget" with a link to `/settings#budget`. This is
  what makes the feature discoverable.
- Server-rendered (no new client JS needed); colors via existing theme tokens so it
  works in light/dark.

### 5. Web — Settings "Budget" section (`render/settings.ts`, `static/settings.js`, `server.ts`)

- A "Budget" fieldset on `/settings`: monthly $ , cycle-start day (1–28), and
  optional Claude / Copilot / Cursor caps. Empty input = no cap / no budget.
- New endpoint **`POST /api/budget`** → validates and calls `saveBudgetConfig`.
  (Kept separate from `POST /api/settings`, which writes the *different*
  `settings.json`; budgets belong to the config file.)
- `buildSettingsVM` gains the current budget values so the form is pre-filled.

### 6. Native app (`scripts/menubar-native/Sources/Tokentrail.swift`)

- **Decodable:** `Budget` gains `sources: [SourceBudget]` (key, label, +
  BudgetStatus fields).
- **Enrich** `budgetView`: show cycle range + "day N/M", the projected marker, and
  — when present — per-source mini-rows under the global bar.
- **Empty state:** when `t.budget == nil`, render a subtle "Set a budget in
  Settings" row (opens the dashboard settings) instead of rendering nothing.
- **Threshold notifications** (`UNUserNotificationCenter`):
  - On each poll, for the global budget and each source budget, if `pctUsed`
    (using actual spend, not the noisy projection) first crosses **80%** or **100%**
    this cycle, post a local notification ("Budget: trending over" / "over").
  - **Dedupe:** a fired-marker set persisted in `UserDefaults`, keyed
    `"<cycleStart>:<budgetKey>:<threshold>"`. Because the key includes `cycleStart`,
    markers auto-expire when the cycle rolls — no cleanup needed. Never re-fires
    within a cycle. Request notification authorization once on first launch after
    a budget exists.
  - The fired-once decision is a **pure function**
    `newlyCrossed(prevMarkers, statuses, cycleStart) -> (notifications, nextMarkers)`
    so it's unit-testable without the notification framework.

### 7. CLI (`src/commands/budget.ts`)

- Under the global summary, print a per-source block when caps exist: label, bar,
  spent/cap, projected + state tag. Reuses the same `BudgetStatus` rendering.

## Data flow

```
config.json ──getConfig()──► buildBudget(db, {global, cycleDay, sourceBudgets})
                                   │  (per-source spend via shared source→spend map)
                                   ▼
                         BudgetStatus + sources[]
              ┌────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
      /api/today.budget     CLI `tokentrail budget`   (server-render web card)
              │
              ▼
   native app: budgetView + newlyCrossed() ──► UNUserNotification
   web Settings ──POST /api/budget──► saveBudgetConfig() ──► config.json
```

## Testing

- **config writer:** round-trip merge preserves unrelated keys; creates user-level
  file when none exists; clears a key on explicit null; atomic write.
- **buildBudget per-source:** correct cycle-scoped sums per source; per-source
  `state` + `projectionReliable`; `null` only when nothing is configured.
- **shared source→spend map:** budget per-source spend equals the source-scoped
  overview totals for the same window (guards against divergence).
- **notification dedupe:** `newlyCrossed` fires once per threshold per cycle, resets
  when `cycleStart` changes, and uses actual spend (not projection).
- **web render:** budget card configured + empty states; settings form pre-fill;
  `/api/budget` validation (rejects negatives / out-of-range cycle day).

## Rollout

Web-only + config changes ship via the daemon (brew upgrade + daemon restart).
The native-app changes (Decodable field, enriched view, notifications) require the
**app-bundle rebuild + swap** step of the release flow (not just `brew upgrade`).
Ship as a minor release (v0.12.0).

## Future (explicitly deferred)

- Per-repo / per-branch / per-dev budgets → a `budgets` SQLite table keyed by
  (scope, key); `buildBudget` gains scope resolution. The config-based global +
  per-source budgets become the "scope = global / source" rows in that model.
- Budget history (cycle-over-cycle) once budgets are in daily use.
- Optional budget state in the menu-bar title, if ambient awareness proves wanted.
