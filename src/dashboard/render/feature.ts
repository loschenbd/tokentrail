import type { FeatureDetailVM } from '../data/feature.js';
import { escapeHtml } from './shell.js';

export function renderFeature(vm: FeatureDetailVM): string {
  return `
<div class="single-col">
  <div class="card">
    <div class="label">${escapeHtml(vm.featureKey)} · ${vm.sessionCount} sessions · ${vm.branches.length === 0 ? 'no branches' : vm.branches.map((b) => escapeHtml(b)).join(', ')}</div>
    <div class="hero">${escapeHtml(vm.featureName)}</div>
    <div class="kicker">$${vm.totalUsd.toFixed(0)}</div>
    <div class="delta ${vm.deltaPct >= 0 ? 'up' : 'down'}">${vm.deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(vm.deltaPct)}% vs prior</div>
  </div>

  <div class="card chart-card">
    <div class="label">Lifecycle</div>
    <div id="trend-chart" style="width:100%;height:240px"></div>
    <script type="application/json" id="trend-data">${jsonForScriptTag(vm.dailySeries)}</script>
  </div>

  <div class="card">
    <div class="label">Sessions</div>
    ${vm.sessions.length === 0 ? '<div class="muted">No sessions in window.</div>' : renderSessions(vm.sessions)}
  </div>
</div>
  `;
}

function renderSessions(items: FeatureDetailVM['sessions']): string {
  return items
    .map((s, i) => {
      const idShort = s.sessionId.slice(0, 8);
      const detailsId = `session-${i}-details`;
      return `
        <div class="session-row" data-expand-target="${detailsId}">
          <span class="amt">$${s.cost.toFixed(0)}</span>
          <span class="muted">${escapeHtml(s.date ?? '')}</span>
          <span class="sha">${idShort}</span>
          <span class="subject">${escapeHtml((s.title ?? '(no title)').slice(0, 120))}</span>
          <span class="muted">${s.commits.length} commits · ${s.prs.length} PRs</span>
        </div>
        <div class="session-details" id="${detailsId}">
          ${renderCommitsBlock(s.commits)}
          ${renderPrsBlock(s.prs)}
        </div>
      `;
    })
    .join('');
}

function renderCommitsBlock(commits: FeatureDetailVM['sessions'][number]['commits']): string {
  if (commits.length === 0) return '';
  return `<div class="sub-label">Commits</div>` + commits
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

function renderPrsBlock(prs: FeatureDetailVM['sessions'][number]['prs']): string {
  if (prs.length === 0) return '';
  return `<div class="sub-label">Pull Requests</div>` + prs
    .map(
      (p) => `<div class="pr-row"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.repo)}#${p.prNumber}</a> <span class="muted">[${escapeHtml(p.state)}]</span> <span class="subject">${escapeHtml(p.title)}</span></div>`
    )
    .join('');
}

// See overview.ts for why we don't escapeHtml() JSON inside a <script> tag.
function jsonForScriptTag(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
