import { escapeHtml } from './shell.js';

export type TrailMapMode = 'onboarding' | 'welcome';

export function renderTrailMap(opts: { mode: TrailMapMode }): string {
  const cta = renderCta(opts.mode);
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
      <div class="map-header">
        <p class="map-eyebrow">Chart of Token Lands · branch: project</p>
        <h1 class="map-title">Tokentrail</h1>
        <p class="map-tagline">Every token a footstep — every branch a fork in the road</p>
      </div>
      <hr class="rule">
      <div class="map-wrap">
        <div class="scale">1 coin ≈ 1.2k tokens · $ = cumulative branch cost</div>
        <pre class="ascii-map" id="ascii" aria-hidden="true"></pre>
      </div>
      <div class="legend">
        <div class="leg"><span class="leg-g tok-rim">(</span><span class="leg-g tok-face">⊙</span><span class="leg-g tok-rim">)</span> Token step</div>
        <div class="leg"><span class="leg-g path" style="letter-spacing:-1px">────</span> Trail</div>
        <div class="leg"><span class="leg-g branch">─┬─</span> Branch</div>
        <div class="leg"><span class="leg-g merged">✕</span> Merged PR</div>
        <div class="leg"><span class="leg-g anom" style="animation:none;color:#cc3333">!</span> Anomaly</div>
        <div class="leg"><span class="leg-g trophy" style="font-family:serif">⚑</span> Feature complete</div>
        <div class="leg"><span class="leg-g tree">♣</span> Forest</div>
        <div class="leg"><span class="leg-g mtn">▲</span> Mtns</div>
        <div class="leg"><span class="leg-g water">≈</span> River</div>
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
      <a href="https://github.com/loschenbd/tokentrail#readme" target="_blank" rel="noopener noreferrer" class="btn btn-ghost">Read the scrolls</a>
    `;
  }
  const cmd = 'npm run tokentrail -- run-all';
  return `
    <a href="#" class="btn btn-primary" data-copy="${escapeHtml(cmd)}">Run a session → (copy command)</a>
    <a href="https://github.com/loschenbd/tokentrail#readme" target="_blank" rel="noopener noreferrer" class="btn btn-ghost">Read the scrolls</a>
  `;
}
