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
  const nav = `
    <nav class="nav-tabs">
      ${navItem('overview', '/', 'Overview')}
      ${navItem('today', '/today', 'Today')}
      ${navItem('worth-a-look', '/worth-a-look', 'Worth a look')}
      ${navItem('settings', '/settings', 'Settings')}
    </nav>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
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
<script src="/static/uPlot.iife.min.js"></script>
<script src="/static/dashboard.js"></script>
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
