# Tokentrail — Build Spec

> **Agent instructions:** Read this document fully before writing a single line of code. Follow the phased build plan in order. Each phase ends with a working, testable artifact. Do not skip phases or merge them. Ask for clarification if any requirement is ambiguous before implementing. Commit after each phase.

---

## Overview

Build a local-first TypeScript CLI tool named **Tokentrail** that tracks Claude Code token usage and cost, attributes that cost to Git branches and GitHub PRs, and syncs daily rollup summaries into a Notion database. The stack is TypeScript + SQLite (better-sqlite3) + GitHub REST API (Octokit) + Notion SDK. No external SaaS observability tools. No remote database. Everything runs locally via a cron-style script or on-demand CLI command.[cite:97][cite:101][cite:103][cite:104]

**Primary question this tool answers:** "How much did Claude Code cost while building feature X?"[cite:40][cite:41]

**Brand direction:** Tokentrail should sound clear, capable, and slightly fantasy-coded. Think ranger, cartographer, ledger-keeper, or trail guide — not parody, not full medieval roleplay. Use grounded product language first, with light flourishes in naming and microcopy. Examples: “Follow the trail,” “trace the burn,” “map the path,” “record the ledger.” Avoid cringe terms like “quest,” “wizard,” or “epic” in core product surfaces.

---

## Product identity

### Name

The tool is named **Tokentrail**.

### Positioning

Tokentrail is a local ledger and trail-map for Claude Code spend. It shows where tokens were spent, which branches and features consumed them, and how that cost rolls up over time.[cite:30][cite:40][cite:82][cite:83]

### Voice and tone

Use this tone consistently in README copy, CLI descriptions, and Notion sync labels:

- Competent, calm, and observant.
- Slight fantasy texture, but restrained.
- More “cartographer of AI spend” than “D&D joke tool.”
- Clearer than clever.
- Professional enough to publish on GitHub.

### Naming guidelines inside the app

Use the fantasy flavor lightly in non-critical strings only.

Good examples:
- `tokentrail report`
- `tokentrail sync`
- “Trail updated.”
- “No trail found for this date range.”
- “Top burn paths”
- “Feature ledger”

Avoid:
- “Cast sync spell”
- “Launch quest”
- “Mana usage”
- “Summon report wizard”

---

## Data Sources

### 1. Claude Code local JSONL logs

Claude Code writes every session as a JSONL file to `~/.claude/projects/<encoded-project-path>/<session-id>.jsonl`.[cite:86] Each line is a JSON event. Assistant message events contain `usage.input_tokens` and `usage.output_tokens`.[cite:40][cite:72] The session ID is encoded in the filename. Project path is the URL-encoded absolute path to the repo root.[cite:86]

The tool `ccusage` already parses these JSONL files and produces daily, monthly, and session-level cost reports.[cite:82][cite:83][cite:85] Do not reinvent ccusage's JSONL parser unless necessary. Prefer one of these approaches:
- Shell out to `ccusage --json` to get structured usage data.[cite:82][cite:83]
- Or implement a minimal JSONL reader that extracts only `session_id`, `timestamp`, `input_tokens`, `output_tokens`, and `model` from assistant message events.[cite:40][cite:86]

Token pricing should live in `config/pricing.ts`, not hardcoded inline. Claude API pricing is billed per million input and output tokens, with distinct rates by model tier.[cite:69][cite:70][cite:71]

### 2. Claude Code hooks (optional but recommended)

Claude Code fires lifecycle hooks that receive a JSON payload via stdin.[cite:118][cite:124][cite:131] The `Stop` event fires when a session ends and `SessionStart` fires when one begins.[cite:126][cite:127] Configure a `Stop` hook in `.claude/settings.json` to write a lightweight snapshot of session metadata such as `session_id`, timestamp, git branch, repo path, and estimated usage context to a local log file.[cite:124][cite:126][cite:131]

