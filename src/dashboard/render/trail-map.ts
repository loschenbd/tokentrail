import { escapeHtml } from './shell.js';
import type { SetupStatus } from '../data/setup-status.js';

export type TrailMapMode = 'onboarding' | 'welcome';

export function renderTrailMap(opts: { mode: TrailMapMode; setupStatus?: SetupStatus }): string {
  const cta = renderCta(opts.mode);
  const checklist = renderSetupChecklist(opts.setupStatus);
  return `
<link rel="stylesheet" href="/static/trail-map.css">
<div class="trail-map" data-trail-map>
  <div class="frame-outer">
    <div class="parchment">
      <div class="inner-border"></div>
      <div class="corners">
        <span class="corner-glyph tl">✦</span>
        <span class="corner-glyph tr">✦</span>
        <span class="corner-glyph bl">✦</span>
        <span class="corner-glyph br">✦</span>
      </div>
      ${checklist}
      <div class="map-header">
        <h1 class="map-title">Tokentrail</h1>
        <p class="map-tagline">Here be tokens</p>
      </div>
      <hr class="rule">
      <div class="map-wrap">
        <pre class="ascii-map" id="ascii" aria-hidden="true"></pre>
      </div>
      <div class="legend">
        <div class="leg"><span class="leg-g tok-rim">(</span><span class="leg-g tok-face">⊙</span><span class="leg-g tok-rim">)</span> Token step</div>
        <div class="leg"><span class="leg-g path" style="letter-spacing:-1px">────</span> Trail</div>
        <div class="leg"><span class="leg-g branch">─┬─</span> Branch</div>
        <div class="leg"><span class="leg-g merged">✕</span> Merged PR</div>
        <div class="leg"><span class="leg-g anom" style="animation:none;color:#a05252">!</span> Anomaly</div>
        <div class="leg"><span class="leg-g trophy" style="font-family:serif">⚑</span> Feature complete</div>
      </div>
      <div class="stats">
        <div class="stat">Cost Today<span class="stat-val green" id="cost-today">—</span><span class="stat-sub" id="cost-sub">of this week</span></div>
        <div class="stat">Merged PRs<span class="stat-val" id="prs">0</span><span class="stat-sub">11 total · all time</span></div>
        <div class="stat">Anomalies<span class="stat-val red" id="anom-count">—</span><span class="stat-sub" id="anom-sub">active</span></div>
        <div class="stat">Sessions<span class="stat-val" id="sess-count">—</span><span class="stat-sub">today</span></div>
      </div>
      <hr class="rule">
      <div class="cta-row">${cta}</div>
    </div>
  </div>
</div>
<script src="/static/trail-map.js" defer></script>
  `;
}

function renderCta(mode: TrailMapMode): string {
  if (mode === 'welcome') {
    return `
      <a href="/" class="btn btn-primary">Open the dashboard →</a>
      <a href="https://github.com/loschenbd/tokentrail#readme" target="_blank" rel="noopener noreferrer" class="btn btn-ghost">Read the docs</a>
    `;
  }
  const cmd = 'npm run tokentrail -- run-all';
  return `
    <a href="#" class="btn btn-primary" data-copy="${escapeHtml(cmd)}">Run a session → (copy command)</a>
    <a href="https://github.com/loschenbd/tokentrail#readme" target="_blank" rel="noopener noreferrer" class="btn btn-ghost">Read the docs</a>
  `;
}

function renderSetupChecklist(status?: SetupStatus): string {
  if (!status) return '';

  if (status.menubarApp && status.daemon && status.skills && status.hook) {
    return `
      <div class="tt-setup tt-setup-done" id="tt-setup" data-tt-setup>
        <div class="tt-done">
          <span class="tt-dot tt-dot-ok"></span>
          <span class="tt-label">Setup complete · all 4 steps installed</span>
          <a href="/welcome" class="tt-recheck">Re-check</a>
        </div>
      </div>
    `;
  }

  // CLI is implicitly installed — you're hitting this URL.
  const rows: Array<{ key: keyof SetupStatus | 'cli'; label: string; action: 'run' | 'show' | 'none' }> = [
    { key: 'cli', label: 'CLI installed', action: 'none' },
    { key: 'menubarApp', label: 'Menu-bar app', action: 'run' },
    { key: 'daemon', label: 'Dashboard daemon', action: 'run' },
    { key: 'skills', label: 'Claude Code skills', action: 'run' },
    { key: 'hook', label: 'Session-end hook (per repo)', action: 'show' },
  ];

  const ok = (k: keyof SetupStatus | 'cli'): boolean =>
    k === 'cli' ? true : status[k];

  const renderRow = (r: typeof rows[number]): string => {
    const state = ok(r.key) ? 'ok' : 'pending';
    const button =
      r.action === 'run' && !ok(r.key)
        ? `<button class="tt-action" data-action="${r.key}">Run</button>`
        : r.action === 'show' && !ok(r.key)
          ? `<button class="tt-show" data-show="${r.key}">Show command</button>`
          : '';
    return `
      <div class="tt-row" data-row="${r.key}" data-state="${state}">
        <span class="tt-dot"></span>
        <span class="tt-label">${r.label}</span>
        ${button}
        <span class="tt-error" data-error="${r.key}"></span>
      </div>
    `;
  };

  return `
    <div class="tt-setup" id="tt-setup" data-tt-setup>
      ${rows.map(renderRow).join('')}
    </div>
  `;
}
