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

See `docs/notion.md` (or the Notion sync section in this README, once it
lands in Phase 6) for the database schema and setup steps.

## Hook setup

See Phase 7. A small `Stop` hook can be registered with Claude Code so each
session adds a snapshot to the local hook log; this improves branch
attribution accuracy for recent sessions.

## Limits and caveats

- All dollar values are **estimated**, computed from the configured rate card.
  On Pro or Max subscriptions, the API-equivalent estimate is not your billed
  total.
- Branch attribution is only as accurate as your Git history at session time.
  Unmapped branches fall back to the slugified branch name.
- Tokentrail writes to a local SQLite file (`data/tracker.db`). The DB is the
  source of truth; Notion is a mirror.
