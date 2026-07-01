import type { ProjectDetailVM } from '../data/project.js';
import { escapeHtml } from './shell.js';
import { resolveProjectColors, shadeForFeature } from '../lib/feature-colors.js';
import { renderSparkline } from './sparkline.js';
import { renderVelocityChart } from './velocity.js';

export function renderProject(vm: ProjectDetailVM): string {
  const color = resolveProjectColors([vm.projectKey])[vm.projectKey]!;
  return `
<div class="project-page single-col" data-project-key="${escapeHtml(vm.projectKey)}" data-project-color="${escapeHtml(color)}">
  ${renderHero(vm)}
  ${renderVelocity(vm, color)}
  ${renderFeatures(vm, color)}
  <section class="card" data-section="active-work"></section>
  <section class="card" data-section="worth-reconciling"></section>
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
