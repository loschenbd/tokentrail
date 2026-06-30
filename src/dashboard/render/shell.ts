export type ShellOptions = {
  title: string;
  activeTab?: 'overview' | 'today' | 'feature' | 'project' | 'worth-a-look' | 'settings';
  days: number;          // current time-window selection
  showBack?: boolean;
  showDismissed?: boolean;
};

export function renderShell(opts: ShellOptions, body: string): string {
  const dayOptions = [7, 30, 90, 365];
  const range = dayOptions
    .map((d) => `<option value="${d}"${d === opts.days ? ' selected' : ''}>${d === 365 ? 'all' : `${d}d`}</option>`)
    .join('');
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
<title>${escapeHtml(opts.title)}</title>
<link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
<link rel="icon" type="image/png" href="/static/logo.png">
<link rel="apple-touch-icon" href="/static/logo.png">
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
    <form method="get" class="range-form">
      <label class="label" for="days">Window</label>
      <select id="days" name="days" onchange="this.form.submit()">${range}</select>
    </form>
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
