#!/bin/bash
# Tokentrail.app launcher. Opens the local dashboard in the browser.
# If the dashboard server isn't running, spawns it detached and waits
# briefly for it to come up before opening.

set -e

# Apps launched from Finder / Spotlight inherit a minimal PATH that
# excludes Homebrew. Restore the common prefixes so `tokentrail` resolves.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

URL="http://127.0.0.1:4920/"
LOG="/tmp/tokentrail-dashboard.log"

probe() {
  curl -fsS --max-time 0.4 "$URL" -o /dev/null 2>&1
}

if probe; then
  open "$URL"
  exit 0
fi

TT="$(command -v tokentrail || true)"
if [ -z "$TT" ]; then
  osascript -e 'display alert "Tokentrail not installed" message "Install with:\n\nbrew install loschenbd/tokentrail/tokentrail" as critical'
  exit 1
fi

# Spawn dashboard detached; --no-open because we open below ourselves
# after confirming the server is reachable.
nohup "$TT" dashboard --no-open >"$LOG" 2>&1 </dev/null &
disown

# Wait up to ~4 s for the server to bind
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 0.4
  if probe; then
    open "$URL"
    exit 0
  fi
done

osascript -e "display alert \"Tokentrail dashboard didn't start\" message \"See $LOG\" as critical"
exit 1
