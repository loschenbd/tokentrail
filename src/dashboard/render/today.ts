import type { TodayVM } from '../data/today.js';
import { escapeHtml } from './shell.js';

export function renderToday(vm: TodayVM): string {
  if (isEmpty(vm)) return renderEmptyState();
  return `
<div class="layout">
  <section class="main-col">
    <div class="card">
      <div class="label">Today's burn paths</div>
      ${renderTopProjects(vm.topProjects, vm.todayUsd)}
    </div>
  </section>

  <aside class="side-col">
    <div class="card hero-card">
      <div class="label">Today</div>
      <div class="hero">$${vm.todayUsd.toFixed(0)}</div>
      <div class="delta ${vm.deltaPct >= 0 ? 'up' : 'down'}">${vm.deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(vm.deltaPct)}% vs yesterday</div>
      <div class="muted">Yesterday: $${vm.yesterdayUsd.toFixed(0)}</div>
    </div>

    <div class="card">
      <div class="label">Sessions today</div>
      <div class="kicker">${vm.sessionsToday}</div>
      <div class="muted">${vm.sessionsToday === 1 ? 'session' : 'sessions'} so far</div>
    </div>

    <div class="card">
      <div class="label">Worth a look</div>
      ${vm.anomalies.length === 0 ? '<div class="muted">No anomalies today.</div>' : renderAnomalies(vm.anomalies)}
      ${vm.anomalies.length > 0 ? '<div class="footer-link"><a href="/worth-a-look">See all →</a></div>' : ''}
    </div>
  </aside>
</div>
  `;
}

function isEmpty(vm: TodayVM): boolean {
  return vm.todayUsd === 0 && vm.sessionsToday === 0 && vm.topProjects.length === 0;
}

function renderEmptyState(): string {
  return `
<div class="single-col">
<div class="card empty-state">
  <div class="hero">No trail today yet</div>
  <p>Nothing's been logged for today's date. Run a Claude Code session and
     refresh, or check the <a href="/">Overview</a> for the longer trail.</p>
</div>
</div>
  `;
}

function renderTopProjects(items: TodayVM['topProjects'], totalUsd: number): string {
  if (items.length === 0) return '<div class="muted">No project activity today.</div>';
  const denom = totalUsd > 0 ? totalUsd : 1;
  return items
    .map((p, i) => {
      const share = (p.totalUsd / denom) * 100;
      const pct = Math.max(1, Math.round(share));
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

function renderAnomalies(items: TodayVM['anomalies']): string {
  return items
    .slice(0, 5)
    .map(
      (a) =>
        `<div class="anomaly-row"><span class="anomaly-date">${escapeHtml(a.date)}</span><span class="anomaly-reason">${escapeHtml(a.reason)}</span></div>`
    )
    .join('');
}
