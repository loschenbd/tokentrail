Show me Tokentrail's currently-active anomalies.

1. Run `tokentrail anomaly list`. If `tokentrail` isn't on PATH (`command -v tokentrail` returns empty), look for the repo in the same locations `/rollup` checks:
   - `~/Projects/tokentrail`
   - `~/Code/tokentrail`
   - `~/src/tokentrail`
   - `~/Documents/Code/tokentrail`
   If none exist, ask me where it's cloned and don't try to guess further. Then run `cd <repo-path> && npm run tokentrail -- anomaly list`.
2. Each row looks like `#142  [spike_day]  2026-06-04  $920 — 3.1× the prior week's typical day.`
3. If output is "No active anomalies.", say "Trail is calm — no active anomalies." and stop.
4. Otherwise, parse the rows and group by kind. Show counts on the first line: `N total — spike_day: X · burning_feature: Y · hot_session: Z`.
5. Then list at most 5 spike_day + 3 burning_feature + 3 hot_session anomalies, in that order. Show the id, date, and reason. Highest multiplier first within each group.
6. End with a single line: `Dismiss any with: tokentrail anomaly dismiss <id>`.

Keep the response under 20 lines. All dollar values are estimated.

What the three anomaly kinds mean:
- `spike_day` — a single day's total cost was N× the prior week's typical day. Real outliers; usually worth investigating.
- `burning_feature` — a feature/project is racking up significant new spend this week. Catches "I started using Claude on X and didn't notice the cost climb."
- `hot_session` — a single session crossed a cost threshold. Noisy at high overall spend levels; if you see dozens, the threshold may not match your scale and bulk-dismissing them is reasonable.
