import type { ProjectDetailVM } from '../data/project.js';
import type { BranchLifecycle } from '../data/branches.js';
import { escapeHtml } from './shell.js';
import { shadeForFeature } from '../lib/feature-colors.js';
import { renderSparkline } from './sparkline.js';
import { renderVelocityChart } from './velocity.js';

export function renderProject(vm: ProjectDetailVM): string {
  // Canonical color from the VM — never re-resolve locally, or this page
  // could disagree with the overview/menubar when hue rotation kicks in.
  const color = vm.color;
  return `
<div class="project-page pp-page" data-project-key="${escapeHtml(vm.projectKey)}" data-project-color="${escapeHtml(color)}">
  ${renderHero(vm)}
  <div class="pp-layout">
    <div class="pp-main">
      ${renderVelocity(vm, color)}
      ${renderActiveWork(vm)}
    </div>
    <div class="pp-rail">
      ${renderWorthReconciling(vm)}
      ${renderFeatures(vm, color)}
    </div>
  </div>
</div>
  `;
}

function renderHero(vm: ProjectDetailVM): string {
  const label = renderRepoLabel(vm.projectKey);
  const win = vm.dailySeries.length;
  const mostActive = vm.features.length > 0
    ? `<div class="pp-stat pp-stat-active"><div class="pp-stat-k">Most active</div><div class="pp-stat-v"><a href="/feature/${encodeURIComponent(vm.features[0]!.featureKey)}">${escapeHtml(vm.features[0]!.featureName || vm.features[0]!.featureKey)}</a> · $${vm.features[0]!.totalUsd.toFixed(0)}</div></div>`
    : '';
  return `
    <section class="card project-hero" data-section="hero">
      <div class="label">${label}</div>
      <div class="hero">${escapeHtml(vm.projectName)}</div>
      <div class="pp-statstrip">
        <div class="pp-stat"><div class="pp-stat-k">Total · ${win}d</div><div class="pp-stat-v pp-stat-total">$${formatUsdCommas(vm.totalUsd)}</div></div>
        ${renderDeltaCell(vm)}
        <div class="pp-stat"><div class="pp-stat-k">Sessions</div><div class="pp-stat-v">${vm.sessionCount}</div></div>
        <div class="pp-stat"><div class="pp-stat-k">Features</div><div class="pp-stat-v">${vm.featureCount}</div></div>
        ${mostActive}
      </div>
    </section>`;
}

function renderRepoLabel(projectKey: string): string {
  // The namespaced key in its natural case — the `.label` class renders it in
  // the Spectral naming voice (mixed-case), so no upper-casing here.
  return escapeHtml(projectKey);
}

