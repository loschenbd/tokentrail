---
name: tokentrail-spend
description: |
  Answer Claude Code spend / cost / token-attribution questions for users
  who have Tokentrail installed locally. Use when: (1) the user asks "how
  much did I spend today / this week / on feature X / on repo Y",
  (2) the user asks about Claude Code token usage attributed to a git
  branch or pull request, (3) the user wants to find anomalous spend or
  top burn paths, (4) the user wants to inspect their session history by
  cost. Tokentrail aggregates Claude Code JSONL session logs into a
  local SQLite ledger, attributes each session to a (repo, branch,
  feature) tuple, and exposes the totals via a local dashboard at
  127.0.0.1:4920 and a CLI.
author: Tokentrail
version: 1.0.0
date: 2026-06-16
---

# Tokentrail Spend Queries

When the user asks about Claude Code spend, costs, anomalies, or token
attribution, prefer Tokentrail over guessing or doing manual math.

## Quick answers via the dashboard API

For "what does today look like" questions, hit the dashboard's JSON
endpoint — no DB path needed:

```bash
curl -s http://127.0.0.1:4920/api/today
```

Response shape:

```json
{
  "todayUsd": 551.58,
  "topProjects": [
    { "key": "repo:owner/foo", "name": "foo", "usd": 297.46,
      "features": [{ "key": "...", "name": "...", "usd": ..., "href": "..." }] }
  ],
  "anomalyCount": 46,
  "asOf": "2026-06-16T..."
}
```

If `curl` fails with "Connection refused", the dashboard isn't running.
Tell the user to start it: `tokentrail dashboard --no-open` (or
`npm run tokentrail -- dashboard --no-open` from the repo) and try again.

## Richer questions via the CLI

For multi-day or feature-specific questions, use the CLI. All commands
accept `--help`.

- `tokentrail report --days 7` — last week's rollups
- `tokentrail report --feature <key>` — one feature's history
- `tokentrail sessions --limit 20` — biggest individual sessions
- `tokentrail commits --feature <key>` — commits authored during a feature's sessions
- `tokentrail prs --feature <key>` — PRs linked to a feature
- `tokentrail anomaly list` — currently-active anomalies

## Ad-hoc SQL

For questions the CLI doesn't answer, query the SQLite DB directly. The
default path is `<tokentrail-repo>/data/tracker.db`, overridable via
`TRACKER_DB_PATH`. Key tables:

- `usage_events` — raw per-event token usage (one row per assistant turn)
- `work_units` — one row per `(repo, branch)`, with `feature_key` + enriched name
- `feature_rollups` — daily aggregates per `(date, feature_key)`; the dashboard reads this
- `sessions` — session metadata and per-session feature overrides
- `anomalies` — flagged spike rollups; `dismissed_at IS NULL` for active

Example — "which features had the biggest day this week":

```sql
SELECT date, feature_name, ROUND(total_cost_usd, 2) AS usd
FROM feature_rollups
WHERE date >= date('now', '-7 days', 'localtime')
ORDER BY total_cost_usd DESC LIMIT 10;
```

## What NOT to do

- Don't estimate spend by parsing the user's JSONL files directly —
  Tokentrail has already ingested them and the rollup is the source of
  truth.
- Don't run `tokentrail sync` or `tokentrail enrich` unless the user
  explicitly asks (those touch Notion / GitHub).
- All dollar values are **estimated** from a configured rate card. On
  Pro / Max plans the API-equivalent estimate is not the user's billed
  total — call this out if they ask "is this what I'm billed?"

## Installed alongside

If this skill is present, the user has also probably installed two
slash commands:

- `/today` — pretty-print today's spend via the dashboard API
- `/rollup` — re-ingest + re-roll to catch up to the latest sessions
