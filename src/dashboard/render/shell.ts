import { SCOPE_LABELS, type SourceScope } from '../data/scoped-rollup.js';

export type ShellOptions = {
  title: string;
  activeTab?: 'overview' | 'today' | 'feature' | 'project' | 'worth-a-look' | 'settings';
  days: number;          // current time-window selection
  showBack?: boolean;
  showDismissed?: boolean;
  // Harness scope for the Overview's source picker. `scope` is the current
  // selection; `scopes` is which sources have data (>= ['all']). Only rendered
  // on the Overview, and only when more than one source exists.
  scope?: SourceScope;
  scopes?: SourceScope[];
};

export function renderShell(opts: ShellOptions, body: string): string {
  // Today is always exactly one day and Settings has no time dimension —
  // the Window selector only renders on views it actually scopes.
  const showWindow = opts.activeTab !== 'today' && opts.activeTab !== 'settings';
  const dayOptions = [7, 30, 90, 365];
  const range = dayOptions
    .map((d) => `<option value="${d}"${d === opts.days ? ' selected' : ''}>${d === 365 ? 'all' : `${d}d`}</option>`)
    .join('');

  // Source picker: Overview only, and only when there's more than one harness
  // to pick between. 'all' is always first. Each selector carries the other's
  // current value as a hidden field so switching one preserves the other.
  const scope = opts.scope ?? 'all';
  const scopes = opts.scopes ?? ['all'];
  const showSource = opts.activeTab === 'overview' && scopes.length > 1;
  const sourceOptions = scopes
    .map((s) => `<option value="${s}"${s === scope ? ' selected' : ''}>${escapeHtml(SCOPE_LABELS[s])}</option>`)
    .join('');
  const sourceForm = showSource
    ? `<form method="get" class="range-form source-form">
      <label class="label" for="source">Source</label>
      <input type="hidden" name="days" value="${opts.days}">
      <select id="source" name="source" onchange="this.form.submit()">${sourceOptions}</select>
    </form>`
    : '';
  // Window keeps the current source when it submits (Overview only; other
  // views have no source dimension).
  const sourceHidden = showSource ? `<input type="hidden" name="source" value="${escapeHtml(scope)}">` : '';
  const navItem = (key: NonNullable<ShellOptions['activeTab']>, href: string, label: string): string =>
    `<a class="nav-tab${opts.activeTab === key ? ' active' : ''}" href="${href}">${label}</a>`;

  const navLinks: Array<['today' | 'overview' | 'worth-a-look' | 'settings', string, string]> = [
    ['today', '/today', 'Today'],
    ['overview', '/', 'Overview'],
    ['worth-a-look', '/worth-a-look', 'Worth a look'],
    ['settings', '/settings', 'Settings'],
  ];
  const nav = `
    <nav class="nav-tabs">
      ${navLinks.map(([key, href, label]) => navItem(key, href, label)).join('\n      ')}
    </nav>`;

  // Icons for the mobile bottom bar (inline SVG, currentColor, 22px).
  const bottomIcons: Record<'today' | 'overview' | 'worth-a-look' | 'settings', string> = {
    today: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    overview: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 14l3-4 3 3 4-6"/></svg>',
    'worth-a-look': '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z"/></svg>',
    settings: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  };
  const bottomLabels: Record<'today' | 'overview' | 'worth-a-look' | 'settings', string> = {
    today: 'Today', overview: 'Overview', 'worth-a-look': 'Worth', settings: 'Settings',
  };
  const bottomNav = `
    <nav class="bottom-nav" aria-label="Primary">
      ${navLinks.map(([key, href]) => `<a class="bottom-nav-item${opts.activeTab === key ? ' active' : ''}" href="${href}">${bottomIcons[key]}<span>${bottomLabels[key]}</span></a>`).join('\n      ')}
    </nav>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(opts.title)}</title>
<script>
// Apply the saved theme before first paint so there's no light-mode flash on
// a dark-preferred load. No stored choice = fall through to the CSS
// prefers-color-scheme default.
(function(){try{var t=localStorage.getItem('tt-theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();
</script>
<link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
<link rel="icon" type="image/png" href="/static/logo.png">
<link rel="apple-touch-icon" href="/static/logo.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#f3f1eb" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1a1917" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Tokentrail">
<link rel="stylesheet" href="/static/fonts.css">
<link rel="stylesheet" href="/static/uPlot.min.css">
<link rel="stylesheet" href="/static/dashboard.css">
</head>
<body${opts.showDismissed ? ' data-show-dismissed="1"' : ''}>
<header class="header">
  <div class="header-left">
    ${opts.showBack ? '<a class="back" href="/">← Trail</a>' : ''}
    <a class="brand-link" href="/">
      <img class="brand-mark" src="/static/logo.png" alt="" width="36" height="36">
      <span class="brand">Tokentrail</span>
    </a>
    <span class="brand-tag">· the trail so far</span>
  </div>
  <div class="header-center">${nav}</div>
  <div class="header-right">
    ${sourceForm}
    ${showWindow
      ? `<form method="get" class="range-form">
      <label class="label" for="days">Window</label>
      ${sourceHidden}
      <select id="days" name="days" onchange="this.form.submit()">${range}</select>
    </form>`
      : ''}
    <button type="button" class="theme-toggle" id="theme-toggle" aria-label="Toggle dark mode" title="Toggle light / dark">
      <svg class="ic ic-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      <svg class="ic ic-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
    </button>
  </div>
</header>
<main>${body}</main>
${bottomNav}
<script src="/static/uPlot.iife.min.js"></script>
<script src="/static/dashboard.js"></script>
<script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});}</script>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// One canonical copy — inline <script type="application/json"> payloads
// must escape '<' so user data can never close the tag.
export function jsonForScriptTag(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
