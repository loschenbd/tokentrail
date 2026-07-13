import type { ProjectDetailVM } from '../data/project.js';
import type { BranchLifecycle } from '../data/branches.js';
import { escapeHtml, jsonForScriptTag } from './shell.js';
import { shadeForFeature } from '../lib/feature-colors.js';
import { renderSparkline } from './sparkline.js';
import { renderVelocityChart } from './velocity.js';

export function renderProject(vm: ProjectDetailVM): string {
  // Canonical color from the VM — never re-resolve locally, or this page
  // could disagree with the overview/menubar when hue rotation kicks in.
  const color = vm.color;
  return `
<div class="project-page single-col" data-project-key="${escapeHtml(vm.projectKey)}" data-project-color="${escapeHtml(color)}">
  ${renderHero(vm)}
  ${renderVelocity(vm, color)}
  ${renderFeatures(vm, color)}
  ${renderActiveWork(vm)}
  ${renderWorthReconciling(vm)}
</div>
  `;
}

function renderHero(vm: ProjectDetailVM): string {
  const label = renderRepoLabel(vm.projectKey);
  const deltaLine = renderDeltaLine(vm);
  const mostActive = vm.features.length > 0
    ? `<div class="hero-most-active">most active: <a href="/feature/${encodeURIComponent(vm.features[0]!.featureKey)}">${escapeHtml(vm.features[0]!.featureName || vm.features[0]!.featureKey)}</a> <span class="muted">($${vm.features[0]!.totalUsd.toFixed(0)})</span></div>`
    : '';
  return `
    <section class="card project-hero" data-section="hero">
      <div class="label">${label}</div>
      <div class="hero">${escapeHtml(vm.projectName)}</div>
      <div class="hero-amount">$${formatUsdCommas(vm.totalUsd)}</div>
      ${deltaLine}
      <div class="hero-meta">${vm.sessionCount} sessions · ${vm.featureCount} features</div>
      ${mostActive}
    </section>`;
}

function renderRepoLabel(projectKey: string): string {
  // Preserves the existing key namespace vocabulary — the label just
  // upper-cases it so it reads like a header tag.
  return escapeHtml(projectKey.toUpperCase());
}

function renderDeltaLine(vm: ProjectDetailVM): string {
  if (vm.priorUsd === 0 && vm.totalUsd > 0) {
    return `<div class="hero-delta up">(new project)</div>`;
  }
  const arrow = vm.deltaPct >= 0 ? '▲' : '▼';
  const cls = vm.deltaPct >= 0 ? 'up' : 'down';
  const diff = vm.totalUsd - vm.priorUsd;
  const diffStr = `$${formatUsdCommas(Math.abs(diff))} ${diff >= 0 ? 'more' : 'less'}`;
  return `<div class="hero-delta ${cls}">${arrow}${Math.abs(vm.deltaPct)}% vs prior · <span class="muted">${diffStr}</span></div>`;
}

