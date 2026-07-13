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

# A failed probe doesn't mean nothing is running: the daemon is a
# single-threaded Node process, and a synchronous pipeline pass (startup
# migrations, a big ingest) can hold the event loop past the probe
# timeout while the port stays bound. Spawning a second instance then
# dies with EADDRINUSE and a scary "didn't start" alert for a dashboard
# that was fine. Distinguish "port held, just busy" from "not running".
port_held() {
  lsof -nP -iTCP:4920 -sTCP:LISTEN -t >/dev/null 2>&1
}

# Start SwiftBar (which runs the tokentrail.1m.sh menubar plugin) if it's
# installed and not already running. Optional — silently skip otherwise.
# `-g` keeps SwiftBar from stealing focus from the browser tab we open below.
if [ -d "/Applications/SwiftBar.app" ] && ! pgrep -x SwiftBar >/dev/null 2>&1; then
  open -g -a SwiftBar 2>/dev/null || true
fi

if probe || port_held; then
  # Running (or busy mid-pipeline) — the browser can wait out a busy
  # event loop; a second spawn can't.
  open "$URL"
  exit 0
fi

TT="$(command -v tokentrail || true)"
if [ -z "$TT" ]; then
  osascript -e 'display alert "Tokentrail not installed" message "Install with:\n\nbrew install loschenbd/tokentrail/tokentrail" as critical'
  exit 1
fi

# First-run check — has `tokentrail init` been run? `init` symlinks
# Tokentrail's Claude Code skills into ~/.claude/skills/, so the
# presence of that link is the canonical "user has set up the hook"
# signal. If missing, prompt to run init in a Terminal window before
# opening the dashboard (which would otherwise show zero history).
SKILL_LINK="$HOME/.claude/skills/tokentrail-spend"
if [ ! -e "$SKILL_LINK" ]; then
  CHOICE=$(osascript <<APPLESCRIPT 2>&1 || true
display dialog "Tokentrail needs to install its Claude Code hook so it can track your sessions.

Setup will:
  • symlink the Tokentrail skills into ~/.claude/
  • install the Stop hook into this repo's .claude/settings.json
  • start the dashboard daemon via launchd
  • install the SwiftBar menubar widget (if SwiftBar is present)

This opens Terminal so you can see the steps." with title "Welcome to Tokentrail" buttons {"Skip for now", "Run setup"} default button "Run setup" with icon note
APPLESCRIPT
)
  if echo "$CHOICE" | grep -q "Run setup"; then
    # Launch Terminal with init; it's interactive (prompts for paths,
    # confirms hook install) so the user needs to see and respond to it.
    osascript <<APPLESCRIPT
tell application "Terminal"
  activate
  do script "$TT init"
end tell
APPLESCRIPT
    exit 0
  fi
  # Skip → continue to dashboard launch with whatever state exists.
fi

# Spawn dashboard detached; --no-open because we open below ourselves
# after confirming the server is reachable.
nohup "$TT" dashboard --no-open >"$LOG" 2>&1 </dev/null &
disown

# Wait up to ~12 s for the server to bind. First boot after an upgrade
# can rescan every transcript before the pipeline settles, so give it
# room; probe() returns fast once the port answers.
for _ in $(seq 1 30); do
  sleep 0.4
  if probe; then
    open "$URL"
    exit 0
  fi
done

# Port bound but not answering yet — it started, it's just busy.
if port_held; then
  open "$URL"
  exit 0
fi

osascript -e "display alert \"Tokentrail dashboard didn't start\" message \"See $LOG\" as critical"
exit 1
