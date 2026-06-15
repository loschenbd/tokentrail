# Tokentrail

Tokentrail is a local-first CLI for tracing Claude Code token usage across
branches, features, and pull requests. It follows the trail from raw session
logs to feature-level cost rollups, then optionally syncs that ledger to Notion.

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

By default `sync` only re-pushes rollups whose `updated_at` is newer than
their last successful Notion sync. Use `--force` to re-push everything,
or `--days N` to restrict to a recent window.

## Hook setup

A small `Stop` hook fires at the end of every Claude Code session and writes
a JSONL snapshot of `session_id`, `branch`, `commit_sha`, and `remote` to
`~/.claude-cost-tracker/session-hooks.jsonl`. On the next `tokentrail ingest`
run, snapshots backfill the branch on any usage event whose ingest-time
HEAD was missing or sitting on a mainline branch — giving you accurate
branch attribution even for sessions where you've since switched branches.

To install, for each repo you want tracked:

1. Copy `examples/claude-settings.example.json` to that repo's
   `.claude/settings.json`.
2. Replace `/ABSOLUTE/PATH/TO/tokentrail/src/hooks/session-end.sh` with the
   actual absolute path of the hook script on your machine.
3. (Optional) Override the log location with `TRACKER_LOG_DIR`.

The hook is read-only with respect to your repo: it only reads `git
rev-parse` output and appends to its own log file.

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
refresh.

## Limits and caveats

- All dollar values are **estimated**, computed from the configured rate card.
  On Pro or Max subscriptions, the API-equivalent estimate is not your billed
  total.
- Branch attribution is only as accurate as your Git history at session time.
  Unmapped branches fall back to the slugified branch name.
- Tokentrail writes to a local SQLite file (`data/tracker.db`). The DB is the
  source of truth; Notion is a mirror.