Hook payloads include identifying session fields and transcript context, which can improve branch attribution for recent sessions.[cite:127][cite:131]

### 3. Git context (local)

At ingest time, capture:
- `git rev-parse --abbrev-ref HEAD` → current branch name.
- `git rev-parse HEAD` → current commit SHA.
- `git remote get-url origin` → repo remote URL, then parse to extract `owner/repo`.
- `git log --format='%cI' -1` → timestamp of HEAD commit.

This is the primary branch attribution signal.

### 4. GitHub REST API (Octokit)

Use `@octokit/rest` to enrich branch records with PR metadata.[cite:90][cite:104]

Recommended endpoints and methods:
- `octokit.rest.pulls.list({ owner, repo, state: 'all', head: 'owner:branch' })` to find a PR linked to a branch.[cite:90][cite:104]
- From the PR record, capture `title`, `number`, `labels`, `merged_at`, and `body`.
- Optionally query linked issues to derive a cleaner feature name.[cite:90]

GitHub enrichment should run in a separate enrichment step, not block core ingest.

### 5. Notion API

Use `@notionhq/client`, the official Notion JavaScript SDK, to sync daily rollup records into a Notion database.[cite:97][cite:110] Write only to Notion; do not treat Notion as the source of truth. Notion is the reporting layer.[cite:97][cite:110]

---

## Repository Structure

```text
tokentrail/
├── CLAUDE.md
├── README.md
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── config/
│   ├── pricing.ts
│   └── feature-map.ts
├── src/
│   ├── index.ts
│   ├── commands/
│   │   ├── ingest.ts
│   │   ├── enrich.ts
│   │   ├── rollup.ts
│   │   ├── sync.ts
│   │   └── report.ts
│   ├── db/
│   │   ├── schema.ts
│   │   ├── migrations.ts
│   │   └── db.ts
│   ├── services/
│   │   ├── jsonl-reader.ts
│   │   ├── git.ts
│   │   ├── github.ts
│   │   └── notion.ts
│   ├── lib/
│   │   ├── attribution.ts
│   │   ├── cost.ts
│   │   └── types.ts
│   └── hooks/
│       └── session-end.sh
├── data/
│   └── tracker.db
└── .claude/
    └── settings.json
```

---

## CLI design

The binary name should be `tokentrail`.

Primary commands:
- `tokentrail ingest`
- `tokentrail enrich`
- `tokentrail rollup`
- `tokentrail report`
- `tokentrail sync`
- `tokentrail run-all`

Optional aliases:
- `tokentrail trail` → alias for `report`
- `tokentrail map` → alias for grouped feature output

Help copy should stay readable and restrained. Example:
- `tokentrail report --days 7` → “Follow token usage across recent work.”
- `tokentrail sync` → “Sync the latest ledger entries to Notion.”

---

## Database Schema

Use `better-sqlite3` for all database operations. It is widely used for simple, fast SQLite access in Node.js and is well-suited to a local CLI tool.[cite:101][cite:103][cite:105]

### Table: `usage_events`