function renderDeltaCell(vm: ProjectDetailVM): string {
  const win = vm.dailySeries.length;
  if (vm.priorUsd === 0 && vm.totalUsd > 0) {
    return `<div class="pp-stat pp-stat-delta"><div class="pp-stat-k">vs prior ${win}d</div><div class="pp-stat-v up">new project</div></div>`;
  }
  const arrow = vm.deltaPct >= 0 ? '▲' : '▼';
  const cls = vm.deltaPct >= 0 ? 'up' : 'down';
  const diff = vm.totalUsd - vm.priorUsd;
  const diffStr = `${diff >= 0 ? '+' : '−'}$${formatUsdCommas(Math.abs(diff))}`;
  return `<div class="pp-stat pp-stat-delta"><div class="pp-stat-k">vs prior ${win}d</div><div class="pp-stat-v ${cls}">${arrow}${Math.abs(vm.deltaPct)}% <span class="pp-delta-diff">${diffStr}</span></div></div>`;
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
  const bg = vm.branchGraph;
  const hasBranches = !!(bg && bg.branches && bg.branches.length > 0);
  const hasCommits = vm.recentCommits.length > 0;
  if (!hasBranches && !hasCommits) {
    return `
    <section class="card" data-section="active-work">
      <div class="label">Active work · last 30d</div>
      <div class="muted">No branches touched ${escapeHtml(vm.projectName)} in this window.</div>
    </section>`;
  }
  const totalBranchUsd = hasBranches ? bg!.totalUsd : 0;
  const table = hasBranches ? renderBranchTable(bg!) : '';
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
    <section class="card" data-section="active-work">
      <div class="label">Active work · last ${bg?.days ?? 30}d <span class="amt-tag">$${totalBranchUsd.toFixed(0)}</span></div>
      ${table}
      ${commits}
    </section>`;
}

function renderBranchTable(bg: NonNullable<ProjectDetailVM['branchGraph']>): string {
  const branches = (bg.branches ?? []).slice().sort((a, b) => b.totalUsd - a.totalUsd);
  const leader = branches[0]?.totalUsd || 1;

  const row = (b: BranchLifecycle): string => {
    const barPct = Math.max((b.totalUsd / leader) * 100, 1.2);
    const tick = b.status === 'merged' ? '<span class="bwork-tick">✓</span>' : '';
    // Full timestamps (lastEventAt/mergedAt) → take the date part for formatting.
    const lastDate = formatMonDay((b.mergedAt || b.lastEventAt).slice(0, 10));
    return `
      <div class="bwork-row bwork-${b.status}">
        <span class="bwork-dot"></span>
        <span class="bwork-name">${escapeHtml(b.branch)}${tick}</span>
        <span class="bwork-last">last ${lastDate}</span>
        <span class="bwork-spend"><span class="bwork-bar"><span class="bwork-fill" style="width:${barPct.toFixed(1)}%"></span></span><span class="bwork-amt">$${b.totalUsd.toFixed(0)}</span></span>
        <span class="bwork-sess">${b.sessionCount}</span>
      </div>`;
  };

  const HEAD = 10;
  const headRows = branches.slice(0, HEAD).map(row).join('');
  const tail = branches.slice(HEAD);
  let tailBlock = '';
  if (tail.length > 0) {
    const tailSum = tail.reduce((s, b) => s + b.totalUsd, 0);
    tailBlock = `
      <button class="tail-toggle" type="button" data-tail-toggle aria-expanded="false">
        <span class="tail-toggle-label">+ ${tail.length} more · $${tailSum.toFixed(0)} total</span><span class="tail-toggle-caret">›</span>
      </button>
      <div class="tail-body" hidden>${tail.map(row).join('')}</div>`;
  }
  return `
    <div class="bwork">
      <div class="bwork-head">
        <span></span>
        <span class="bwork-hlabel-l">branch</span>
        <span class="bwork-hlabel-l">last active</span>
        <span class="bwork-hlabel">spend</span>
        <span class="bwork-hlabel">sess</span>
      </div>
      ${headRows}
      ${tailBlock}
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
    color: 'var(--color-stripe-fg)',
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
  const leader = vm.features[0]!.totalUsd || 1;
  const THRESHOLD = 10;

  // Fold: rows >= $10 stay expanded; if that leaves < 5 visible, fall back to
  // the top 8 so the block never collapses to almost nothing.
  let visibleCount = vm.features.filter((f) => f.totalUsd >= THRESHOLD).length;
  if (visibleCount < 5) visibleCount = Math.min(8, vm.features.length);
  const head = vm.features.slice(0, visibleCount);
  const tail = vm.features.slice(visibleCount);

  const row = (f: ProjectDetailVM['features'][number], i: number): string => {
    const share = Math.round((f.totalUsd / denom) * 100);
    const barPct = Math.max((f.totalUsd / leader) * 100, 1.5);
    const shade = shadeForFeature(color, f.featureKey);
    const rawName = f.featureName || f.featureKey;
    const displayName = rawName.length > 40 ? rawName.slice(0, 39) + '…' : rawName;
    return `
      <a class="pfeat-row" href="/feature/${encodeURIComponent(f.featureKey)}" title="${escapeHtml(rawName)}">
        <span class="pfeat-rank">${i + 1}</span>
        <span class="pfeat-name">${escapeHtml(displayName)}</span>
        <span class="pfeat-meta"><span class="pfeat-sess">${f.sessionCount} sess</span> · <span class="pfeat-last">last ${formatMonDay(f.lastActive)}</span></span>
        <span class="pfeat-barline">
          <span class="pfeat-track"><span class="pfeat-fill" style="width:${barPct.toFixed(1)}%;background:${escapeHtml(shade)}"></span></span>
          <span class="pfeat-amt"><b>$${formatUsdCommas(f.totalUsd)}</b> · ${share}%</span>
        </span>
      </a>`;
  };

  const headRows = head.map((f, i) => row(f, i)).join('');
  let tailBlock = '';
  if (tail.length > 0) {
    const tailSum = tail.reduce((s, f) => s + f.totalUsd, 0);
    const allBelow = tail.every((f) => f.totalUsd < THRESHOLD);
    const label = allBelow
      ? `+ ${tail.length} more under $${THRESHOLD} · $${formatUsdCommas(tailSum)} total`
      : `+ ${tail.length} more · $${formatUsdCommas(tailSum)} total`;
    const tailRows = tail.map((f, i) => row(f, visibleCount + i)).join('');
    tailBlock = `
      <button class="tail-toggle" type="button" data-tail-toggle aria-expanded="false">
        <span class="tail-toggle-label">${label}</span><span class="tail-toggle-caret">›</span>
      </button>
      <div class="tail-body" hidden>${tailRows}</div>`;
  }

  return `
    <section class="card" data-section="features">
      <div class="label">Features · ${vm.features.length}</div>
      <div class="pfeat-list">${headRows}</div>
      ${tailBlock}
    </section>`;
}
