<p align="center">
  <img src="docs/logo.png" alt="Tokentrail" width="180">
</p>

# Tokentrail

Tokentrail is a local-first CLI for tracing Claude Code token usage across
branches, features, and pull requests. It follows the trail from raw session
logs to feature-level cost rollups, then optionally syncs that ledger to Notion.

## Quickstart

Prerequisites: Node.js 20+ and an existing
[Claude Code](https://docs.anthropic.com/en/docs/agents/claude-code) install.
Tokentrail reads the session logs Claude Code writes to `~/.claude/projects/`
— if you've never run a Claude Code session, that directory will be empty
and the dashboard will show a "no trail yet" hint instead of charts.

```bash
git clone https://github.com/loschenbd/tokentrail.git
cd tokentrail
npm install
cp .env.example .env       # optional — only needed for Notion sync and PR enrich
npm run tokentrail -- run-all --skip-sync --skip-enrich
npm run tokentrail -- dashboard
```

That ingests your existing Claude Code session logs from `~/.claude/projects/`
(override with `CLAUDE_CONFIG_DIR` in `.env`), rolls them into daily per-
feature totals, and opens the dashboard at `http://127.0.0.1:4920`. Add a
`GITHUB_TOKEN` to `.env` to enrich PR data, and `NOTION_TOKEN` +
`NOTION_DATABASE_ID` to mirror to Notion (see **Notion sync** below).

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

## Commands

```
tokentrail ingest      # Load new usage events into the local ledger.
tokentrail enrich      # Pull PR metadata for branches we've seen.
tokentrail rollup      # Aggregate events into daily feature rollups.
tokentrail report      # Follow token usage across recent work.
tokentrail sessions    # List sessions by cost to scan for attribution.
tokentrail commits     # Capture or show git commits authored per session.
tokentrail prs         # Capture or show GitHub PRs linked to each session.
tokentrail label       # Set, clear, or list per-session feature overrides.
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

Two one-shot installers expose Tokentrail to your other Claude Code sessions.

```bash
tokentrail install-skills
```

Symlinks a `tokentrail-spend` skill and `/today` + `/rollup` slash commands
into `~/.claude/`. The skill auto-loads when you ask any Claude Code session
about Claude Code spend, costs, or token attribution; `/today` prints today's
totals from the dashboard API, `/rollup` runs a fresh ingest. Pass
`--dry-run` to preview, `--force` to replace existing files.

```bash
tokentrail install-hook --repo /path/to/some-project
```

Patches that repo's `.claude/settings.json` to fire Tokentrail's session-end
hook, with the absolute path to `src/hooks/session-end.sh` auto-detected.
Omit `--repo` to patch the current directory. Idempotent — re-runs detect
an existing Tokentrail hook and update its path if the repo moved.

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

The dashboard is read-only. Labeling, anomaly dismissal, and sync stay on the
CLI. Stop it with Ctrl-C.

### Menu bar widget (SwiftBar)

Put today's spend in your macOS menu bar:

```bash
brew install --cask swiftbar
mkdir -p ~/Library/Application\ Support/SwiftBar
ln -s "$PWD/scripts/menubar/tokentrail.1m.sh" \
  ~/Library/Application\ Support/SwiftBar/
```

Open SwiftBar from Spotlight; it picks up the plugin automatically. The
widget shows today's spend (`$X.XX`) and refreshes every minute. Click
it to see today's top projects, each with its constituent features
nested underneath and an anomaly count.

Requires `tokentrail dashboard` to be running on port 4920. If it isn't,
the widget shows `$—` and a "not running" hint instead of crashing.

### Anomalies

Anomalies are recomputed at the end of every `tokentrail rollup` and surfaced
both in the dashboard sidebar / `/worth-a-look` page and in Notion (`Anomaly` /
`Anomaly reason` columns + the weekly digest page). Dismiss one with:

```
tokentrail anomaly dismiss <id>
```

Dismissed anomalies survive future rollup runs.

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