```sql
CREATE TABLE IF NOT EXISTS usage_events (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  timestamp             TEXT NOT NULL,
  repo                  TEXT,
  branch                TEXT,
  commit_sha            TEXT,
  model                 TEXT NOT NULL,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens    INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd    REAL NOT NULL DEFAULT 0,
  source                TEXT NOT NULL DEFAULT 'jsonl',
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Table: `work_units`

```sql
CREATE TABLE IF NOT EXISTS work_units (
  id                    TEXT PRIMARY KEY,
  repo                  TEXT NOT NULL,
  branch                TEXT NOT NULL,
  pr_number             INTEGER,
  pr_title              TEXT,
  pr_labels             TEXT,
  github_issue          INTEGER,
  feature_key           TEXT NOT NULL,
  feature_name          TEXT NOT NULL,
  notion_page_id        TEXT,
  status                TEXT DEFAULT 'active',
  first_seen_at         TEXT NOT NULL,
  last_seen_at          TEXT NOT NULL,
  github_enriched_at    TEXT,
  UNIQUE(repo, branch)
);
```

### Table: `feature_rollups`

```sql
CREATE TABLE IF NOT EXISTS feature_rollups (
  id                    TEXT PRIMARY KEY,
  date                  TEXT NOT NULL,
  feature_key           TEXT NOT NULL,
  feature_name          TEXT NOT NULL,
  repo                  TEXT,
  branches              TEXT,
  total_input_tokens    INTEGER NOT NULL DEFAULT 0,
  total_output_tokens   INTEGER NOT NULL DEFAULT 0,
  total_cost_usd        REAL NOT NULL DEFAULT 0,
  sessions_count        INTEGER NOT NULL DEFAULT 0,
  notion_page_id        TEXT,
  synced_to_notion_at   TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, feature_key)
);
```

---

## Attribution Logic

Branch-to-feature resolution runs in `src/lib/attribution.ts`.

Apply rules in this priority order:
1. Manual override from `config/feature-map.ts`.
2. PR label, if a relevant non-generic label exists.[cite:90][cite:104]
3. PR title, slugified.
4. Branch prefix pattern.
5. Mainline fallback for `main`, `master`, `develop`, or `staging`.
6. Default to slugified branch name.

Supported branch patterns:
- `feature/<slug>` → `<slug>`
- `feat/<slug>` → `<slug>`
- `fix/<slug>` or `bugfix/<slug>` → `fix-<slug>`
- `chore/<slug>` → `chore-<slug>`
- `spike/<slug>` or `research/<slug>` → `research-<slug>`
- `deps/<slug>` or `dependabot/<slug>` → `deps-update`

Use human-readable feature names in reports and Notion rollups, but keep `feature_key` as a stable slug.

---

## Phase 1 — Local ingest from JSONL

**Goal:** parse Claude Code's local JSONL files, compute estimated cost, and store results in SQLite.[cite:40][cite:72][cite:86]

Implementation steps:
1. Set up the project with TypeScript, `tsx`, `commander`, `dotenv`, `better-sqlite3`, and type packages where needed.[cite:101][cite:103]
2. Implement `src/db/schema.ts` with the CREATE TABLE statements.
3. Implement `src/db/db.ts` with a singleton `getDb()` that opens `data/tracker.db` and runs idempotent migrations.
4. Implement `src/services/jsonl-reader.ts` to find JSONL files in `~/.claude/projects/` and parse assistant usage lines.[cite:82][cite:86][cite:88]
5. Deduplicate by message identifier when necessary, because parallel tool calls can complicate raw event counting.[cite:40]
6. Implement `src/lib/cost.ts` to convert per-model token counts into estimated USD cost using the configured rate card.[cite:69][cite:70][cite:71]
7. Implement `src/services/git.ts` with helpers for branch, commit SHA, and remote parsing.
8. Implement `src/commands/ingest.ts` and wire it into the CLI.

Success criteria:
- `tokentrail ingest` inserts new rows into `usage_events`.
- Running ingest twice does not double-count existing entries.
- The terminal prints a concise summary such as “Trail updated: 42 new usage events from 8 sessions.”

---

## Phase 2 — Branch attribution and work units

**Goal:** create or update `work_units` records for each unique `(repo, branch)` pair seen in usage data.

Implementation steps:
1. Implement `src/lib/attribution.ts`.
2. Implement `config/feature-map.ts` with manual overrides.
3. Extend ingest to upsert `work_units` after inserting new usage events.
4. Set `first_seen_at` and `last_seen_at` from the event timestamps.

Success criteria:
- `work_units` is populated.
- Branches resolve into stable feature keys.
- Unmapped branches fall back safely.

---

## Phase 3 — GitHub enrichment

**Goal:** enrich `work_units` with PR metadata and improve feature attribution using GitHub data.[cite:90][cite:104]

Required env var:

```text
GITHUB_TOKEN=
```

Implementation steps:
1. Install and configure `@octokit/rest`.[cite:104]
2. Build `src/services/github.ts` to look up PRs by branch.
3. Parse labels, title, merge state, and optional issue references from PR bodies.[cite:90]
4. Implement `src/commands/enrich.ts` to update unresolved or stale `work_units`.
5. Add a small delay between requests to avoid secondary rate limits.

Success criteria:
- `tokentrail enrich` fills in PR-linked metadata where available.
- PR labels and titles can override weaker branch-prefix attribution.

---

## Phase 4 — Rollup aggregation

**Goal:** aggregate usage into daily feature rollups.[cite:40][cite:41]

Implementation steps:
1. Implement `src/commands/rollup.ts`.
2. Join `usage_events` to `work_units` by `(repo, branch)`.
3. Group by `date(timestamp)` and `feature_key`.
4. Upsert results into `feature_rollups`.
5. Print a summary table of trail segments: feature, date, cost, sessions.

Success criteria:
- Total rollup cost matches the sum of event-level estimated costs.
- Rollups are stable on repeated execution.

---

## Phase 5 — Terminal report

**Goal:** provide a clean local report without requiring Notion.[cite:82][cite:83]

Implementation steps:
1. Implement `src/commands/report.ts`.
2. Support flags such as `--days`, `--repo`, and `--feature`.
3. Print grouped output with totals and top spenders.
4. Keep formatting minimal and readable.

Example output tone:

```text
Tokentrail — Last 30 days
────────────────────────────────────────────────────
Feature                   Cost      Sessions   Branches
notion-sync               $4.82     14         3
ranking-v2                $3.21     9          2
fix-token-parser          $1.04     4          1
────────────────────────────────────────────────────
Total                     $9.25     29         6
```

Success criteria:
- `tokentrail report --days 7` works without GitHub or Notion.
- Output is useful enough to be the MVP reporting surface.

---

## Phase 6 — Notion sync

**Goal:** push `feature_rollups` into a Notion database for ongoing review and filtering.[cite:97][cite:110]

Required env vars:

```text
NOTION_TOKEN=
NOTION_DATABASE_ID=
```

Create a Notion database with these properties:

| Property Name | Type | Notes |
|---|---|---|
| Name | Title | `{feature_key} · {date}` |
| Date | Date | Rollup date |
| Feature Key | Rich Text | Stable slug |
| Feature Name | Rich Text | Human-readable name |
| Repo | Select | `owner/repo` |
| Branches | Rich Text | Comma-separated list |
| Total Cost USD | Number | Estimated spend |
| Total Input Tokens | Number | |
| Total Output Tokens | Number | |
| Sessions | Number | |
| Synced At | Date | Timestamp |

Implementation steps:
1. Install `@notionhq/client`.[cite:97]
2. Implement `src/services/notion.ts`.
3. Upsert pages by `Feature Key + Date`.
4. Implement `src/commands/sync.ts`.
5. Respect Notion rate limits and avoid unnecessary rewrites.[cite:97][cite:110]

Success criteria:
- `tokentrail sync` creates or updates Notion pages.
- Rollups remain canonical in SQLite; Notion is a mirror.

---

## Phase 7 — Claude Code hook integration

**Goal:** capture session metadata near real time at session end using a Claude Code `Stop` hook.[cite:124][cite:126][cite:131]

Implementation steps:
1. Create `src/hooks/session-end.sh` to receive JSON from stdin and append a JSONL snapshot to `~/.claude-cost-tracker/session-hooks.jsonl`.
2. Configure `.claude/settings.json` to register the hook using an absolute path.[cite:124]
3. Extend ingest logic to optionally merge hook snapshots for better branch attribution.
4. Document setup clearly in README.

Success criteria:
- Ending a Claude Code session appends a local hook log entry.
- Recent sessions can be matched more accurately to the active branch at stop time.

---

## Phase 8 — Automation

**Goal:** one command runs the full trail refresh.

Implementation steps:
1. Add `tokentrail run-all` to execute `ingest → enrich → rollup → sync`.
2. Add `--skip-sync` to allow local-only usage.
3. Provide a simple cron wrapper script.
4. Document a sample cron entry in README.

Success criteria:
- One command refreshes the ledger end-to-end.
- Local-only users can still stop before Notion sync.

---

## README guidance

The README should reflect the Tokentrail identity.

Suggested opening:

> Tokentrail is a local-first CLI for tracing Claude Code token usage across branches, features, and pull requests. It follows the trail from raw session logs to feature-level cost rollups, then optionally syncs that ledger to Notion.[cite:40][cite:82][cite:97]

Suggested section names:
- What Tokentrail does
- How the trail is mapped
- Commands
- Notion sync
- Hook setup
- Limits and caveats

Keep the README polished and slightly evocative, but still direct.

---

## CLAUDE.md (Project Constitution)

Create `CLAUDE.md` at the project root with this content:

```markdown
# Tokentrail — Project Constitution

