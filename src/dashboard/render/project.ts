import type { ProjectDetailVM } from '../data/project.js';
import { escapeHtml } from './shell.js';

export function renderProject(vm: ProjectDetailVM): string {
  return `
<div class="single-col">
  <div class="card">
    <div class="label">${escapeHtml(vm.projectKey)} · ${vm.featureCount} feature${vm.featureCount === 1 ? '' : 's'} · ${vm.sessionCount} sessions</div>
    <div class="hero">${escapeHtml(vm.projectName)}</div>
    <div class="kicker">$${vm.totalUsd.toFixed(0)}</div>
    <div class="delta ${vm.deltaPct >= 0 ? 'up' : 'down'}">${vm.deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(vm.deltaPct)}% vs prior</div>
  </div>

  <div class="card chart-card">
    <div class="label">Trail elevation</div>
    <div id="trail-elevation" data-trail-elevation style="width:100%;height:240px"></div>
    <script type="application/json" id="trail-elevation-data">${jsonForScriptTag(
      vm.sessions
        .filter((s) => s.date !== null)
        .map((s) => ({ sessionId: s.sessionId, date: s.date, cost: s.cost, title: s.title }))
        .sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0))
    )}</script>
  </div>

  <div class="card">
    <div class="label">Features</div>
    ${vm.features.length === 0 ? '<div class="muted">No features in window.</div>' : renderFeatureList(vm.features, vm.totalUsd)}
  </div>

  ${vm.anomalies.length === 0 ? '' : `
  <div class="card">
    <div class="label">Worth a look</div>
    ${vm.anomalies.map((a) => `<div class="anomaly-row"><span class="anomaly-date">${escapeHtml(a.date)}</span><span class="anomaly-reason">${escapeHtml(a.reason)}</span></div>`).join('')}
  </div>`}

  ${vm.recentCommits.length === 0 ? '' : `
  <div class="card">
    <div class="label">Recent commits</div>
    ${vm.recentCommits.map((c) => {
      const shaShort = c.sha.slice(0, 8);
      const url = c.repo ? `https://github.com/${c.repo}/commit/${c.sha}` : null;
      const sha = url
        ? `<a class="sha" href="${escapeHtml(url)}" target="_blank" rel="noopener">${shaShort}</a>`
        : `<span class="sha">${shaShort}</span>`;
      return `<div class="commit-row">${sha} <span class="subject">${escapeHtml(c.subject)}</span></div>`;
    }).join('')}
  </div>`}
</div>
  `;
}

function renderFeatureList(items: ProjectDetailVM['features'], totalUsd: number): string {
  const denom = totalUsd > 0 ? totalUsd : 1;
  return items
    .map((f) => {
      const share = (f.totalUsd / denom) * 100;
      const pct = Math.max(1, Math.round(share));
      return `
        <a class="feature-row" href="/feature/${encodeURIComponent(f.featureKey)}">
          <span class="mile"></span>
          <span class="name">${escapeHtml(f.featureName || f.featureKey)} <span class="muted">· ${f.sessionCount} sessions</span></span>
          <span class="amt">$${f.totalUsd.toFixed(0)} <span class="muted share">· ${share.toFixed(0)}%</span></span>
        </a>
        <div class="bar"><span style="width:${pct}%"></span></div>
      `;
    })
    .join('');
}

// See overview.ts for why we don't escapeHtml() JSON inside a <script> tag.
function jsonForScriptTag(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
