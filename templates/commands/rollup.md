Refresh Tokentrail's local data so today's totals catch up to the latest Claude Code sessions.

1. Try `tokentrail run-all --skip-sync --skip-enrich` first.
2. If `tokentrail` isn't on PATH (`command -v tokentrail` returns empty), look for the repo. Common locations to check in order:
   - `~/Projects/tokentrail`
   - `~/Code/tokentrail`
   - `~/src/tokentrail`
   - `~/Documents/Code/tokentrail`
   If none exist, ask me where it's cloned and don't try to guess further.
3. Run the rollup from that directory: `cd <repo-path> && npm run tokentrail -- run-all --skip-sync --skip-enrich`.
4. Show me the summary line printed by the rollup step (it looks like `Rollup written: N (date, feature) rows ...`).
5. Then run the equivalent of `/today` (curl `http://127.0.0.1:4920/api/today` and pretty-print) so I can see the refreshed totals.

Don't run `tokentrail sync` or `tokentrail enrich` — those touch Notion / GitHub and weren't asked for.
