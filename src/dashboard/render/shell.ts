export type ShellOptions = {
  title: string;
  activeTab?: 'overview' | 'feature' | 'project' | 'worth-a-look';
  days: number;          // current time-window selection
  showBack?: boolean;
};

export function renderShell(opts: ShellOptions, body: string): string {
  const dayOptions = [7, 30, 90, 365];
  const range = dayOptions
    .map((d) => `<option value="${d}"${d === opts.days ? ' selected' : ''}>${d === 365 ? 'all' : `${d}d`}</option>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<link rel="stylesheet" href="/static/uPlot.min.css">
<link rel="stylesheet" href="/static/dashboard.css">
</head>
<body>
<header class="header">
  <div class="header-left">
    ${opts.showBack ? '<a class="back" href="/">← Trail</a>' : ''}
    <span class="brand">Tokentrail</span>
    <span class="brand-tag">· the trail so far</span>
  </div>
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
