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
    <div class="label">Trail elevation</div>
    <div id="trail-elevation" data-trail-elevation style="width:100%;height:240px"></div>
    <script type="application/json" id="trail-elevation-data">${jsonForScriptTag(
      vm.sessions
        .filter((s) => s.date !== null)
        .map((s) => ({ sessionId: s.sessionId, date: s.date, cost: s.cost, title: s.title }))
        .sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0))
    )}</script>
  </div>

  ${vm.clusters.length === 0 ? '' : `
  <div class="card">
    <div class="label">Topics</div>
    ${renderClusters(vm.clusters, vm.totalUsd)}
  </div>`}

  <div class="card">
    <div class="label">Sessions</div>
    ${vm.sessions.length === 0 ? '<div class="muted">No sessions in window.</div>' : renderSessions(vm.sessions)}
  </div>
</div>
  `;
}

function renderClusters(clusters: FeatureDetailVM['clusters'], totalUsd: number): string {
  const denom = totalUsd > 0 ? totalUsd : 1;
  return clusters
    .map((c, i) => {
      const share = (c.totalUsd / denom) * 100;
      const pct = Math.max(1, Math.round(share));
      const sessionsById = c.sessionIds.map((id) => `session-${id}`).join(' ');
      return `
        <div class="cluster-row" data-cluster-sessions="${escapeHtml(sessionsById)}">
          <span class="cluster-name">${escapeHtml(c.name)}</span>
          <span class="cluster-meta muted">${c.sessionCount} session${c.sessionCount === 1 ? '' : 's'} · $${c.totalUsd.toFixed(0)} · ${share.toFixed(0)}%</span>
          <div class="bar"><span style="width:${pct}%"></span></div>
        </div>
      `;
    })
    .join('');
}

function renderSessions(items: FeatureDetailVM['sessions']): string {
  return items
    .map((s, i) => {
      const idShort = s.sessionId.slice(0, 8);
      const detailsId = `session-${i}-details`;
      return `
        <div class="session-row" id="session-${escapeHtml(s.sessionId)}" data-expand-target="${detailsId}">
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

function isGithubSlug(repo: string | null): repo is string {
  if (!repo) return false;
  if (repo.startsWith('local/')) return false;
  // owner/name — single slash, both parts non-empty
  const parts = repo.split('/');
  return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0;
}

function renderCommitsBlock(commits: FeatureDetailVM['sessions'][number]['commits']): string {
  if (commits.length === 0) return '';
  return `<div class="sub-label">Commits</div>` + commits
    .map((c) => {
      const shaShort = c.sha.slice(0, 8);
      // Only link slugs that look like real GitHub repos ("owner/name", and
      // not the local/<basename> fallback that the commits backfill emits
      // when there's no GitHub origin). A bare local repo with no remote
      // gets a plain span — clicking it would 404 on github.com.
      const url = isGithubSlug(c.repo)
        ? `https://github.com/${c.repo}/commit/${c.sha}`
        : null;
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
