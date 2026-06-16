import type { OverviewVM } from '../data/overview.js';
import { escapeHtml } from './shell.js';

export function renderOverview(vm: OverviewVM): string {
  return `
<div class="layout">
  <section class="main-col">
    <div class="card chart-card">
      <div class="label">Trend · last ${vm.windowDays} days</div>
      <div id="trend-chart" style="width:100%;height:280px"></div>
      <script type="application/json" id="trend-data">${jsonForScriptTag(vm.dailySeries)}</script>
    </div>

    <div class="card">
      <div class="label">Top burn paths</div>
      ${renderTopProjects(vm.topProjects, vm.totalUsd)}
    </div>
  </section>

  <aside class="side-col">
    <div class="card hero-card">
      <div class="label">Trail so far</div>
      <div class="hero">$${vm.totalUsd.toFixed(0)}</div>
      <div class="delta ${vm.deltaPct >= 0 ? 'up' : 'down'}">${vm.deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(vm.deltaPct)}% vs prior</div>
    </div>

    <div class="card">
      <div class="label">This week</div>
      <div class="kicker">$${vm.weekUsd.toFixed(0)}</div>
      <div class="muted">${vm.weekSessions} sessions</div>
    </div>

    <div class="card">
      <div class="label">Worth a look</div>
      ${vm.anomalies.length === 0 ? '<div class="muted">No anomalies in window.</div>' : renderAnomalies(vm.anomalies)}
      ${vm.anomalies.length > 0 ? '<div class="footer-link"><a href="/worth-a-look">See all →</a></div>' : ''}
    </div>

    <div class="card">
      <div class="label">Recent commits</div>
      ${renderCommits(vm.recentCommits)}
    </div>
  </aside>
</div>
  `;
}

function renderTopProjects(items: OverviewVM['topProjects'], totalUsd: number): string {
  if (items.length === 0) return '<div class="muted">No project activity yet.</div>';
  const denom = totalUsd > 0 ? totalUsd : 1;
  return items
    .map((p, i) => {
      const share = (p.totalUsd / denom) * 100;
      const pct = Math.max(1, Math.round(share));
      // Single-feature projects skip the project page; the feature page is
      // strictly richer (sessions + topics) and the project page would just
      // duplicate the same numbers.
      const href = p.features.length === 1
        ? `/feature/${encodeURIComponent(p.features[0]!.featureKey)}`
        : `/project/${encodeURIComponent(p.projectKey)}`;
      const featuresLabel = p.features.length === 1
        ? ''
        : `<span class="muted">· ${p.features.length} features</span>`;
      return `
        <a class="project-row" href="${href}">
          <span class="mile">${i + 1}</span>
          <span class="name">${escapeHtml(p.projectName)} ${featuresLabel}</span>
          <span class="amt">$${p.totalUsd.toFixed(0)} <span class="muted share">· ${share.toFixed(0)}%</span></span>
        </a>
        <div class="bar"><span style="width:${pct}%"></span></div>
      `;
    })
    .join('');
}

function renderAnomalies(items: OverviewVM['anomalies']): string {
  return items
    .slice(0, 5)
    .map((a) => `<div class="anomaly-row"><span class="anomaly-date">${escapeHtml(a.date)}</span><span class="anomaly-reason">${escapeHtml(a.reason)}</span></div>`)
    .join('');
}

function renderCommits(items: OverviewVM['recentCommits']): string {
  if (items.length === 0) return '<div class="muted">No commits captured yet.</div>';
  return items
    .map((c) => {
      const shaShort = c.sha.slice(0, 8);
      const url = c.repo ? `https://github.com/${c.repo}/commit/${c.sha}` : null;
      const sha = url
        ? `<a class="sha" href="${escapeHtml(url)}" target="_blank" rel="noopener">${shaShort}</a>`
        : `<span class="sha">${shaShort}</span>`;
      return `<div class="commit-row">${sha} <span class="subject">${escapeHtml(c.subject)}</span></div>`;
    })
    .join('');
}

// Serialize JSON for embedding inside a <script type="application/json"> tag.
// The browser does NOT decode HTML entities inside <script> raw-text content,
// so escapeHtml would produce literal "&quot;" that breaks JSON.parse. We
// escape only "<" (preventing </script> breakout) by unicode-escaping it,
// which JSON.parse accepts as a normal character.
function jsonForScriptTag(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
