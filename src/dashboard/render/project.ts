import type { ProjectDetailVM } from '../data/project.js';
import { escapeHtml } from './shell.js';
import { resolveProjectColors } from '../lib/feature-colors.js';

export function renderProject(vm: ProjectDetailVM): string {
  const color = resolveProjectColors([vm.projectKey])[vm.projectKey]!;
  return `
<div class="project-page single-col" data-project-key="${escapeHtml(vm.projectKey)}" data-project-color="${escapeHtml(color)}">
  ${renderHero(vm)}
  <section class="card" data-section="velocity"></section>
  <section class="card" data-section="features"></section>
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