## Purpose
Track Claude Code token costs, attribute them to Git branches and GitHub PRs,
and sync daily summaries to Notion.

## Product identity
Tokentrail is a trail-map and ledger for AI spend. The voice is calm, precise,
and lightly fantasy-coded. Use the flavor sparingly. Clarity beats cleverness.

## Stack
- Runtime: Node.js + TypeScript
- Database: SQLite via better-sqlite3
- GitHub: @octokit/rest
- Notion: @notionhq/client
- CLI: commander

## Rules
1. Run migrations on every startup using idempotent SQL.
2. Never hardcode API keys; use .env.
3. All costs are labeled estimated.
4. better-sqlite3 is the only DB layer for MVP.
5. Attribution logic lives only in src/lib/attribution.ts.
6. GitHub and Notion failures should log cleanly and not crash the whole pipeline.
7. Keep CLI language restrained and readable.
8. Fantasy flavor belongs in microcopy, not in technical architecture.
9. JSONL sources are read-only.
10. Prefer small, testable phases over broad rewrites.

## Build order
Phase 1 ingest → Phase 2 attribution → Phase 3 enrich → Phase 4 rollup →
Phase 5 report → Phase 6 sync → Phase 7 hooks → Phase 8 automation

## Manual verification
After each phase, run the relevant command and verify the database contents or
terminal output before proceeding.
```

---

## Environment variables

Create `.env.example` with:

```text
NOTION_TOKEN=
NOTION_DATABASE_ID=
GITHUB_TOKEN=
CLAUDE_CONFIG_DIR=
TRACKER_DB_PATH=
TRACKER_LOG_DIR=
```

---

## Constraints and edge cases

These behaviors must be handled safely:

1. If no Claude JSONL directory exists, `ingest` should print a friendly message and exit successfully.[cite:82][cite:88]
2. If branch detection fails, use a safe fallback and mark the work as untracked.
3. Multiple models may appear in one session, so cost must be summed per model, not per session average.[cite:69][cite:70][cite:71]
4. Running ingest twice must not duplicate the same usage event.
5. Notion and GitHub rate limits should be respected.[cite:97][cite:104]
6. On Pro or Max subscriptions, displayed dollar values are estimated using API-equivalent pricing, not necessarily billed line items.[cite:30][cite:72]

---

## Deliverable definition

After Phase 5, Tokentrail is considered MVP-complete. At that point it must:
- Parse Claude Code usage data locally.[cite:82][cite:86]
- Attribute usage to branches and features.
- Aggregate cost into daily feature rollups.
- Print a clean local report from the CLI.

Phases 6 through 8 improve reporting and automation, but the core trail should already be visible by the end of Phase 5.
