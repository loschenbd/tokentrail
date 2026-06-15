# Tokentrail Visualization — Design Spec

**Date:** 2026-06-15
**Status:** Approved, ready for implementation planning
**Author:** Brainstormed with Claude Code

## Purpose

Add a local web dashboard to Tokentrail that turns the existing
`feature_rollups` / `sessions` / `session_commits` / `session_prs` data into
something glanceable, and extend the Notion sync with a weekly digest plus
anomaly callouts so the same picture is visible from Notion without opening a
browser.

## Goals

Surface four kinds of insight from the data we already collect:

1. **Where** the money goes — top features / repos / branches.
2. **Trend** over time — daily total + per-feature stacked area.
3. **Lifecycle** of a feature — cost curve from first session to last.
4. **Anomalies worth a second look** — spike days, burning features, hot sessions.

## Non-goals

- No labeling UI on the web (CLI: `tokentrail label` stays the only way to label).
- No global search, CSV export, auth, or multi-user support.
- No real-time auto-refresh — manual reload is the workflow.
- No statistical models for anomalies (z-scores, IQR, learned baselines). Dumb
  thresholds, easy to explain.
- No Notion-side charts (Notion can't render uPlot, and embedded screenshots
  go stale).
- No Notion → dashboard sync. Notion stays a derived, read-only surface.

## Section 1 — Architecture & tech stack

### Command

New `tokentrail dashboard` command. **One-shot**, not a daemon — launches a
local server, prints the URL, and stays running until Ctrl-C.

Flags:

- `--port <n>` — default `4920`
- `--no-open` — don't auto-launch the browser
- `--days <n>` — default `30`; the initial time window

### Stack

| Layer | Pick | Why |
|---|---|---|
| Server | Fastify | Already implies route + plugin structure; fast cold start for a one-shot CLI server. |
| Rendering | Server-rendered HTML via template literals | No bundler, no build step, no hydration. |
| Time-series chart | uPlot | ~40KB, zero dependencies, fast on thousands of points. |
| Bar charts | Hand-rolled SVG | Few dozen bars, not worth a lib. |
| CSS | Hand-written + `src/dashboard/tokens.ts` design-token file | Theme is small and we control every pixel. |
| Client JS | Vanilla, no framework | One small `dashboard.js` for interactions. |

### Data flow

- Reads SQLite via the existing `getDb()` singleton from `src/db/db.ts`.
- **No caching.** Queries run fresh on each request. Data volume is small.
- Dashboard is **read-only**. No writes from the web. (Labeling, dismissals,
  re-syncing all stay CLI.)
- Bind to `127.0.0.1` only. No auth, no CORS.

### File layout

```
src/
  commands/
    dashboard.ts             # commander hook, parses flags, starts server
  dashboard/
    server.ts                # Fastify app, route registration
    render/
      shell.ts               # HTML envelope (head, header, footer)
      overview.ts            # `/` page template
      feature.ts             # `/feature/<key>` page template
      worth-a-look.ts        # `/worth-a-look` page template
    data/
      overview.ts            # SQL → view-model for overview
      feature.ts             # SQL → view-model for feature detail
      worth-a-look.ts        # SQL → view-model for anomaly list
    static/                  # CSS, dashboard.js, uPlot bundle, fonts
    tokens.ts                # design tokens (colors, typography, spacing)
```

## Section 2 — Pages & routes

### Route map

| URL | Page | Notes |
|---|---|---|
| `/` | Overview | Main + sidebar layout (cartographer-themed) |
| `/feature/<feature_key>` | Feature Detail | Single-column scroll |
| `/worth-a-look` | Anomaly list | Cheap list view, all historical anomalies |

**Session Detail page is skipped in v1.** Each session row instead links out to
GitHub for commits / PRs. We can add a transcript viewer later if useful.

### Overview (`/`) — main + sidebar

**Header bar:** `Tokentrail · the trail so far` + time-range picker
(`7d / 30d / 90d / all`) + repo-filter dropdown.

**Main column (~⅔):**

- **Trend chart** — uPlot stacked area, daily totals split by feature.
  Hover shows the day's breakdown; clicking a stack jumps to that feature page.
- **Top burn paths** — ranked bar list, top 10 features. Click → feature page.

**Sidebar (~⅓):**

- **Trail so far** — total + delta vs prior period (same window length).
- **This week** — 7-day total + session count.
- **Worth a look** — top 3–5 anomalies in the window.
- **Recent commits** — last ~10 commit subjects with SHA links.

### Feature Detail (`/feature/<key>`)

Single column, dense:

- **Hero** — feature name, total cost, delta, session count, list of branches that
  rolled up to this key.
- **Lifecycle curve** — daily cost line+area for just this feature.
- **Sessions table** — ranked by cost. Columns: cost · date · session id (8-char)
  · title · commit count · PR count. Each row expands inline to show full title,
  top 5 commits (with GitHub links), linked PRs (with GitHub links).
- **All commits** — collapsed list of every commit subject + SHA, GitHub-linked.
- **All PRs** — same treatment.

### Worth a look (`/worth-a-look`)

Flat list of all undismissed anomalies, newest first. Each entry shows kind,
date, target (feature/session), amount, baseline, reason text, and a link to
the relevant detail page.

### Navigation

- Header is sticky with a back-arrow to Overview from Feature Detail.
- Time-range picker is persistent — selection carries through to Feature Detail
  via query string.
- All GitHub links open in a new tab.

### Visual style — cartographer (locked)

