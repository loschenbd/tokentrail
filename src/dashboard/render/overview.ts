import type { OverviewVM } from '../data/overview.js';
import { escapeHtml, jsonForScriptTag } from './shell.js';
import { claudeProjectsDir } from '../../services/jsonl-reader.js';
import { renderTrailMap } from './trail-map.js';
import { colorFor, STRIPED_SENTINEL, OTHER_KEY } from '../lib/feature-colors.js';
import { renderProjectRows } from './project-rows.js';
import { renderBudgetCard } from './budget-card.js';

export function renderOverview(vm: OverviewVM): string {
  if (isEmpty(vm)) return renderEmptyState();
  return `
<div class="layout">
  <section class="main-col">
    <div class="card chart-card">
      <div class="label">Trend · last ${vm.windowDays} days</div>
      <div class="trend-layout">
        <div id="trend-chart" style="width:100%;height:280px"></div>
        <ul id="trend-legend" class="trend-legend">
          ${renderTrendLegend(vm.projects, vm.otherProjects)}
        </ul>
      </div>
      <script type="application/json" id="trend-data">${jsonForScriptTag({ days: vm.days, projects: vm.projects, unattributed: vm.unattributed, projectColors: vm.projectColors })}</script>
    </div>

    <div class="card">
      <div class="label">Top burn paths</div>
      <script type="application/json" id="burn-paths-data">${jsonForScriptTag(vm.projectFeatureMix)}</script>
      ${renderTopProjects(vm.topProjects)}
    </div>
  </section>

  <aside class="side-col">
    <div class="card hero-card">
      <div class="label">Trail so far</div>
      <div class="hero">$${vm.totalUsd.toFixed(0)}</div>
      <div class="delta ${vm.deltaPct >= 0 ? 'up' : 'down'}">${vm.deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(vm.deltaPct)}% vs prior</div>
    </div>

    ${renderBudgetCard(vm.budget)}

    <div class="card">
      <div class="label">This week</div>
      <div class="kicker">$${vm.weekUsd.toFixed(0)}</div>
      <div class="muted">${vm.weekSessions} sessions</div>
    </div>

    <div class="card unatt-card" id="unattributed-card"></div>

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

function isEmpty(vm: OverviewVM): boolean {
  return vm.totalUsd === 0 && vm.weekUsd === 0 && vm.topProjects.length === 0;
}

function renderEmptyState(): string {
  const path = claudeProjectsDir();
  return `
${renderTrailMap({ mode: 'onboarding' })}
<div class="single-col">
<div class="card empty-state">
  <details>
    <summary class="label">Don't see your trail?</summary>
    <p>Tokentrail follows Claude Code's session logs out of
       <code>${escapeHtml(path)}</code>.</p>
    <p>If you've used Claude Code before and don't see anything here:</p>
    <ul>
      <li>Check that the path above contains <code>.jsonl</code> files</li>
      <li>Re-run <code>npm run tokentrail -- run-all --skip-sync --skip-enrich</code> to ingest</li>
      <li>If Claude Code is installed elsewhere, set <code>CLAUDE_CONFIG_DIR</code> in <code>.env</code></li>
    </ul>
    <p>If you haven't installed Claude Code yet,
       <a href="https://docs.anthropic.com/en/docs/agents/claude-code" target="_blank" rel="noopener">install it</a>,
       run a session, and refresh this page.</p>
  </details>
</div>
</div>
  `;
}

function renderTopProjects(items: OverviewVM['topProjects']): string {
  return renderProjectRows(items);
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

function renderTrendLegend(
  projects: OverviewVM['projects'],
  otherProjects: OverviewVM['otherProjects']
): string {
  // Sort descending by stackPosition: top-of-legend mirrors top-of-stack.
  // __other__ (highest stackPosition) appears first; largest real project appears last.
  const rows = [...projects].sort((a, b) => b.stackPosition - a.stackPosition);
  return rows.map((p) => {
    const clickable = p.clickable ? '1' : '0';
    const expandable = p.key === OTHER_KEY && otherProjects.length > 0;
    // Nav chevron: mobile-only affordance to open the project page, since on
    // touch a row tap now toggles focus instead of navigating. Hidden on
    // desktop via CSS (where the whole row is the click target).
    const nav = p.clickable && !expandable
      ? `<a class="legend-nav" href="/project/${encodeURIComponent(p.key)}" aria-label="Open ${escapeHtml(p.name)}" tabindex="-1">&#8250;</a>`
      : '';
    const row = `<li class="trend-legend-row" data-project-key="${escapeHtml(p.key)}" data-project-color="${escapeHtml(p.color)}" data-clickable="${clickable}"${expandable ? ' data-expandable="1" role="button" tabindex="0" aria-expanded="false"' : ''}>
      <span class="swatch" style="background:${escapeHtml(p.color)}"></span>
      <span class="name">${escapeHtml(p.name)}${expandable ? ' <span class="chevron">&#9656;</span>' : ''}</span>
      <span class="amt">$${p.totalUsd.toFixed(0)}</span>
      ${nav}
    </li>`;
    if (!expandable) return row;
    // Sub-rows are flat siblings (not a nested list): the legend <ul> is a
    // flex column and each row is its own grid, so nesting would fight both.
    const subRows = otherProjects.map((o) => `<li class="trend-legend-subrow" data-project-key="${escapeHtml(o.key)}">
      <span class="name">${escapeHtml(o.name)}</span>
      <span class="amt">$${o.totalUsd.toFixed(0)}</span>
    </li>`).join('');
    return row + subRows;
  }).join('');
}
