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
#
# Hide SwiftBar's per-plugin footer (Updated X Ago, Run in Terminal,
# Disable Plugin, About, SwiftBar submenu). Our own dropdown items
# (Open dashboard, Power off) are all the user needs; SwiftBar's
# debug-oriented defaults are noise.
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
# <swiftbar.hideSwiftBar>true</swiftbar.hideSwiftBar>

set -u

# Resolve $0 through any symlinks (SwiftBar installs plugins via symlink
# from ~/Library/Application Support/SwiftBar/, so $0 is typically the
# link path, not the repo path). We need the real path to locate sibling
# scripts (tokentrail-power-off.sh) for the Power off menu action.
PLUGIN_REAL_PATH="$(perl -MCwd=abs_path -le 'print abs_path(shift)' "$0")"
export TT_POWER_OFF_SCRIPT="$(dirname "$PLUGIN_REAL_PATH")/tokentrail-power-off.sh"

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

// Brand palette as semantic tokens, with light/dark mode pairs on
// every color so the plugin reads cleanly in both appearances.
//   strong   — body / headline text (4.5:1 on parchment / dark)
//   medium   — secondary stat values, sparkline data ink
//   muted    — section labels, freshness / "ago" text (large-text 3:1)
//   amber    — warning / "Worth a look" SF Symbol (burnt amber light,
//              bright amber dark; both ≥4.5:1 against expected bg)
//   red      — destructive (Power off) — warm terracotta light, Apple
//              systemRed dark variant
const C_STRONG = '#3a2f1f,#e5d3a7';
const C_MEDIUM = '#6b563d,#c4a373';
const C_MUTED  = '#8b6f47,#c4a373';
const C_AMBER  = '#B85C00,#F5B547';
const C_RED    = '#C0392B,#FF453A';
const C_SPARK  = '#5a4630,#c4a373';

const HERO_SUB = `sfimage=clock sfcolor=${C_MUTED} color=${C_MUTED} size=12`;
// Today is the headline — promoted to bold/13 (same weight as project
// rows) so it visually anchors the dropdown. 7d/30d stay regular/12 as
// supporting context.
const STAT_HEADLINE_FONT = `font=Menlo-Bold size=13 color=${C_STRONG}`;
const STAT_FONT = `font=Menlo size=12 color=${C_MEDIUM}`;
const SPARK_FONT = `font=Menlo size=22 color=${C_SPARK}`;
const SPARK_LABEL = `color=${C_MUTED} size=10`;
const PROJECT_FONT = `font=Menlo-Bold size=13 color=${C_STRONG}`;
const FEATURE_STYLE = `color=${C_MEDIUM} size=11`;
const META_STYLE = `color=${C_MEDIUM} size=11`;
const SECTION_LABEL = `color=${C_MUTED} size=10`;
const ACTION_STYLE = `color=${C_STRONG}`;

// Right-align values in monospace columns. Adjust LABEL_W / VALUE_W to
// taste. SwiftBar uses true monospace Menlo, so padding gives clean
// column alignment without resorting to `badge=` (which renders as a
// notification-style pill on macOS).
const LABEL_W = 12;
const VALUE_W = 14;
function padRow(label, value) {
  return `${String(label).padEnd(LABEL_W)}${String(value).padStart(VALUE_W)}`;
}

