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
