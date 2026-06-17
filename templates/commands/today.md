Show me today's Claude Code spend via Tokentrail.

1. Run `curl -s --max-time 2 http://127.0.0.1:4920/api/today` to fetch the data.
2. If the curl fails (connection refused, timeout, non-2xx), tell me the Tokentrail dashboard isn't running and how to start it: `tokentrail dashboard --no-open` (or `npm run tokentrail -- dashboard --no-open` from the Tokentrail repo). Don't try to compute the answer any other way.
3. If the curl succeeds, parse the JSON and show:
   - Today's total (`todayUsd`) on its own line, formatted as `$X.XX`
   - Each project in `topProjects` as `<name>  $<usd>  (<share>%)` where share = usd / todayUsd
   - For projects with 2+ features, list the features nested underneath indented 2 spaces
   - The open anomaly count (`anomalyCount`) on its own line at the bottom if greater than zero

Keep the response under 15 lines. All dollar values are estimated.