function fmtUsd(n) {
  // toLocaleString gives us "1,234.56" — standard money formatting.
  // minimumFractionDigits=2 keeps cents from being dropped on whole dollars.
  return '$' + Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function plural(n, singular, pluralForm) {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

// Block glyphs for the 14-day sparkline. Index 0 is '▁' (the smallest
// visible block) rather than space — even a zero-spend day shows a
// baseline tick so the chart has a continuous horizontal axis instead
// of gaps that read like missing data.
const BLOCKS = ['▁', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
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
  const lines = [`$— | color=${C_MUTED}`, `---`];
  lines.push(`${message} | sfimage=exclamationmark.triangle sfcolor=${C_MUTED} color=${C_MUTED} size=12`);
  lines.push('---');
  lines.push(`Install / docs | href=${REPO_URL} sfimage=book ${ACTION_STYLE}`);
  appendPowerOff(lines);
  return lines.join('\n');
}

function sanitizeLabel(s) {
  // SwiftBar splits on ` | `, so the label may not contain that token.
  return String(s).replace(/\s*\|\s*/g, ' ');
}

function renderHappy(data) {
  const lines = [];
  const menubar = data.menubar || { sparkline: [], last7Usd: 0, last30Usd: 0, deltaVsYesterday: 0, yesterdayUsd: 0 };
  const projectCount = data.topProjects.length;

  // Menubar title — single source of truth for today's number.
  lines.push(`${fmtUsd(data.todayUsd)} | font=Menlo size=12`);
  lines.push('---');

  // Freshness line — top of dropdown. Brand identity is already
  // carried by the menubar value and the .app icon, so the title row
  // would just be redundant.
  appendFreshness(lines, projectCount, data.lastEventAt);
  lines.push('---');

  // Stat block — three rows, right-aligned values via Menlo monospace.
  // Today carries the delta inline so the headline number doesn't lose
  // its context once it leaves the hero.
  const deltaText = fmtDelta(menubar.deltaVsYesterday);
  const todayValue = deltaText ? `${fmtUsd(data.todayUsd)} ${deltaText}` : fmtUsd(data.todayUsd);
  lines.push(`${padRow('Today', todayValue)} | ${STAT_HEADLINE_FONT}`);
  lines.push(`${padRow('Last 7d', fmtUsd(menubar.last7Usd))} | ${STAT_FONT}`);
  lines.push(`${padRow('Last 30d', fmtUsd(menubar.last30Usd))} | ${STAT_FONT}`);
  lines.push('---');

  // Worth a look — SF Symbol warning triangle (yellow when active, dim
  // when none). Always present so the row isn't visually load-bearing
  // only some days.
  appendWorthALook(lines, data.anomalyCount);
  lines.push('---');

  // Top projects (today). Suppressed entirely when there's no activity —
  // the empty "TODAY · no activity yet" header was dead weight.
  if (projectCount > 0) {
    lines.push(`TOP PROJECTS · TODAY | ${SECTION_LABEL}`);
    // Use the widest project name as the label column width so values
    // right-align cleanly when names exceed the stat-block default
    // (e.g. "mudandsilicon" at 13 chars > LABEL_W of 12).
    const projW = Math.max(LABEL_W, ...data.topProjects.map(p => p.name.length + 1));
    for (let i = 0; i < projectCount; i++) {
      const p = data.topProjects[i];
      const projLabel = sanitizeLabel(
        String(p.name).padEnd(projW) + String(fmtUsd(p.usd)).padStart(VALUE_W)
      );
      lines.push(`${projLabel} | href=${p.href} ${PROJECT_FONT}`);
      // Features expanded inline only when there's more than one —
      // single-feature projects would just duplicate the parent row.
      if (p.features.length > 1) {
        for (let j = 0; j < p.features.length; j++) {
          const f = p.features[j];
          const glyph = j === p.features.length - 1 ? TREE_LAST : TREE_BRANCH;
          const fLabel = sanitizeLabel(`  ${glyph} ${padRow(f.name, fmtUsd(f.usd))}`);
          lines.push(`${fLabel} | href=${f.href} ${FEATURE_STYLE}`);
        }
      }
    }
  }

  // Sparkline — 14-day spend trend, rendered chunky at size=22 so it
  // reads as a real chart, not a footnote. Label below it (small dim).
  const sparkText = menubar.sparkline && menubar.sparkline.length ? spark(menubar.sparkline) : '';
  if (sparkText) {
    if (projectCount > 0) lines.push('---');
    lines.push(`${sparkText} | ${SPARK_FONT}`);
    lines.push(`last 14 days | ${SPARK_LABEL}`);
  }

  lines.push('---');
  lines.push(`Open dashboard | href=${DASHBOARD_URL}/ sfimage=chart.line.uptrend.xyaxis ${ACTION_STYLE}`);
  lines.push(`Settings… | href=${DASHBOARD_URL}/settings sfimage=gear ${ACTION_STYLE}`);
  appendPowerOff(lines);
  return lines.join('\n');
}

// Freshness row — dim "Updated Xs ago · N projects today" with clock
// SF Symbol. Brand identity is carried by the menubar title and the
// .app icon, so we don't repeat "Tokentrail" here.
function appendFreshness(lines, projectCount, lastEventAt) {
  const ago = lastEventAt ? fmtAgo(new Date(lastEventAt).getTime()) : '—';
  const projectsBit = projectCount > 0
    ? ` · ${plural(projectCount, 'project', 'projects')} today`
    : ' · no activity yet';
  lines.push(`Updated ${ago} ago${projectsBit} | ${HERO_SUB}`);
}

// Worth a look — SF Symbol warning triangle with anomaly count as a
// trailing badge-style number. Yellow when there's something to look at,
// dim when there isn't.
function appendWorthALook(lines, anomalyCount) {
  const url = `${DASHBOARD_URL}/worth-a-look`;
  if (anomalyCount > 0) {
    // Amber warning — promoted to bold/13 (same weight as Today)
    // because this row is a callout, not background context.
    const label = sanitizeLabel(padRow('Worth a look', `${anomalyCount} active`));
    lines.push(`${label} | href=${url} sfimage=exclamationmark.triangle.fill sfcolor=${C_AMBER} ${STAT_HEADLINE_FONT}`);
  } else {
    const label = sanitizeLabel(padRow('Worth a look', '—'));
    lines.push(`${label} | href=${url} sfimage=checkmark.circle sfcolor=${C_MUTED} ${STAT_FONT}`);
  }
}

// Power off menu item — kills the dashboard daemon and quits SwiftBar.
// Only rendered when the sibling script is present and executable, so
// users who haven't pulled the latest scripts/menubar/ don't see a
// broken-on-click menu item.
function appendPowerOff(lines) {
  const script = process.env.TT_POWER_OFF_SCRIPT;
  if (!script) return;
  try {
    require('fs').accessSync(script, require('fs').constants.X_OK);
  } catch {
    return;
  }
  // Text stays neutral (system label) — only the icon carries the
  // destructive-action red. Standard macOS pattern for "quit" / "log out"
  // / "delete" rows. C_RED is hex-pair (terracotta light, Apple red dark)
  // because SwiftBar's sfcolor parser doesn't recognize "systemRed".
  lines.push(`Power off | shell=${script} terminal=false sfimage=power sfcolor=${C_RED} ${ACTION_STYLE}`);
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