Parchment-tinted background (`#f8f3e7` → `#f0e5d0` gradient). Georgia for hero
numbers and labels, system sans for body. Mile-marker Roman numerals on
ranked lists. Dashed `#8b6f47` rules instead of solid borders. Restrained: no
swords, no compasses, no map illustrations. Flavor lives in microcopy
("the trail so far", "burn paths", "worth a look") and small accents.

## Section 3 — Anomaly handling

Three classes of anomaly, computed at rollup time:

| Kind | Trigger | Reason text example |
|---|---|---|
| `spike_day` | Day total ≥ 2× trailing 7-day median **and** ≥ $20 floor | "$387 — 3.1× the prior week's typical day." |
| `burning_feature` | Feature's 7-day total ≥ 1.5× prior 7-day total **and** ≥ $50 floor | "Local RAG chatbot — $487 this week, up from $312." |
| `hot_session` | Session ≥ $25 **and** ≥ 3× the 30-day median session cost | "`ba97bbe8…` · $388 in one session." |

**Hot-session suppression:** Skip the `hot_session` flag if the session has a
feature_override **or** its branch maps to a labeled work_unit. Labels = "I
already know where this cost went." (User picked this option over showing-then-
dismissing.)

Thresholds live in `config/anomaly.ts` as plain exported constants — tunable
without code changes elsewhere.

### Storage

New `anomalies` table:

```sql
CREATE TABLE IF NOT EXISTS anomalies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,                -- 'spike_day' | 'burning_feature' | 'hot_session'
  date            TEXT NOT NULL,                -- ISO date the anomaly is anchored to
  feature_key     TEXT,                         -- null for hot_session
  session_id      TEXT,                         -- only for hot_session
  amount          REAL NOT NULL,
  baseline        REAL NOT NULL,
  multiplier      REAL NOT NULL,
  reason          TEXT NOT NULL,
  dismissed_at    TEXT,                         -- ISO timestamp; null = active
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS anomalies_date_idx ON anomalies(date);
CREATE INDEX IF NOT EXISTS anomalies_active_idx ON anomalies(dismissed_at) WHERE dismissed_at IS NULL;
```

Recomputed from scratch each `tokentrail rollup` run (TRUNCATE active rows +
INSERT). Dismissed rows are preserved across reruns by matching on
`(kind, date, feature_key, session_id)`.

### Dismissal

CLI only in v1: `tokentrail anomaly dismiss <id>`. Sets `dismissed_at`.
Sidebar / Worth-a-look exclude dismissed rows by default.

### Out of scope for v1

- No notifications/alerts (dashboard is pull, not push).
- No anomaly-of-anomalies summaries.
- No automatic clustering or root-cause attribution.

## Section 4 — Notion supplementary scope

Notion's job after this: be the **glanceable digest** without opening a browser.
The web dashboard is the primary surface; Notion is derived.

### Additions

**1. Weekly digest page** — `tokentrail sync` always upserts the current week's
digest page (idempotent, body rebuilt each run). Title format:
`Week of YYYY-MM-DD` (Monday). Body sections:

- *The trail so far* — week total + delta vs prior week.
- *Top burn paths* — top 5 features with cost + session count + links to the
  per-rollup pages.
- *Worth a look* — anomalies anchored within the week, with reasons.
- *Recent commits* — 10 most recent commit subjects + SHAs (GitHub links).
- *Open PRs* — PRs from session work still open, with status (draft / review /
  mergeable).

Stored in the same Notion database as existing rollup pages, distinguishable
by a new `Type` property (`Rollup` | `Digest`).

**2. Anomaly columns on the rollup database:**

- `Anomaly` (checkbox) — true if the rollup row has any matching anomaly.
- `Anomaly reason` (rich-text) — reason string of the matching anomaly with the
  highest `multiplier` (ties broken by `kind` priority:
  `spike_day > burning_feature > hot_session`).

Lets a Notion view filter on *Anomaly: checked* without leaving Notion.
Populated during `tokentrail sync`.

**3. Dashboard URL on each rollup page** — one rich-text run at the top of each
rollup body: *"View on dashboard →"* linking to
`http://127.0.0.1:4920/feature/<key>?date=<date>`. Works only when the
dashboard is running locally; that's fine — it's a shortcut, not a guarantee.

### Stays the same

- Per-feature-per-day rollup pages and their existing Sessions / PRs /
  Commits body sections.
- `tokentrail sync` and `tokentrail sync --rebuild-bodies` flows.
- All existing Notion props.

### Explicitly out

- No Notion-rendered charts.
- No daily digests — weekly cadence only.
- No Notion → dashboard sync direction.

## Implementation order

1. **SQLite schema:** add `anomalies` table. Idempotent migration.
2. **Anomaly compute:** extend `tokentrail rollup` to populate `anomalies`.
3. **Dashboard skeleton:** `tokentrail dashboard` command, Fastify server on
   `127.0.0.1:4920`, Overview route with hero + trend.
4. **Feature Detail route** + lifecycle chart + sessions table.
5. **Worth-a-look route** + anomaly dismissal CLI command.
6. **Notion extensions:** weekly digest page, `Type` / `Anomaly` /
   `Anomaly reason` columns (auto-added at sync via existing
   `notion-update-data-source` flow), dashboard URL injected into rollup bodies.
7. **Visual polish pass** — apply cartographer tokens consistently.

Each step is independently shippable and falls back gracefully if the next
isn't done yet (e.g. anomalies compute without the dashboard reading them).

## Open questions deferred to implementation

- Exact uPlot bundle path: vendored vs npm vs CDN. Pick during step 3.
- Repo filter dropdown population: union of distinct `repo` values vs explicit
  config. Pick during step 3.
- Sticky header height + scroll offset math. Pick during step 4.

These don't change the shape of the design; they're choices that need real
DOM to settle.
