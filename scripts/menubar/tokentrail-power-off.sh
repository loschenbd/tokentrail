#!/bin/bash
# Tokentrail power-off — kills the dashboard daemon and quits SwiftBar.
# Wired into the SwiftBar plugin's dropdown as a `shell=` action.
#
# Run order matters: stop the dashboard first so SwiftBar's last refresh
# (if any) sees the "not running" state, then quit SwiftBar itself.

# pkill -f matches against the full command line, so this hits the
# `node ... tokentrail dashboard --no-open` process spawned by the .app
# launcher (or any other `tokentrail dashboard` invocation).
pkill -f "tokentrail dashboard" 2>/dev/null || true

# Clean app quit (vs. kill), so SwiftBar tears down its plugins gracefully.
osascript -e 'quit app "SwiftBar"' 2>/dev/null || true
