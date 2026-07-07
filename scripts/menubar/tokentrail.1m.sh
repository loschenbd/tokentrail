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

// TT_DASHBOARD_URL override exists for testing against a non-default port.
const DASHBOARD_URL = process.env.TT_DASHBOARD_URL || 'http://127.0.0.1:4920';
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
// Menlo here too: feature/legend rows pad into columns with padEnd/
// padStart, which only aligns in a true monospace face.
const FEATURE_STYLE = `font=Menlo size=11 color=${C_MEDIUM}`;
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

// --- Stacked-trend chart image ---------------------------------------
// SwiftBar renders `image=<base64 PNG>` menu rows via NSImage, and NSImage
// sizes a bitmap from its pHYs DPI metadata — so a 2x-pixel PNG stamped
// 144dpi displays at half its pixel size, i.e. retina-crisp. No image
// library is available in SwiftBar's stripped environment, so the PNG is
// encoded by hand: 8-bit RGBA scanlines, filter 0, zlib from node core.

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  // 144 dpi = 5669 pixels/metre — the retina half-scale signal.
  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(5669, 0);
  phys.writeUInt32BE(5669, 4);
  phys[8] = 1;
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('pHYs', phys),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// Draw the 30-day stacked area chart, column by column. Mirrors the
// dashboard trend chart: bands stack bottom-up in stackPosition order
// with the same server-resolved project colors; values between day
// points are linearly interpolated, which reproduces the area-polygon
// look at pixel resolution. Background stays transparent so the chart
// sits naturally on both light and dark menus.
const TREND_W = 480;  // 2x pixels → 240pt wide in the menu
const TREND_H = 120;  // → 60pt tall
function renderTrendImage(trend) {
  const days = (trend && trend.days) || [];
  const order = ((trend && trend.projects) || []).slice().sort((a, b) => a.stackPosition - b.stackPosition);
  if (days.length < 2 || order.length === 0) return null;
  const sums = days.map((d) => order.reduce((s, p) => s + (d.bands[p.key] || 0), 0));
  const yMax = Math.max.apply(null, sums);
  if (yMax <= 0) return null;
  const colors = order.map((p) => hexToRgb(p.color));
  const rgba = Buffer.alloc(TREND_W * TREND_H * 4);
  for (let x = 0; x < TREND_W; x++) {
    const t = (x / (TREND_W - 1)) * (days.length - 1);
    const i = Math.min(days.length - 2, Math.floor(t));
    const f = t - i;
    let cumA = 0;
    let cumB = 0;
    let floorPx = TREND_H;
    for (let b = 0; b < order.length; b++) {
      const key = order[b].key;
      cumA += days[i].bands[key] || 0;
      cumB += days[i + 1].bands[key] || 0;
      const v = cumA + (cumB - cumA) * f;
      const topPx = Math.max(0, Math.round(TREND_H - (v / yMax) * (TREND_H - 2)));
      for (let y = topPx; y < floorPx; y++) {
        const o = (y * TREND_W + x) * 4;
        rgba[o] = colors[b][0];
        rgba[o + 1] = colors[b][1];
        rgba[o + 2] = colors[b][2];
        rgba[o + 3] = 255;
      }
      floorPx = Math.min(floorPx, topPx);
    }
    // Baseline tick — 2px of dim ink wherever nothing was drawn, so
    // zero-spend days keep a continuous axis (same rationale as the
    // block sparkline's '▁' floor).
    for (let y = TREND_H - 2; y < TREND_H; y++) {
      const o = (y * TREND_W + x) * 4;
      if (rgba[o + 3] === 0) {
        rgba[o] = 139; rgba[o + 1] = 111; rgba[o + 2] = 71; rgba[o + 3] = 70;
      }
    }
  }
  return encodePng(TREND_W, TREND_H, rgba);
}

// Block glyphs for the 14-day sparkline — fallback when the server
// predates menubar.trend or the 30d window is empty. Index 0 is '▁'
// (the smallest visible block) rather than space — even a zero-spend
// day shows a baseline tick so the chart has a continuous horizontal
// axis instead of gaps that read like missing data.
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
  // Decreases are bounded at 100%, so percent always reads cleanly —
  // the old ≥50% multiplier form produced "▼ 1.6x", which is ambiguous
  // for drops. Increases ≥300% still switch to a multiplier
  // ("▲ 4.2x" = 4.2× yesterday); huge percentages of a small yesterday
  // are noise.
  if (d > 0 && abs >= 300) return arrow + ' ' + (1 + abs / 100).toFixed(1) + 'x';
  return arrow + ' ' + abs + '%';
}

