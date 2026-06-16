#!/bin/bash
# Tokentrail SwiftBar plugin.
#
# Filename convention: `.1m.` tells SwiftBar to re-run this script every
# minute. See https://github.com/swiftbar/SwiftBar#plugin-api. Pair with
# a cron entry that re-ingests at least as often (see README · Automation)
# for near-realtime totals.
#
# Requires the Tokentrail dashboard server on 127.0.0.1:4920. Install:
#   brew install --cask swiftbar
#   ln -s "$PWD/scripts/menubar/tokentrail.1m.sh" \
#     ~/Library/Application\ Support/SwiftBar/
#
# Why a bash wrapper and not `#!/usr/bin/env node`: SwiftBar launches
# plugins via launchd with a stripped PATH that excludes Homebrew
# (/opt/homebrew/bin, /usr/local/bin) and nvm (~/.nvm/...), so a bare
# `env node` shebang exits 127 and SwiftBar shows a blank menu bar
# icon with no error. This wrapper loads nvm if present, then runs the
# inline node script via stdin.
#
# <bitbar.title>Tokentrail</bitbar.title>
# <bitbar.author>Tokentrail</bitbar.author>
# <bitbar.desc>Today's Claude Code spend, refreshed every minute.</bitbar.desc>
# <bitbar.environment>[PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin]</bitbar.environment>

set -u

# Load nvm so a user's default node ends up on PATH.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" --no-use >/dev/null 2>&1
  nvm use default >/dev/null 2>&1 || nvm use node >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  cat <<'EOF'
$— | color=#8b6f47
---
Tokentrail: node not found | color=#8b6f47
Install Node.js | href=https://nodejs.org/
Refresh | refresh=true
EOF
  exit 0
fi

# Run the inline Node script via stdin so this stays a single file.
exec node - <<'NODE_PLUGIN'
'use strict';

const DASHBOARD_URL = 'http://127.0.0.1:4920';
const ENDPOINT = `${DASHBOARD_URL}/api/today`;
const REPO_URL = 'https://github.com/loschenbd/tokentrail#menu-bar-widget-swiftbar';
const FETCH_TIMEOUT_MS = 2000;

// Tree-glyph indent for nested feature rows under their project.
const TREE_BRANCH = '├';
const TREE_LAST = '└';

// SwiftBar font params. Menlo-Bold is shipped with macOS — safe to assume.
const PROJECT_FONT = 'font=Menlo-Bold size=13';
const FEATURE_STYLE = 'color=#6b563d size=11';
const META_STYLE = 'color=#6b563d size=11';

function fmtUsd(n) {
  return `$${Number(n).toFixed(2)}`;
}

function plural(n, singular, pluralForm) {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

function renderError(message) {
  return [
    `$— | color=#8b6f47`,
    `---`,
    `${message} | color=#8b6f47`,
    `Install / docs | href=${REPO_URL}`,
    `Refresh | refresh=true`,
  ].join('\n');
}

function sanitizeLabel(s) {
  // SwiftBar splits on ` | `, so the label may not contain that token.
  return String(s).replace(/\s*\|\s*/g, ' ');
}

function renderHappy(data) {
  const lines = [];
  lines.push(`${fmtUsd(data.todayUsd)} | font=Menlo size=12`);
  lines.push('---');

  if (data.topProjects.length === 0) {
    lines.push(`TODAY · no activity yet | ${META_STYLE}`);
  } else {
    lines.push(
      `TODAY · ${plural(data.topProjects.length, 'project', 'projects')} · ` +
      `${plural(data.anomalyCount, 'anomaly', 'anomalies')} | ${META_STYLE}`
    );
    lines.push('---');
    for (let i = 0; i < data.topProjects.length; i++) {
      const p = data.topProjects[i];
      const projLabel = sanitizeLabel(`${p.name}  ${fmtUsd(p.usd)}`);
      lines.push(`${projLabel} | href=${p.href} ${PROJECT_FONT}`);
      // Single-feature projects: the indented sub-row would just duplicate
      // the project row's number. Skip it to keep the dropdown compact.
      if (p.features.length > 1) {
        for (let j = 0; j < p.features.length; j++) {
          const f = p.features[j];
          const glyph = j === p.features.length - 1 ? TREE_LAST : TREE_BRANCH;
          const fLabel = sanitizeLabel(`  ${glyph} ${f.name}  ${fmtUsd(f.usd)}`);
          lines.push(`${fLabel} | href=${f.href} ${FEATURE_STYLE}`);
        }
      }
      // Divider between project groups (not after last project).
      if (i < data.topProjects.length - 1) {
        lines.push('---');
      }
    }
  }

  lines.push('---');
  lines.push(`Open dashboard | href=${DASHBOARD_URL}/`);
  lines.push('Refresh | refresh=true');
  return lines.join('\n');
}

(async () => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log(renderHappy(data));
  } catch (err) {
    console.error(`[tokentrail] ${err && err.message ? err.message : err}`);
    console.log(renderError('Tokentrail dashboard not running'));
  } finally {
    clearTimeout(timer);
  }
})();
NODE_PLUGIN
