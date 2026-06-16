#!/usr/bin/env node
// Tokentrail SwiftBar plugin.
//
// Filename convention: `.5m.` tells SwiftBar to re-run this script every
// 5 minutes. See https://github.com/swiftbar/SwiftBar#plugin-api for the
// full text protocol.
//
// Requires the Tokentrail dashboard server on 127.0.0.1:4920. Install:
//   brew install --cask swiftbar
//   ln -s "$PWD/scripts/menubar/tokentrail.5m.js" \
//     ~/Library/Application\ Support/SwiftBar/

'use strict';

const DASHBOARD_URL = 'http://127.0.0.1:4920';
const ENDPOINT = `${DASHBOARD_URL}/api/today`;
const REPO_URL = 'https://github.com/loschenbd/tokentrail#menu-bar-widget-swiftbar';
const FETCH_TIMEOUT_MS = 2000;

function fmtUsd(n) {
  return `$${Number(n).toFixed(2)}`;
}

function plural(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural}`;
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

function renderHappy(data) {
  const lines = [];
  lines.push(`${fmtUsd(data.todayUsd)} | font=Menlo size=12`);
  lines.push('---');

  if (data.topFeatures.length === 0) {
    lines.push('TODAY · no activity yet | color=#6b563d size=11');
  } else {
    lines.push(
      `TODAY · ${plural(data.topFeatures.length, 'feature', 'features')} · ` +
      `${plural(data.anomalyCount, 'anomaly', 'anomalies')} | color=#6b563d size=11`
    );
    lines.push('---');
    for (const f of data.topFeatures) {
      // SwiftBar splits on ` | `, so the label may not contain that token.
      const label = `${f.name}  ${fmtUsd(f.usd)}`.replace(/\s*\|\s*/g, ' ');
      lines.push(`${label} | href=${f.href}`);
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
    // SwiftBar surfaces stderr in its per-plugin log (right-click → Logs).
    // The menu bar stays clean; the breadcrumb is for debugging "server up
    // but plugin shows 'not running'" mysteries (HTTP errors, JSON parse,
    // timeout vs. ECONNREFUSED, etc.).
    console.error(`[tokentrail] ${err && err.message ? err.message : err}`);
    console.log(renderError('Tokentrail dashboard not running'));
  } finally {
    clearTimeout(timer);
  }
})();
