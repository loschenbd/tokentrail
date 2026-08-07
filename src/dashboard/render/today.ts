import type { TodayVM } from '../data/today.js';
import { escapeHtml, jsonForScriptTag } from './shell.js';
import { renderProjectRows } from './project-rows.js';

export function renderToday(vm: TodayVM): string {
  if (isEmpty(vm)) return renderEmptyState();
  return `
${renderStrip(vm)}
<div class="layout">
  <section class="main-col">
    <div class="card">
      <div class="label">Today's burn paths</div>
      ${renderProjectRows(vm.topProjects, { staticFill: true, emptyMessage: 'No project activity today.' })}
    </div>

    <div class="card">
      <div class="label">Sessions today · ${vm.sessions.length}</div>
      ${renderSessions(vm.sessions)}
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
      <div class="label">Shipped today</div>
      ${renderShipped(vm.shipped)}
    </div>

    <div class="card">
      <div class="label">Worth a look</div>
      ${vm.anomalies.length === 0 ? '<div class="muted">No anomalies today.</div>' : renderAnomalies(vm.anomalies)}
      ${vm.anomalies.length > 0 ? '<div class="footer-link"><a href="/worth-a-look">See all →</a></div>' : ''}
    </div>
  </aside>
</div>
<script type="application/json" id="burn-paths-data">${jsonForScriptTag(vm.projectFeatureMix)}</script>
<script type="application/json" id="hour-burn-data">${jsonForScriptTag(vm.hourly.filter((h) => h.usd > 0))}</script>
  `;
}

function renderStrip(vm: TodayVM): string {
  const max = Math.max(...vm.hourly.map((h) => h.usd), 0.01);
  const bars = vm.hourly
    .map((h) => {
      // Column height encodes the hour's total; each stacked segment is a
      // project, sized by its share of the hour and painted its project color
      // (segments arrive sorted desc, biggest sits at the base via column-reverse).
      const colHeight = Math.round((h.usd / max) * 100);
      const segs =
        h.usd > 0 && h.projects.length > 0
          ? h.projects
              .map((p) => `<span class="hour-seg" style="flex:${p.usd};background:${p.color}"></span>`)
              .join('')
          : '';
      return `<div class="hour-bar" data-hour="${h.hour}"><div class="hour-col" style="height:${colHeight}%">${segs}</div></div>`;
    })
    .join('');
  const pace = vm.paceUsd !== null ? ` · pace ~$${vm.paceUsd.toFixed(0)}` : '';
  const usual = vm.usualDayUsd > 0 ? ` · usual day $${vm.usualDayUsd.toFixed(0)}` : '';
  return `
<div class="card strip">
  <div class="strip-head">
    <span class="label">Burn by hour</span>
    <span class="strip-stat">$${vm.todayUsd.toFixed(0)} so far${pace}${usual}</span>
  </div>
  <div class="hour-bars">${bars}</div>
  <div class="hour-labels"><span>12a</span><span>3a</span><span>6a</span><span>9a</span><span>12p</span><span>3p</span><span>6p</span><span>9p</span></div>
</div>`;
}

function renderSessions(items: TodayVM['sessions']): string {
  if (items.length === 0) return '<div class="muted">No sessions yet today.</div>';
  return items
    .map((s) => {
      const title = s.featureKey
        ? `<a href="/feature/${encodeURIComponent(s.featureKey)}">${escapeHtml(s.title)}</a>`
        : escapeHtml(s.title);
      return `<div class="session-row">
        <span class="session-time">${s.startedAt}–${s.endedAt}</span>
        <span class="session-title">${title} <span class="muted">· ${escapeHtml(s.projectName)}</span></span>
        <span class="session-amt">$${s.usd.toFixed(s.usd < 1 ? 2 : 0)}</span>
      </div>`;
    })
    .join('');
}

function renderShipped(shipped: TodayVM['shipped']): string {
  if (shipped.prCount === 0 && shipped.commitCount === 0) {
    return '<div class="muted">Nothing shipped yet — the trail\'s still being walked.</div>';
  }
  const head = `<div class="kicker">${shipped.prCount} PR${shipped.prCount === 1 ? '' : 's'} · ${shipped.commitCount} commit${shipped.commitCount === 1 ? '' : 's'}</div>`;
  const rows = shipped.items
    .map((i) =>
      i.kind === 'pr'
        ? `<div class="pr-row"><span class="muted">${escapeHtml(i.state ?? 'pr')}</span> <span class="subject">${escapeHtml(i.title)}</span></div>`
        : `<div class="commit-row"><span class="subject">${escapeHtml(i.title)}</span></div>`
    )
    .join('');
  return head + rows;
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

function renderAnomalies(items: TodayVM['anomalies']): string {
  return items
    .slice(0, 5)
    .map(
      (a) =>
        `<div class="anomaly-row"><span class="anomaly-date">${escapeHtml(a.date)}</span><span class="anomaly-reason">${escapeHtml(a.reason)}</span></div>`
    )
    .join('');
}