// Menubar title status glyph. Two states, hot wins over live:
//   hot  — today is an unusual burn day: ≥2× the median non-zero prior
//          day in the sparkline window, past a $25 floor (so a $4
//          morning doesn't flag against a $1.50 median).
//   live — a session wrote usage events within the last 5 minutes.
const LIVE_WINDOW_MS = 5 * 60 * 1000;
const HOT_FLOOR_USD = 25;
const C_LIVE = '#2E7D32,#4CAF50';
function isLiveNow(lastEventAt) {
  if (!lastEventAt) return false;
  const t = new Date(lastEventAt).getTime();
  return Number.isFinite(t) && Date.now() - t < LIVE_WINDOW_MS;
}
function isHotDay(todayUsd, sparkline) {
  if (!Array.isArray(sparkline) || todayUsd < HOT_FLOOR_USD) return false;
  const prior = sparkline.slice(0, -1).filter((v) => v > 0).sort((a, b) => a - b);
  if (prior.length < 3) return false;  // too little history to call anything unusual
  const median = prior[Math.floor(prior.length / 2)];
  return todayUsd >= 2 * median;
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

  // Menubar title — single source of truth for today's number. The tilde
  // carries "estimated" (rule: all costs are labeled estimated) at the
  // cost of one character. A status SF Symbol precedes the number when
  // something is worth a glance: flame = unusual burn day, dot = a
  // session wrote events in the last 5 minutes. Hot wins over live.
  const hot = isHotDay(data.todayUsd, menubar.sparkline);
  const live = isLiveNow(data.lastEventAt);
  const status = hot
    ? ` sfimage=flame.fill sfcolor=${C_AMBER}`
    : (live ? ` sfimage=circle.fill sfcolor=${C_LIVE} sfsize=8` : '');
  lines.push(`~${fmtUsd(data.todayUsd)} | font=Menlo size=12${status}`);
  lines.push('---');

  // Freshness line — top of dropdown. Brand identity is already
  // carried by the menubar value and the .app icon, so the title row
  // would just be redundant.
  appendFreshness(lines, projectCount, data.lastEventAt);
  lines.push('---');

  // Stat block — right-aligned values via Menlo monospace. Today carries
  // the delta inline; Yesterday sits directly under it so the delta's
  // baseline is visible instead of implied.
  const deltaText = fmtDelta(menubar.deltaVsYesterday);
  const todayValue = deltaText ? `${fmtUsd(data.todayUsd)} ${deltaText}` : fmtUsd(data.todayUsd);
  lines.push(`${padRow('Today', todayValue)} | ${STAT_HEADLINE_FONT}`);
  lines.push(`${padRow('Yesterday', fmtUsd(menubar.yesterdayUsd))} | ${STAT_FONT}`);
  lines.push(`${padRow('Last 7d', fmtUsd(menubar.last7Usd))} | ${STAT_FONT}`);
  lines.push(`${padRow('Last 30d', fmtUsd(menubar.last30Usd))} | ${STAT_FONT}`);

  // Trend chart directly under the stat block so "Last 30d" reads as its
  // caption, followed by a micro-legend anchoring the band colors to
  // project names (NSMenu has no hover, so the chart must explain itself).
  appendTrendBlock(lines, menubar);
  lines.push('---');

  // Worth a look — SF Symbol warning triangle (yellow when active, dim
  // when none). Always present so the row isn't visually load-bearing
  // only some days.
  appendWorthALook(lines, data.anomalyCount, data.topAnomaly);
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

  lines.push('---');
  lines.push(`Open dashboard | href=${DASHBOARD_URL}/ sfimage=chart.line.uptrend.xyaxis ${ACTION_STYLE}`);
  lines.push(`Settings… | href=${DASHBOARD_URL}/settings sfimage=gear ${ACTION_STYLE}`);
  appendPowerOff(lines);
  return lines.join('\n');
}

