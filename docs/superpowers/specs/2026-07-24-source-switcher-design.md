# Source switcher (native app) — design

**Date:** 2026-07-24
**Status:** Approved design (the "Middle" tier), pre-implementation
**Scope:** A source switcher in the native menu-bar app: an **All** view with a
dollars-only combined total broken out by source, plus per-source views. Built
on a small per-day Cursor-cost rollup so the combined number aligns to the
window. Native app only; dollars-only combined; Codex deferred.

---

## 1. Decisions locked (from brainstorming)

- **Combined view is dollars-only.** "All" sums USD per source. Cursor's
  AI-authored *lines* never enter the combined total — they appear only in the
  Cursor per-source view.
- **Surface: native menu-bar app only** (`scripts/menubar-native/Sources/Tokentrail.swift`).
  The web dashboard is out of scope for this pass.
- **Cursor dollars are window-aligned via a lightweight daily rollup** — the
  "Middle" tier. No per-event store, no incremental-fetch rework.
- **Switcher = All | Claude | Cursor.** No Codex tab until Codex is integrated
  (adding a lane later is trivial).
- **Not in scope:** dashboard switcher, per-model Cursor detail, the
  `tokentrail cursor` pagination perf fix (separate ticket), a source-stacked
  trend chart (the existing project-stacked chart is unchanged).

---

## 2. Data layer

### 2.1 New table `cursor_daily_cost`
```
date        TEXT PRIMARY KEY   -- 'YYYY-MM-DD' (UTC, matching event timestamps)
usd         REAL NOT NULL DEFAULT 0
updated_at  TEXT NOT NULL
```
Per-day Cursor metered dollars for the current billing cycle. Recomputed each
`runCursorUsage` from the cycle events Source A **already** paginates — the only
change is aggregating those events by day instead of into a single total.

### 2.2 Source A change (small)
`src/services/cursor-cloud.ts`:
- Add `bucketMeteredByDay(events, cycleStartMs): Record<string, number>` (cents
  per `date(timestamp)`), reusing the same cycle-boundary + non-finite-timestamp
  guards as `sumMeteredUsd`. Keep `sumMeteredUsd` for the singleton total.
- `fetchMeteredUsd` also returns `byDay: Record<string, number>` (USD per date)
  alongside the existing `{ usd, eventsScanned, eventsTotal, truncated }`.

`src/commands/cursor.ts` `runCursorUsage`:
- After computing `metered`, upsert each `byDay` entry into `cursor_daily_cost`
  (`ON CONFLICT(date) DO UPDATE`), inside the existing write path. On the
  partial/stale path (metered null) leave `cursor_daily_cost` untouched (keep
  last-good), consistent with the `cursor_usage` stale behavior.
- Do NOT sum `cursor_daily_cost` into any USD token total — it is a separate,
  Cursor-only table (same invariant as `cursor_usage`).

### 2.3 Per-source series (read side)
New module function (e.g. `src/dashboard/data/sources.ts`):
`buildSources(db, { days }): SourcesResponse` returning:
```ts
type SourceCost = {
  key: 'claude' | 'cursor';
  label: string;
  usd: number;          // summed over the window
  windowAligned: boolean; // true for claude & cursor daily-rollup
  extra?: { aiLines?: number }; // cursor only: AI-authored lines in window-agnostic total
};
type SourcesResponse = {
  days: number;
  totalUsd: number;     // sum of sources[].usd — dollars only
  sources: SourceCost[];
};
```
- **Claude** `usd`: `SUM(estimated_cost_usd)` from `usage_events` over the last
  `days` (this is today's/overview's existing money source).
- **Cursor** `usd`: `SUM(usd)` from `cursor_daily_cost` over the last `days`.
  `extra.aiLines`: `SUM(ai_lines)` from `cursor_code_attribution` (all-time /
  window-agnostic — lines aren't dollar-windowed; labeled as such in the UI).
- `totalUsd = claude.usd + cursor.usd`. Only sources with data appear.

### 2.4 API
Extend the existing `/api/today` response (native app already consumes it) with
**two** fields, matching the two figures the panel already shows (`todayUsd` and
`last30Usd`):
- `sourcesToday: SourcesResponse` — `buildSources(db, { days: 1 })`
- `sources30d: SourcesResponse` — `buildSources(db, { days: 30 })`

No new endpoint required for the native-only scope. The Swift `TodayResponse`
model gains both fields (optional-decoded, so an older daemon still parses).

---

## 3. Native app (`Tokentrail.swift`)

- Add `@State private var source: SourceTab = .all` where
  `enum SourceTab { case all, claude, cursor }`.
- A segmented `Picker("", selection: $source)` pinned at the top of
  `PanelView` — labels **All · Claude · Cursor**. Only render the Cursor
  segment when the `sources` payload includes a cursor entry (so users without
  Cursor never see a dead tab).
- Decode the new `sources` fields into the existing `TodayResponse` model.
- Render per selection:
  - **All** — the combined dollar total for the window, plus a one-line source
    split (`$9 Claude · $41 Cursor`). The existing project breakdown + trend
    chart stay as-is (they are Claude/token data); they render beneath the split
    under All and Claude.
  - **Claude** — the current panel exactly as today (no behavior change).
  - **Cursor** — Cursor's window dollar figure + an AI-lines strip
    (`8,910 AI lines · 94% AI`, labeled all-time). No project chart (Cursor has
    no per-project dollars).
- Every dollar figure keeps the existing `estimated` treatment.

---

## 4. Invariants & error handling

- `cursor_daily_cost` is never summed into `usage_events`/token USD totals; the
  combined `totalUsd` is computed in `buildSources` by explicit addition of
  per-source figures, not by a query over `usage_events`.
- Missing Cursor data (no `cursor_daily_cost` rows, no cookie) → the `sources`
  array simply omits the cursor entry; the switcher hides the Cursor tab and
  "All" shows only Claude. No crash, no empty tab.
- Cursor daily rollup only covers the current billing cycle (that is all Source
  A fetches); a 30-day window that predates the cycle start will undercount
  Cursor — acceptable for this tier and noted in the UI copy ("this cycle").

---

## 5. Testing

- `bucketMeteredByDay`: events across two dates → correct per-date cents;
  events before cycle start / non-finite timestamp excluded (mirror
  `sumMeteredUsd` tests).
- `runCursorUsage` writes `cursor_daily_cost` rows from injected metered
  `byDay`; partial/stale run leaves existing daily rows intact.
- `buildSources`: seed `usage_events` (Claude) + `cursor_daily_cost` (Cursor) +
  `cursor_code_attribution` (lines) → assert `totalUsd = claude + cursor`,
  `sources` shape, and that lines live only in the cursor `extra` (never in
  `totalUsd`).
- Native Swift has no unit harness — verify by building the app and a
  screenshot of the three switcher states (per the project's menubar-native
  verification convention).

---

## 6. Build order

1. `cursor_daily_cost` table (schema).
2. `bucketMeteredByDay` + `fetchMeteredUsd.byDay` (cursor-cloud) + tests.
3. `runCursorUsage` writes the daily rollup + tests.
4. `buildSources` + `/api/today` `sources` field + tests.
5. Native app: `SourceTab` picker + per-source rendering; build + screenshot.
