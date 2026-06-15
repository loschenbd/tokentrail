#!/usr/bin/env bash
# Tokentrail Stop hook.
#
# Claude Code fires this with a JSON payload on stdin when a session ends.
# We capture session_id, timestamp, and the project's git context at stop
# time, and append a JSONL snapshot for ingest to merge in later.
#
# Install: see Phase 7 in the README. Wire it via .claude/settings.json.

set -euo pipefail

LOG_DIR="${TRACKER_LOG_DIR:-$HOME/.claude-cost-tracker}"
LOG_FILE="$LOG_DIR/session-hooks.jsonl"
mkdir -p "$LOG_DIR"

# Read the full hook payload (Claude Code sends JSON on stdin).
PAYLOAD="$(cat || true)"

# Capture git context at stop time. The session is ending right now, so
# the branch/sha here is the branch the user had checked out for the
# session — much more accurate than reading HEAD at ingest time.
BRANCH=""
COMMIT=""
REMOTE=""
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
  REMOTE="$(git remote get-url origin 2>/dev/null || true)"
fi

CWD="$PWD"
TS="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"

# Use jq when available for safe JSON construction; fall back to a
# minimal hand-built object if jq is missing.
if command -v jq >/dev/null 2>&1; then
  jq -n \
    --arg ts "$TS" \
    --arg cwd "$CWD" \
    --arg branch "$BRANCH" \
    --arg commit "$COMMIT" \
    --arg remote "$REMOTE" \
    --argjson payload "${PAYLOAD:-null}" \
    '{
      type: "stop",
      timestamp: $ts,
      cwd: $cwd,
      branch: ($branch | select(. != "")),
      commit_sha: ($commit | select(. != "")),
      remote: ($remote | select(. != "")),
      payload: $payload
    }' >> "$LOG_FILE"
else
  # No jq — emit a minimal record. We escape only the fields we control.
  printf '{"type":"stop","timestamp":"%s","cwd":"%s","branch":"%s","commit_sha":"%s","remote":"%s"}\n' \
    "$TS" "${CWD//\"/\\\"}" "${BRANCH//\"/\\\"}" "${COMMIT//\"/\\\"}" "${REMOTE//\"/\\\"}" \
    >> "$LOG_FILE"
fi