// Trend block — 30-day stacked area chart matching the dashboard (same
// bands, same project colors), plus a micro-legend of the top 3 projects
// by 30d spend so the band colors mean something without the dashboard
// open. Falls back to the block-glyph sparkline when the server predates
// menubar.trend or the image can't be built.
function appendTrendBlock(lines, menubar) {
  let trendImg = null;
  try {
    trendImg = menubar.trend ? renderTrendImage(menubar.trend) : null;
  } catch {
    trendImg = null;
  }
  if (!trendImg) {
    const sparkText = menubar.sparkline && menubar.sparkline.length ? spark(menubar.sparkline) : '';
    if (sparkText) {
      lines.push(`${sparkText} | ${SPARK_FONT}`);
      lines.push(`last 14 days | ${SPARK_LABEL}`);
    }
    return;
  }
  lines.push(`| image=${trendImg} href=${DASHBOARD_URL}/`);
  // Micro-legend: top 3 projects by 30d total, swatch in the project's
  // band color. Names come from the server (trend.projects[].name); older
  // 0.2.7 servers lack the field, so derive a readable name from the key.
  const totals = new Map();
  for (const d of menubar.trend.days) {
    for (const [k, v] of Object.entries(d.bands)) totals.set(k, (totals.get(k) || 0) + v);
  }
  const top = menubar.trend.projects
    .map((p) => ({ ...p, total: totals.get(p.key) || 0 }))
    .filter((p) => p.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 3);
  const nameW = Math.max(LABEL_W, ...top.map((p) => projectDisplayName(p).length + 1));
  for (const p of top) {
    const label = sanitizeLabel(
      String(projectDisplayName(p)).padEnd(nameW) + ('$' + Math.round(p.total).toLocaleString('en-US')).padStart(10)
    );
    const href = p.key === '__other__' ? `${DASHBOARD_URL}/` : `${DASHBOARD_URL}/project/${encodeURIComponent(p.key)}`;
    // sfcolor as a light,dark PAIR — SwiftBar renders a single hex value
    // as the default (black) template tint; every working sfcolor in this
    // plugin is a pair. Project hues work on both appearances, so repeat.
    lines.push(`${label} | href=${href} sfimage=circle.fill sfcolor=${p.color},${p.color} sfsize=9 ${FEATURE_STYLE}`);
  }
}

function projectDisplayName(p) {
  if (p.name) return p.name;
  let k = String(p.key);
  if (k === '__other__') return 'other';
  const colon = k.indexOf(':');
  if (colon >= 0) k = k.slice(colon + 1);
  const slash = k.lastIndexOf('/');
  return slash >= 0 ? k.slice(slash + 1) : k;
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

// Worth a look — SF Symbol warning triangle, amber when active. Leads
// with the largest anomaly's dollar amount (one $400 spike matters more
// than eight $12 ones); the remaining count trails as "+N". A dim
// sub-row carries the reason and date. Falls back to the bare count
// against servers that predate topAnomaly.
function appendWorthALook(lines, anomalyCount, topAnomaly) {
  const url = `${DASHBOARD_URL}/worth-a-look`;
  if (anomalyCount > 0) {
    const value = topAnomaly
      ? `$${Math.round(topAnomaly.amount)}${anomalyCount > 1 ? ` +${anomalyCount - 1}` : ''}`
      : `${anomalyCount} active`;
    // Amber warning — promoted to bold/13 (same weight as Today)
    // because this row is a callout, not background context.
    const label = sanitizeLabel(padRow('Worth a look', value));
    lines.push(`${label} | href=${url} sfimage=exclamationmark.triangle.fill sfcolor=${C_AMBER} ${STAT_HEADLINE_FONT}`);
    if (topAnomaly) {
      // Reasons are dashboard-length prose ("`6d1a9269…` · $804 in one
      // session.") — strip markdown backticks and trailing punctuation,
      // and truncate; the row is a teaser, the click has the detail.
      let reason = String(topAnomaly.reason).replace(/`/g, '').replace(/[.\s]+$/, '');
      if (reason.length > 40) reason = reason.slice(0, 39) + '…';
      const detail = sanitizeLabel(`  ${TREE_LAST} ${reason} · ${topAnomaly.date}`);
      lines.push(`${detail} | href=${url} ${FEATURE_STYLE}`);
    }
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
