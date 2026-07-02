# Attribution heal + expandable "Other" band

**Date:** 2026-07-02
**Status:** Approved

## Problem

The overview dashboard shows a large "Other" band ($1,286 over the last 30
days) alongside a tiny "Unattributed" card ($56.76). About 45% of "Other" is
not real long-tail spend — it is key fragmentation:

- `repoContextFor()` (`src/services/git.ts:109`) stamps usage events with
  `local/<basename>` when the checkout has no origin remote. Once a remote is
  added, the same directory produces `owner/<name>` events. One project, two
  repo identities.
- `runRollup()` unions a feature's repos into a CSV (e.g.
  `local/mudandsilicon,loschenbd/mudandsilicon`).
- `bucketProject()` (`src/dashboard/data/overview.ts:458`) takes the first
  CSV entry, so the `local/` identity spawns a separate project key
  (`local:mudandsilicon` vs `repo:loschenbd/mudandsilicon`). The smaller
  fragment falls out of the top 6 and lands in "Other".

Verified in the live database: `local/mudandsilicon` (460 events) and
`loschenbd/mudandsilicon` (2,605 events) share the identical `project_dir`.
Same pattern for `local/tokentrail`. `local/writing-mentor` is genuinely
local-only (no slug ever observed) and must not be touched.

Separately, "Other" is opaque: the legend row is not clickable and there is
no way to see its constituents.

## Decisions

1. **Heal the data** (chosen over rollup-time alias mapping and display-time
   patching): rewrite fragmented repo identities in the base tables so every
   consumer — dashboard, CLI reports, Notion sync, `prs`/`merges` commands —
   sees clean data.
2. **Expandable legend row** (chosen over a drilldown page and hover
   tooltip): the "Other" legend row toggles an inline sub-list of tail
   projects.

## Section 1 — Attribution heal

Three layers, all keyed on the same provable rule: *a `local/X` repo is the
same project as slug `owner/N` iff both were observed on the same
`project_dir`.*

### 1a. Startup migration (idempotent)

In `src/db/migrations.ts`, after schema migrations:

1. For each distinct `repo LIKE 'local/%'` in `usage_events`, collect the set
   of non-local repos seen on the same `project_dir`(s).
2. Exactly one distinct slug → rewrite `local/X → slug` in:
   - `usage_events.repo`
   - `work_units.repo`
   - `session_commits.repo`
   - `session_prs.repo`
   - `branch_merges.repo`
   - `feature_rollups.repo` — CSV-aware: replace the `local/X` entry, then
     dedupe entries within the CSV.
3. Zero slugs (e.g. `local/writing-mentor`) → leave untouched; it is a
   legitimate local-only project.
4. Two or more distinct slugs (ambiguous) → leave untouched, log one clean
   line (rule 6: log, don't crash).

Re-running is a no-op once healed (no `local/X` rows remain that have a slug
sibling). Runs inside a transaction.

### 1b. Ingest-time prevention

Where usage events are inserted with a `local/<basename>` fallback repo:
before insert, check whether `usage_events` already has a non-local repo for
the same `project_dir`; if exactly one, stamp the new event with that slug
instead. Keeps new fragmentation from accumulating between startups. (The
reverse case — local events first, slug appears later — is what the startup
migration handles.)

### 1c. `bucketProject()` hardening

When the rollup `repo` CSV contains both slug-style and `local/` entries,
prefer the first slug-style entry instead of the first entry positionally.
Covers any row the migration could not prove (e.g. ambiguous dirs).

### Expected effect on current data

- mudandsilicon consolidates to ≈ $1,500 (moves to 4th place).
- tokentrail absorbs its `local/tokentrail` slice.
- "Other" drops from ≈ $1,286 to ≈ $701 (pm-os, gemify-universal,
  `outside:*` sessions — genuine tail).

## Section 2 — Expandable "Other" legend row

### Data

`getOverviewVM()` already computes `tailProj`; expose it on the VM:

```ts
otherProjects: Array<{ key: string; name: string; totalUsd: number }>
```

Sorted descending by `totalUsd`. All entries are clickable: `repo:`,
`local:`, and `feature:` keys all route to existing project detail pages
(`parseProjectKey` in `src/dashboard/data/project.ts` handles all three
kinds — verified during planning; the earlier assumption that `outside:*`
pseudo-projects lack pages was wrong).

### Render (`src/dashboard/render/overview.ts`)

- The "Other" legend row gains a chevron (`▾`/`▸`) and an indented sub-list
  beneath it, collapsed by default.
- Sub-rows: project name + dollar amount; every row links to its project
  detail page.
- No swatches on sub-rows (they are all inside the one gray band) and no
  truncation — show all entries (post-heal the tail is ~4–7 rows).

### Behavior (`src/dashboard/static/dashboard.js`)

- Clicking the Other row toggles the sub-list. State is session-local, not
  persisted.
- Hovering a sub-row does **not** highlight chart segments — the band is an
  aggregate; there is nothing to isolate.
- Existing hover/highlight behavior for the Other row itself is unchanged.

## Error handling

- Migration wraps the heal in a transaction; on failure it rolls back and
  logs — startup continues (rule 6).
- Ambiguous local repos are skipped and logged, never guessed.

## Testing

- Unit tests for the heal against a fixture DB: healable case (local + slug
  on same dir), local-only case (untouched), ambiguous case (untouched +
  logged), CSV dedupe in `feature_rollups.repo`.
- Unit test for `bucketProject()` slug-preference within a CSV.
- Manual verification (per CLAUDE.md): run the dashboard; confirm
  mudandsilicon ≈ $1,500, "Other" ≈ $701, and the Other row expands with
  working links.

## Out of scope

- Manual alias configuration in `.tokentrail.json` (YAGNI until an ambiguous
  case actually appears).
- Merging separate checkouts of the same repo by basename (slug identity
  already handles it when remotes exist).
- Any change to the Unattributed card — it measures a different thing
  (uncategorizable sessions) and is working as intended.
