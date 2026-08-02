<p align="center">
  <img src="docs/logo.png" alt="Tokentrail" width="180">
</p>

# Tokentrail

Tokentrail is a local-first CLI for tracing Claude Code token usage across
branches, features, and pull requests. It follows the trail from raw session
logs to feature-level cost rollups, then optionally syncs that ledger to Notion.

Site: <https://tokentrail.benjaminloschen.com>

## Quickstart

Prerequisites: Node.js 20+ and an existing
[Claude Code](https://docs.anthropic.com/en/docs/agents/claude-code) install.
Tokentrail reads the session logs Claude Code writes to `~/.claude/projects/`
— if you've never run a Claude Code session, that directory will be empty
and the dashboard will show a "no trail yet" hint instead of charts.

### Install

**Via Homebrew (recommended):**

```bash
brew install loschenbd/tokentrail/tokentrail && tokentrail init
# Or run them separately and use the onboarding wizard:
brew install loschenbd/tokentrail/tokentrail
tokentrail dashboard               # first run opens the onboarding wizard at /welcome
```

**From source:**

```bash
git clone https://github.com/loschenbd/tokentrail
cd tokentrail
npm install
npm run build
node dist/src/index.js init        # SwiftBar + daemon + Claude skills + hook + Tokentrail.app
```

After `brew install` (or `npm install`) finishes, open the dashboard and
walk through the onboarding checklist:

```bash
tokentrail dashboard
# first run opens http://127.0.0.1:4920/welcome (later runs open the Overview)
```

The checklist installs the SwiftBar plugin, registers the launchd daemon,
links the Claude Code skills, and shows you the per-repo session-end hook
command to run. Power users can skip the wizard with `tokentrail init`,
which does all of that non-interactively.

`init` walks the full setup in one shot on macOS: symlinks the SwiftBar
plugin into `~/Library/Application Support/SwiftBar/`, writes a
`com.tokentrail.daemon` launchd plist so the dashboard auto-starts at
login, symlinks the Claude Code skill and `/today` + `/rollup` +
`/anomalies` slash commands into `~/.claude/`, adds Tokentrail's Stop
hook to this repo's `.claude/settings.json`, and symlinks
`Tokentrail.app` into `~/Applications/` so the launcher is one click
away from Spotlight / LaunchPad. Re-runnable; pass `--dry-run` to
preview or `--force` to replace existing entries. Skip individual
steps with `--skip-swiftbar`, `--skip-daemon`, `--skip-hook`, or
`--skip-app`.

Once `init` finishes, the menu bar widget shows today's running total
within a minute and the dashboard is live at `http://127.0.0.1:4920`.

Want Notion sync or richer PR data? `cp .env.example .env`, add
`GITHUB_TOKEN` and/or `NOTION_TOKEN` + `NOTION_DATABASE_ID`, then run
`tokentrail enrich` and `tokentrail sync` (see **Notion sync** below).

## What Tokentrail does

- Reads Claude Code's local JSONL session logs.
- Attributes each session to a Git branch and, where available, a GitHub PR.
- Aggregates daily cost per feature.
- Renders a clean local report from the terminal.
- Optionally syncs daily rollups to a Notion database.

## How the trail is mapped

1. **Ingest.** Walk `~/.claude/projects/` and load assistant usage events.
2. **Attribute.** Resolve each `(repo, branch)` pair to a stable feature key.
3. **Enrich.** Pull PR metadata from GitHub when available.
4. **Roll up.** Group usage into daily per-feature totals.
5. **Report.** Print the trail. Optionally sync to Notion.

## How attribution works

For each session, Tokentrail walks this priority chain and stops at the
first match:

1. **Manual override** — exact `(repo, branch)` match from your
   `.tokentrail.json` (see **Customizing attribution** below).
2. **PR label** — the first non-generic label on a PR for the branch.
3. **PR title** — the PR's own title.
4. **Branch prefix** — built-in patterns plus any extras you've configured:
   - `feature/<x>` or `feat/<x>` → `<x>`
   - `fix/<x>`, `bugfix/<x>`, `hotfix/<x>` → `fix-<x>` ("Fix: …")
   - `chore/<x>` → `chore-<x>` ("Chore: …")
   - `spike/<x>` or `research/<x>` → `research-<x>` ("Research: …")
   - `deps/…` or `dependabot/…` → `deps-update` ("Dependency updates")
5. **Mainline branch** — `main`, `master`, `develop`, `staging` (plus any
   `extraMainlineBranches`). Scoped by repo so two repos' main branches
   don't collapse into one bucket.
6. **Branch slug** — fallback for anything else: the branch name,
   slugified.

To test how a given branch would be attributed without spinning up a
session, use the debug command:

```bash
tokentrail attribute --repo octo/foo --branch feature/cool-thing
# feature_key:  cool-thing
# feature_name: Cool thing
# source:       branch-prefix
# config:       (defaults — no .tokentrail.json found)
```

`--pr-title <title>` and `--pr-labels <a,b,c>` simulate enrichment signals.

### Customizing attribution

Create a `.tokentrail.json` in the repo root (or `~/.config/tokentrail/
config.json` for system-wide), or point `TOKENTRAIL_CONFIG` at any path.
All four extension knobs are optional and APPEND to the built-ins — you
can't disable defaults.

```jsonc
{
  "extraMainlineBranches": ["trunk", "production"],
  "extraBranchPatterns": [
    { "pattern": "^release/(.+)$", "keyPrefix": "release-", "namePrefix": "Release: " },
    { "pattern": "^epic/(.+)$",    "keyPrefix": "epic-",    "namePrefix": "Epic: " }
  ],
  "extraProjectsParentDirs": ["Code", "dev", "src"],
  "featureOverrides": {
    "owner/repo:feat/cryptic-branch": {
      "featureKey": "human-readable-key",
      "featureName": "Human-readable feature name"
    }
  }
}
```

See `.tokentrail.json.example` for a copy-pasteable template. The file is
gitignored by default — `featureOverrides` is where private project names
land, so you don't want it committed.

## Commands

```
tokentrail init        # One-shot setup: SwiftBar + daemon + Claude skills + hook + Tokentrail.app.
tokentrail ingest      # Load new usage events into the local ledger.
tokentrail cursor      # Track Cursor AI usage (local lines + cloud account spend).
tokentrail copilot     # Ingest GitHub Copilot CLI usage into the ledger.
tokentrail enrich      # Pull PR metadata for branches we've seen.
tokentrail rollup      # Aggregate events into daily feature rollups.
tokentrail report      # Follow token usage across recent work.
tokentrail sessions    # List sessions by cost to scan for attribution.
tokentrail commits     # Capture or show git commits authored per session.
tokentrail prs         # Capture or show GitHub PRs linked to each session.
tokentrail label       # Set, clear, or list per-session feature overrides.
tokentrail anomaly     # List, dismiss, or restore anomalies (also doable inline on the dashboard).
tokentrail attribute   # Show how attribution would bucket a given (repo, branch).
tokentrail sync        # Sync the latest ledger entries to Notion.
tokentrail run-all     # Walk the full trail end-to-end.
```

See `tokentrail <command> --help` for flags.

## Notion sync

Set up:

1. Create a Notion integration at <https://www.notion.so/profile/integrations>
   and copy the internal integration token.
2. Create a Notion database with the properties listed below.
3. Share the database with your integration (Share → Connections → add your
   integration).
4. Copy the database id from its URL — `notion.so/<workspace>/<database-id>?v=…`.
5. Add to `.env`:
   ```
   NOTION_TOKEN=secret_…
   NOTION_DATABASE_ID=…
   ```
6. Run `tokentrail sync`.

Required properties (names are exact):

| Property Name         | Type      | Notes                              |
|-----------------------|-----------|------------------------------------|
| Name                  | Title     | `{feature_key} · {date}`           |
| Date                  | Date      | Rollup date                        |
| Feature Key           | Rich Text | Stable slug                        |
| Feature Name          | Rich Text | Human-readable name                |
| Repo                  | Multi-Select | One tag per `owner/repo`. Multi-select because a single rollup can span more than one repo. |
| Branches              | Rich Text | Comma-separated list               |
| Total Cost USD        | Number    | Estimated spend                    |
| Total Input Tokens    | Number    |                                    |
| Total Output Tokens   | Number    |                                    |
| Sessions              | Number    |                                    |
| Synced At             | Date      | Timestamp                          |
| Commits               | Rich Text | Top 5 commit subjects from sessions in this rollup |

By default `sync` only re-pushes rollups whose `updated_at` is newer than
their last successful Notion sync. Use `--force` to re-push everything,
or `--days N` to restrict to a recent window.

### Page bodies

On page **create**, Tokentrail writes a structured body to each Notion
rollup page with three sections:

- **Sessions** — title and cost of each session in the rollup.
- **Pull Requests** — PR title/state with a link to GitHub.
- **Commits** — commit subject with a link to the SHA on GitHub.

Page **updates** leave the body alone by default (rewriting on every
sync would burn through Notion's rate limit). When you want to refresh
existing bodies — e.g. after `tokentrail commits --backfill` or
`tokentrail prs --backfill` — pass `--rebuild-bodies`:

```
tokentrail sync --force --rebuild-bodies
```

This lists, deletes, and re-appends every page's body content. Slow,
but only needed occasionally.

## Claude Code integrations

Two one-shot installers wire Tokentrail into any Claude Code session.

### `tokentrail install-skills`

Symlinks a skill and three slash commands into `~/.claude/`:

- **`tokentrail-spend` skill** — auto-loads when you ask any Claude Code
  session about spend, costs, anomalies, or token attribution. Tells the
  model to hit the dashboard API first, fall through to the CLI for
  richer queries, and reach for ad-hoc SQL only when needed. Example
  triggers: *"how much did I spend on archi this week?"*, *"what
  feature is burning the most?"*, *"which sessions had a spike?"*

- **`/today`** — pretty-prints today's spend from the dashboard API.
  Sample output:
  ```
  $551.59 (estimated)
  benjaminloschen  $265.67  (48%)
    benjaminloschen (main)  $180.86
    Library wine v1  $84.81
  archi  $122.27  (22%)
  tokentrail  $83.20  (15%)
  46 open anomalies
  ```

- **`/rollup`** — runs `tokentrail run-all --skip-sync --skip-enrich` to
  catch up to the latest Claude Code sessions, then re-renders the same
  summary as `/today`.

- **`/anomalies`** — lists active anomalies grouped by kind
  (`spike_day` / `burning_feature` / `hot_session`), with a one-line
  total and the dismiss command at the bottom.

Pass `--dry-run` to preview, `--force` to replace existing files. The
skill and slash commands work in any Claude Code session — they query
the dashboard at `127.0.0.1:4920`, so the dashboard server must be
running for them to return data.

### `tokentrail install-hook [--repo PATH]`

Patches a repo's `.claude/settings.json` to fire Tokentrail's session-end
hook, with the absolute path to `src/hooks/session-end.sh` auto-detected.
Omit `--repo` to patch the current directory. Idempotent — re-runs detect
an existing Tokentrail hook and update its path in place if the repo
moved (no duplicate stacking).

### What the session-end hook does

A small `Stop` hook fires at the end of every Claude Code session and writes
a JSONL snapshot of `session_id`, `branch`, `commit_sha`, and `remote` to
`~/.claude-cost-tracker/session-hooks.jsonl` (override with `TRACKER_LOG_DIR`).
On the next `tokentrail ingest` run, snapshots backfill the branch on any
usage event whose ingest-time HEAD was missing or sitting on a mainline
branch — giving you accurate attribution even for sessions where you've
since switched branches.

The hook is read-only with respect to your repo: it only reads `git rev-parse`
output and appends to its own log file.

### Manual install (alternative)

If you'd rather wire the hook by hand, copy `examples/claude-settings.example
.json` to the target repo's `.claude/settings.json` and replace
`/ABSOLUTE/PATH/TO/tokentrail/src/hooks/session-end.sh` with the actual path
on your machine.

## Cursor integration

`tokentrail cursor` tracks AI-assisted code usage from [Cursor](https://www.cursor.com),
the VS Code fork with AI superpowers. It reads two sources: local AI-authored line
counts and account-wide cloud utilization.

### What it captures

- **Local lines (Source B)** — reads Cursor's local tracking database
  (`~/.cursor/ai-tracking/ai-code-tracking.db`) and attributes line counts to
  repo/branch → feature. Metric: lines of code. Offline; no network calls.
- **Cloud account spend (Source A)** — reads your Cursor web session and calls
  cursor.com for account-wide utilization and metered USD cost. Metric: dollars
  (estimated). Requires internet and a valid session.

Unlike token-based features (Claude Code), **Cursor spend is account-wide and not
attributable per feature** — only per session day. Cursor metrics live in their own
tables and do not roll up into the `Total Cost USD` column (which is Claude-only).

### Configuration

Set these keys in `.tokentrail.json` (repo root or `~/.config/tokentrail/config.json`):

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `cursorTrackingDbPath` | string | `~/.cursor/ai-tracking/ai-code-tracking.db` | Override local tracking database path. |
| `cursorStateDbPath` | string | `~/.cursor/state.vscdb` | Override Cursor state database path (source for session cookie derivation). |
| `cursorSessionCookie` | string | (derived) | Paste a session cookie directly instead of deriving from state.vscdb. |
| `cursorCloudSpend` | boolean | `true` | Set `false` to disable cloud API calls. Source B (local lines) still works offline. |

### Privacy note

The cloud spend call is optional. Set `"cursorCloudSpend": false` in your config to
keep Cursor usage analysis entirely local and offline. Source B (line attribution)
requires no network access.

### Running the command

```bash
tokentrail cursor          # Both sources (local lines + cloud spend)
tokentrail cursor --ingest # Source B only (local AI-authored lines)
tokentrail cursor --spend  # Source A only (cloud account usage)
```

`tokentrail run-all` includes Cursor automatically (both sources) as a
non-fatal stage — if Cursor isn't installed or the cloud call fails, the
rest of the pipeline is unaffected. To turn off the network path, set
`cursorCloudSpend: false` (local line attribution still runs).

## GitHub Copilot integration

`tokentrail copilot` tracks usage from the [GitHub Copilot CLI](https://github.com/features/copilot/cli)
(the standalone `copilot`, not the older `gh copilot` extension).

### What it captures

Copilot's CLI records every model turn in a local SQLite store
(`~/.copilot/session-store.db`, honoring `$COPILOT_HOME`). Tokentrail reads it
**read-only** and writes each turn into `usage_events` with `source='copilot'` —
the same table as Claude Code — so Copilot spend **blends into your total cost**
and attributes to repo/branch/feature just like Claude. Metric: dollars
(estimated).

- **Cost** comes from Copilot's own per-turn figure (`total_nano_aiu`;
  1 AI credit = $0.01), falling back to GitHub's published per-model token rates
  for any turn missing it.
- **Attribution** uses the branch Copilot recorded at session time, resolved to a
  repo via the session's working directory (same git resolution as Claude).
- Unlike Cursor, Copilot **is** token/cost-based, so it rolls up into the
  `Total Cost USD` column and the per-source breakdown.

### Configuration

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `copilotStorePath` | string | `~/.copilot/session-store.db` (honors `$COPILOT_HOME`) | Override the Copilot CLI session-store path. |

### Running the command

```bash
tokentrail copilot                 # Ingest new Copilot turns into the ledger
tokentrail report --source copilot # Dedicated view: Copilot spend by branch + model
```

`tokentrail run-all` includes Copilot automatically as a non-fatal stage — if the
Copilot CLI isn't installed (no `~/.copilot`), the rest of the pipeline is
unaffected.

> Note: some GitHub organizations disable the Copilot CLI via policy ("not
> authorized… requires an enterprise or organization policy"). In that case no
> usage is recorded locally and there is nothing to ingest.

## Budget & burn rate

Set a monthly budget and Tokentrail tracks cycle-to-date spend against it, with
a run-rate forecast to cycle end. The budget covers **all sources you see in your
total** — Claude Code, Copilot, and Cursor combined.

```bash
tokentrail budget
```

```
Budget — cycle 2026-08-01 → 2026-09-01 (day 15/31)
────────────────────────────────────────────────────────────────
  [██████████████▸░░░░░░░░░]
  Spent      $126.40 of $200.00  (63.2%)
  Projected  $261.31 by cycle end  (130.7%) ⚠ trending over
  (estimated · Claude + Copilot + Cursor)
```

The same status surfaces in the menu-bar app as a budget bar (a caret marks the
projected month-end position; color shifts green → amber → red). All figures are
estimated.

### Configuration

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `monthlyBudgetUsd` | number | `null` (feature off) | Your monthly spend budget in USD. Omit or set `null` to hide the budget UI. |
| `budgetCycleStartDay` | number | `1` | Day of month the cycle resets (1–28; clamped to avoid short-month drift). |

```jsonc
// .tokentrail.json (or ~/.config/tokentrail/config.json)
{ "monthlyBudgetUsd": 200, "budgetCycleStartDay": 1 }
```

The forecast is a linear run-rate (spend-so-far ÷ days-elapsed × days-in-cycle).
For the first few days of a cycle that projection is too noisy to trust, so it's
suppressed ("too early to forecast") and the status reflects actual spend alone
until a few days of data accumulate.

## Automation

`tokentrail run-all` walks the full trail in one command: ingest, enrich,
roll up, and sync.

```
tokentrail run-all                # everything
tokentrail run-all --skip-sync    # local-only (no Notion)
tokentrail run-all --skip-enrich  # skip GitHub PR lookup too
```

For an unattended refresh, point cron (or a launchd job) at
`scripts/cron.sh`. The wrapper sources `.env`, normalizes `PATH` so node
is reachable when launchd strips the user environment, and stamps a log
line on start and end.

```
# Every 30 minutes, append to ~/.tokentrail.cron.log
*/30 * * * * /ABSOLUTE/PATH/TO/tokentrail/scripts/cron.sh >> $HOME/.tokentrail.cron.log 2>&1
```

Set `TOKENTRAIL_FLAGS=--skip-sync` in the crontab line for a local-only
refresh. If you're running the SwiftBar widget and want near-realtime
totals, drop the cron interval to `*/1` (every minute) and set
`TOKENTRAIL_FLAGS=--skip-sync --skip-enrich` so each tick stays cheap.

## LLM backend (optional)

Topic inference for work-on-`main` and session clustering both benefit from a
small LLM. Tokentrail supports two backends:

- **Ollama** (recommended) — local, free, private. Commit subjects and session
  titles stay on your machine.

      brew install ollama
      ollama pull qwen2.5:3b
      tokentrail llm setup           # pick "ollama"

- **OpenRouter** — cloud; sends commit subjects + session titles to a
  third-party LLM. Cheap (Haiku is ≈ $0.001 / session) but not private.

      tokentrail llm setup           # pick "openrouter", paste key

- **none** — deterministic rules only. Still useful: conventional commit
  scopes (`feat(menubar): …`) become features without any LLM.

Settings live in `~/Library/Application Support/Tokentrail/settings.json`
(macOS) or `$XDG_CONFIG_HOME/tokentrail/settings.json` (Linux). You can also
edit them from the dashboard at `http://127.0.0.1:<port>/settings`.

Environment variables (`OPENROUTER_API_KEY`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`,
`TOKENTRAIL_LLM_BACKEND`) override `settings.json`.

## Dashboard

```
npm run tokentrail -- dashboard
```

Starts a local Fastify server on `127.0.0.1:4920` and opens your browser to the
Tokentrail overview. Flags:

```
--port <n>     bind to a different port (default 4920)
--no-open      print the URL but don't auto-launch the browser
--days <n>     initial time window (default 30)
```

Anomalies on `/worth-a-look` can be dismissed and restored inline. Labeling
and sync stay on the CLI for now. Stop the dashboard with Ctrl-C.

### Per-harness views

The Overview has a **Source** picker (top-right, beside the time Window) that
re-scopes the whole page — trend chart, burn-path projects, this-week, and
unattributed — to a single harness: **Claude Code**, **GitHub Copilot**, or
**Cursor**. **All sources** (the default) shows the blended total. The picker
only lists sources that have data, and the choice rides in the URL
(`/?source=claude&days=30`) so scoped views are linkable.

Claude and Copilot are re-aggregated from `usage_events` with the *same*
attribution the blended rollup uses (so a project's scoped spend always sums
back to its share of the total). Cursor is metered per day, so its scoped view
is a single "Cursor (metered)" spend band over time. Anomalies aren't
source-tagged, so the "Worth a look" panel only populates on **All sources**.

### Menu bar app (native)

Put today's spend in your macOS menu bar. `tokentrail init` installs a
native SwiftUI app (built from source during `brew install`, so it's
ad-hoc signed and runs without a Gatekeeper prompt) into
`~/Applications/Tokentrail.app` and registers a LaunchAgent that keeps it
running across logins. Source and a standalone build script live in
[`scripts/menubar-native/`](scripts/menubar-native/).

If the app didn't build during install, add the Swift toolchain with
`xcode-select --install` and re-run `tokentrail init`.

The menu-bar title shows today's spend (`~$X.XX`), with a flame on unusual
burn days. Click it for:

- A native, interactive Swift Charts trend — hover the chart or a
  breakdown row to focus a project (every other band dims; the focused one
  is redrawn from the baseline with a day/value tooltip).
- Today / Yesterday / Last 7d / Last 30d totals, a 30-day per-project
  breakdown with an expandable tail, and a `⚠ Worth a look` row that links
  to `/worth-a-look` when there are active anomalies.
- Today's top projects (features nested underneath), each clickable
  through to its dashboard page.

It reads the dashboard daemon on port 4920. If the daemon isn't running the
title shows `$—` instead of crashing. (`init`'s launchd plist keeps the
daemon up across reboots; manage it with `launchctl unload`/`load` on
`~/Library/LaunchAgents/com.tokentrail.daemon.plist`.)

### Anomalies

Anomalies are recomputed at the end of every `tokentrail rollup` and surfaced
both in the dashboard sidebar / `/worth-a-look` page and in Notion (`Anomaly` /
`Anomaly reason` columns + the weekly digest page). Dismiss or restore one
with:

```
tokentrail anomaly dismiss <id>
tokentrail anomaly restore <id>
```

Or click the inline `dismiss` / `restore` button on each row in
`/worth-a-look`; toggle **Show dismissed** in the header to see the dismissed
rows alongside the active ones. Dismissed anomalies survive future rollup
runs.

### Topic clusters

For features with five or more sessions, Tokentrail groups them into a few
named topics (e.g. "Sidebar redesign · 5 sessions · $420") on the Feature
Detail page. Set `OPENROUTER_API_KEY` in `.env` to enable. Defaults to
`anthropic/claude-haiku-4.5` via OpenRouter; override with `OPENROUTER_MODEL`
(any OpenRouter slug — `openai/gpt-4o-mini`, `google/gemini-2.5-flash`, etc.).

Re-clustering runs at the end of every `tokentrail rollup` and only re-calls
the LLM for features whose session set has changed. Force a full re-cluster
with:

```
tokentrail cluster --force
```

Without an `OPENROUTER_API_KEY`, clustering is silently skipped — the rest of
the dashboard works as before.

### Notion schema setup (one-time)

The first time you sync to Notion after upgrading, you must add three new
columns to your Tokentrail database (via the Notion UI or the
`notion-update-data-source` MCP tool):

- `Type` — Select with options `Rollup` and `Digest`
- `Anomaly` — Checkbox
- `Anomaly reason` — Rich text

Without these columns, `tokentrail sync` will warn and continue. Existing rollup
pages keep their bodies; new ones get a `Type=Rollup` tag and a "View on
dashboard →" link at the top of the body.

## Limits and caveats

- All dollar values are **estimated**, computed from the configured rate card.
  On Pro or Max subscriptions, the API-equivalent estimate is not your billed
  total.
- Branch attribution is only as accurate as your Git history at session time.
  Unmapped branches fall back to the slugified branch name.
- Tokentrail writes to a local SQLite file (`data/tracker.db`). The DB is the
  source of truth; Notion is a mirror.
