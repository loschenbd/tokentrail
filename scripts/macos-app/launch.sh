#!/bin/bash
# Tokentrail.app launcher. Opens the local dashboard in the browser.
# If the dashboard server isn't running, spawns it detached and waits
# briefly for it to come up before opening. Also starts SwiftBar (for
# the menubar plugin) if it's installed and not already running.

set -e

# Apps launched from Finder / Spotlight inherit a minimal PATH that
# excludes Homebrew. Restore the common prefixes so `tokentrail` resolves.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

URL="http://127.0.0.1:4920/"
LOG="/tmp/tokentrail-dashboard.log"

# `tokentrail` resolves its SQLite path from $TRACKER_DB_PATH, falling back
# to cwd-relative `data/tracker.db`. Apps launched via Finder inherit no
# meaningful cwd, so we must pin the path explicitly — otherwise the
# dashboard spawns a fresh empty DB somewhere unhelpful and the user sees
# zero history despite having data from CLI runs. Search common locations
# for an existing DB and reuse it; otherwise fall back to the standard
# macOS Application Support location.
if [ -z "$TRACKER_DB_PATH" ]; then
  for candidate in \
    "$HOME/Projects/tokentrail/data/tracker.db" \
    "$HOME/tokentrail/data/tracker.db" \
    "$HOME/Library/Application Support/tokentrail/tracker.db"
  do
    if [ -f "$candidate" ]; then
      export TRACKER_DB_PATH="$candidate"
      break
    fi
  done
  if [ -z "$TRACKER_DB_PATH" ]; then
    export TRACKER_DB_PATH="$HOME/Library/Application Support/tokentrail/tracker.db"
  fi
fi

probe() {
  curl -fsS --max-time 0.4 "$URL" -o /dev/null 2>&1
}

# Start SwiftBar (which runs the tokentrail.1m.sh menubar plugin) if it's
# installed and not already running. Optional — silently skip otherwise.
# `-g` keeps SwiftBar from stealing focus from the browser tab we open below.
if [ -d "/Applications/SwiftBar.app" ] && ! pgrep -x SwiftBar >/dev/null 2>&1; then
  open -g -a SwiftBar 2>/dev/null || true
fi

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
