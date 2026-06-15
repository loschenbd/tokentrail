#!/usr/bin/env bash
# Tokentrail cron wrapper.
#
# Walks the full trail and writes a timestamped log line. Designed to be
# safe to run from cron, where PATH is minimal and HOME may be unset.
#
# Install (every 30 min):
#   crontab -e
#   */30 * * * * /ABSOLUTE/PATH/TO/tokentrail/scripts/cron.sh >> $HOME/.tokentrail.cron.log 2>&1
#
# Override behavior with env vars in the crontab line or via .env:
#   TOKENTRAIL_HOME    project root (defaults to the script's parent dir)
#   TOKENTRAIL_FLAGS   extra flags, e.g. --skip-sync
#   PATH               make sure node + npx are reachable

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKENTRAIL_HOME="${TOKENTRAIL_HOME:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# Ensure common Homebrew / nvm node locations are on PATH even when
# launchd / cron strip the user environment.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/current/bin"

cd "$TOKENTRAIL_HOME"

# Source .env if present so the cron job picks up GITHUB_TOKEN /
# NOTION_TOKEN / NOTION_DATABASE_ID without leaking them into the
# crontab itself.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[$STAMP] tokentrail run-all starting ${TOKENTRAIL_FLAGS:-}"
npx tsx src/index.ts run-all ${TOKENTRAIL_FLAGS:-}
echo "[$STAMP] tokentrail run-all done"