function formatUsdCommas(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function renderVelocity(vm: ProjectDetailVM, color: string): string {
  const chart = renderVelocityChart({
    days: vm.dailySeries.map((d) => ({ date: d.date, total: d.total })),
    color,
    peakDate: vm.peakDay?.date ?? null,
  });
  const ws = vm.weekStats;
  const statLine = `$${formatUsdCommas(vm.totalUsd)} total · $${Math.round(vm.avgUsdPerDay)}/day avg · ${vm.deltaPct >= 0 ? '▲' : '▼'}${Math.abs(vm.deltaPct)}% vs prior ${vm.dailySeries.length}d`;
  const arrow = (n: number) => (n >= 0 ? '▲' : '▼');
  const abs = (n: number) => Math.abs(n);
  const peak = vm.peakDay
    ? `<div class="velocity-row"><span class="k">Peak day</span><span class="v">${formatMonDay(vm.peakDay.date)} · $${formatUsdCommas(vm.peakDay.totalUsd)} <span class="muted">(Feature: <a href="/feature/${encodeURIComponent(vm.peakDay.featureKey)}">${escapeHtml(vm.peakDay.featureName || vm.peakDay.featureKey)}</a>)</span></span></div>`
    : '';
  return `
    <section class="card chart-card" data-section="velocity">
      <div class="label">Velocity · last ${vm.dailySeries.length} days</div>
      <div class="velocity-stat">${statLine}</div>
      <div class="velocity-chart">${chart}</div>
      <div class="velocity-rows">
        <div class="velocity-row"><span class="k">This week</span><span class="v">$${formatUsdCommas(ws.thisWeekUsd)}  <span class="muted">${arrow(ws.thisVsLastPct)}${abs(ws.thisVsLastPct)}% vs last week</span></span></div>
        <div class="velocity-row"><span class="k">Last week</span><span class="v">$${formatUsdCommas(ws.lastWeekUsd)}  <span class="muted">${arrow(ws.lastVsPriorPct)}${abs(ws.lastVsPriorPct)}% vs prior week</span></span></div>
        ${peak}
      </div>
    </section>`;
}

function formatMonDay(iso: string): string {
  const [_, m, dRaw] = iso.split('-').map(Number);
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${MONTHS[(m ?? 1) - 1]} ${dRaw ?? 1}`;
}

function renderActiveWork(vm: ProjectDetailVM): string {
  const hasBranches = vm.branchGraph && vm.branchGraph.branches && vm.branchGraph.branches.length > 0;
  const hasCommits = vm.recentCommits.length > 0;
  if (!hasBranches && !hasCommits) {
    return `
    <section class="card" data-section="active-work">
      <div class="label">Active work · last 30d</div>
      <div class="muted">No branches touched ${escapeHtml(vm.projectName)} in this window.</div>
    </section>`;
  }
  const summary = hasBranches ? renderBranchSummary(vm.branchGraph!) : '';
  const graph = hasBranches
    ? `<div id="branch-graph" data-branch-graph style="width:100%;min-height:120px;max-height:140px;overflow:hidden"></div>
       <script type="application/json" id="branch-graph-data">${jsonForScriptTag(vm.branchGraph)}</script>`
    : '';
  const totalBranchUsd = hasBranches ? vm.branchGraph!.totalUsd : 0;
  const commits = hasCommits
    ? `<div class="commits-inline">
         <div class="label subheader">Recent commits</div>
         ${vm.recentCommits.map((c) => {
           const shaShort = c.sha.slice(0, 8);
           const url = c.repo ? `https://github.com/${c.repo}/commit/${c.sha}` : null;
           const sha = url
             ? `<a class="sha" href="${escapeHtml(url)}" target="_blank" rel="noopener">${shaShort}</a>`
             : `<span class="sha">${shaShort}</span>`;
           return `<div class="commit-row">${sha} <span class="subject">${escapeHtml(c.subject)}</span></div>`;
         }).join('')}
       </div>`
    : '';
  return `
    <section class="card chart-card" data-section="active-work">
      <div class="label">Active work · last ${vm.branchGraph?.days ?? 30}d <span class="amt-tag">$${totalBranchUsd.toFixed(0)}</span></div>
      ${graph}
      ${summary}
      ${commits}
    </section>`;
}

function renderBranchSummary(bg: NonNullable<ProjectDetailVM['branchGraph']>): string {
  const branches: BranchLifecycle[] = bg.branches ?? [];
  const bucket = (status: BranchLifecycle['status']) => branches.filter((b) => b.status === status);
  const rowFor = (label: string, status: BranchLifecycle['status']) => {
    const items = bucket(status);
    if (items.length === 0) return '';
    const inline = items.map((b) => {
      const usd = b.totalUsd > 0 ? ` <span class="muted">$${b.totalUsd.toFixed(0)}</span>` : '';
      return `<span class="bsum-name">${escapeHtml(b.branch)}${usd}</span>`;
    }).join(' · ');
    return `<div class="bsum-row"><span class="bsum-k">${label} ${items.length}</span><span class="bsum-v">${inline}</span></div>`;
  };
  return `<div class="branch-summary">
    ${rowFor('Open',   'open')}
    ${rowFor('Merged', 'merged')}
    ${rowFor('Stale',  'stale')}
  </div>`;
}

function renderWorthReconciling(vm: ProjectDetailVM): string {
  const hasAnoms = vm.anomalies.length > 0;
  const hasUnatt = vm.unattributed !== null;
  if (!hasUnatt && !hasAnoms) {
    return `<div class="reconciled-note">All clear on ${escapeHtml(vm.projectName)}.</div>`;
  }
  const unattBlock = hasUnatt
    ? renderUnattSubblock(vm, vm.unattributed!)
    : renderUnattEmpty(vm);
  const anomBlock = hasAnoms
    ? renderAnomalyRows(vm.anomalies)
    : `<div class="muted">No anomalies flagged in this window.</div>`;
  return `
    <section class="card" data-section="worth-reconciling">
      <div class="label">Worth reconciling</div>
      <div class="wr-block wr-unatt">
        <div class="wr-sub-label">Unattributed on ${escapeHtml(vm.projectName)}</div>
        ${unattBlock}
      </div>
      <div class="wr-block wr-anoms">
        <div class="wr-sub-label">Anomalies <span class="muted">${vm.anomalies.length} active</span></div>
        ${anomBlock}
      </div>
    </section>`;
}

function renderUnattEmpty(_vm: ProjectDetailVM): string {
  return `
    <div class="wr-unatt-empty">
      <span class="wr-check">✓</span> $0 <span class="muted">· all sessions attributed</span>
    </div>`;
}

function renderUnattSubblock(vm: ProjectDetailVM, u: NonNullable<ProjectDetailVM['unattributed']>): string {
  // Sparkline uses muted grey (matches overview unattributed card), NOT
  // the project's hue — visually distinguishes "reconcile" from "spend".
  const svg = renderSparkline({
    points: u.sparkline.map((p) => ({ date: p.date, totalUsd: p.usd })),
    color: '#78716a',
    width: 220,
    height: 40,
    ariaLabel: 'Unattributed sparkline',
  });
  return `
    <div class="wr-unatt-hero">$${u.totalUsd.toFixed(0)} <span class="muted">of ${escapeHtml(vm.projectName)}</span></div>
    <div class="wr-unatt-spark">${svg}</div>
    <button class="unatt-cta" type="button" data-project-cta>Run <code>tokentrail infer-mainline</code> →</button>
    <div class="unatt-cta-status" role="status" aria-live="polite" hidden></div>`;
}

function renderAnomalyRows(items: ProjectDetailVM['anomalies']): string {
  return items.map((a) => {
    const causeLine = a.cause
      ? (a.cause.kind === 'session'
          ? `<a class="wr-anom-cause" href="/session/${encodeURIComponent(a.cause.ref)}">${escapeHtml(a.cause.label)}</a>`
          : `<span class="wr-anom-cause muted">${escapeHtml(a.cause.label)}</span>`)
      : '';
    return `
      <div class="wr-anom">
        <div class="wr-anom-head"><span class="wr-anom-date">${escapeHtml(a.date)}</span> $${a.amount.toFixed(0)} — ${escapeHtml(a.reason)}</div>
        ${causeLine ? `<div class="wr-anom-cause-row">${causeLine}</div>` : ''}
      </div>`;
  }).join('');
}

function renderFeatures(vm: ProjectDetailVM, color: string): string {
  if (vm.features.length === 0) {
    return `
    <section class="card" data-section="features">
      <div class="label">Features</div>
      <div class="muted">No features in window.</div>
    </section>`;
  }
  const denom = vm.totalUsd > 0 ? vm.totalUsd : 1;
  const rows = vm.features.map((f, i) => {
    const share = Math.round((f.totalUsd / denom) * 100);
    const shade = shadeForFeature(color, f.featureKey);
    const spark = renderSparkline({
      points: f.daily,
      color: shade,
      width: 96,
      height: 18,
      ariaLabel: `${f.featureKey} 30d`,
    });
    const rawName = f.featureName || f.featureKey;
    const displayName = rawName.length > 40 ? rawName.slice(0, 39) + '…' : rawName;
    return `
      <a class="pfeat-row" href="/feature/${encodeURIComponent(f.featureKey)}" title="${escapeHtml(rawName)}">
        <span class="pfeat-rank">${i + 1}</span>
        <span class="pfeat-name">${escapeHtml(displayName)}</span>
        <span class="pfeat-amt">$${formatUsdCommas(f.totalUsd)} · ${share}%</span>
        <span class="pfeat-meta"><span class="pfeat-sess">${f.sessionCount} sess</span> · <span class="pfeat-last">last ${formatMonDay(f.lastActive)}</span></span>
        <span class="pfeat-spark">${spark}</span>
      </a>`;
  }).join('');
  return `
    <section class="card" data-section="features">
      <div class="label">Features · ${vm.features.length}</div>
      <div class="pfeat-list">${rows}</div>
    </section>`;
}
