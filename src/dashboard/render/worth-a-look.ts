import type { WorthALookVM } from '../data/worth-a-look.js';
import { escapeHtml } from './shell.js';

export function renderWorthALook(vm: WorthALookVM): string {
  if (vm.items.length === 0) {
    return `<div class="single-col"><div class="card"><div class="hero">All quiet on the trail.</div><div class="muted">Nothing flagged as worth a look.</div></div></div>`;
  }
  const rows = vm.items
    .map((a) => {
      const href = a.featureKey
        ? `/feature/${encodeURIComponent(a.featureKey)}`
        : null;
      const label = href
        ? `<a href="${escapeHtml(href)}">${escapeHtml(a.featureKey ?? '')}</a>`
        : (a.sessionId ? `<span class="sha">${escapeHtml(a.sessionId.slice(0, 8))}…</span>` : '');
      return `
        <div class="anomaly-row anomaly-full">
          <span class="anomaly-date">${escapeHtml(a.date)}</span>
          <span class="anomaly-kind">${escapeHtml(a.kind)}</span>
          <span class="anomaly-target">${label}</span>
          <span class="anomaly-reason">${escapeHtml(a.reason)}</span>
        </div>
      `;
    })
    .join('');
  return `
<div class="single-col">
  <div class="card">
    <div class="label">Worth a look · ${vm.items.length} active</div>
    ${rows}
    <div class="muted" style="margin-top:16px">Dismiss via CLI: <code>tokentrail anomaly dismiss &lt;id&gt;</code></div>
  </div>
</div>
  `;
}
