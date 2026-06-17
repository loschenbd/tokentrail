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

// Block glyphs for the 14-day sparkline (' ' is empty, '█' is the max).
const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
function spark(values) {
  const max = Math.max.apply(null, values.concat(1));
  return values
    .map(function (v) { return BLOCKS[Math.min(8, Math.round((v / max) * 8))]; })
    .join('');
}

function fmtDelta(d) {
  if (d === 0) return '—';                              // em dash
  if (d === null || d === undefined) return '';
  // JSON.stringify(Infinity) becomes null on the wire — handle both forms.
  if (d === Infinity || d === 'Infinity') return 'first day';
  const arrow = d > 0 ? '▲' : '▼';                 // ▲ / ▼
  const abs = Math.abs(d);
  if (abs >= 50) return arrow + ' ' + (1 + abs / 100).toFixed(1) + 'x';
  return arrow + ' ' + abs + '%';
}

function fmtAgo(ms) {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return secs + 's';
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + 'm';
  return Math.round(mins / 60) + 'h';
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

  // Hero row + stat block (CodexBar-inspired). Defensive: older daemons
  // without the menubar field fall back to zero state.
  const menubar = data.menubar || { sparkline: [], last7Usd: 0, last30Usd: 0, deltaVsYesterday: 0, yesterdayUsd: 0 };
  const sparkText = menubar.sparkline && menubar.sparkline.length ? spark(menubar.sparkline) : '';
  const deltaText = fmtDelta(menubar.deltaVsYesterday);
  const heroBits = [`${fmtUsd(data.todayUsd)} today`];
  if (deltaText) heroBits.push(deltaText);
  if (sparkText) heroBits.push(sparkText);
  lines.push(`${sanitizeLabel(heroBits.join('   '))} | font=Menlo size=12`);

  // lastEventAt is the timestamp of the most recent usage_event we've
  // ingested. The old `asOf = now` value always rendered "0s ago" and
  // told the user nothing about whether their data was flowing.
  const ago = data.lastEventAt ? fmtAgo(new Date(data.lastEventAt).getTime()) : '—';
  lines.push(`Last event ${ago} ago | ${META_STYLE}`);
  lines.push('---');

  // Stat rows (stacked — see spec's risk note about SwiftBar grid jank).
  lines.push(`Today      ${fmtUsd(data.todayUsd)} | ${META_STYLE}`);
  lines.push(`Last 7d    ${fmtUsd(menubar.last7Usd)} | ${META_STYLE}`);
  lines.push(`Last 30d   ${fmtUsd(menubar.last30Usd)} | ${META_STYLE}`);
  const anomaliesLabel = data.anomalyCount > 0
    ? `⚠ Worth a look   ${plural(data.anomalyCount, 'active', 'active')}`
    : `Worth a look   —`;
  lines.push(`${sanitizeLabel(anomaliesLabel)} | href=${DASHBOARD_URL}/worth-a-look ${META_STYLE}`);
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
  lines.push(`Today | href=${DASHBOARD_URL}/today`);
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
