import type { WorthALookVM } from '../data/worth-a-look.js';
import { escapeHtml } from './shell.js';

export function renderWorthALook(vm: WorthALookVM): string {
  const activeCount = vm.items.filter((i) => !i.dismissed).length;

  // Toggle: a GET form that posts back to the same page with ?showDismissed.
  // Plain checkbox + onchange.submit() — no JS needed for the toggle itself.
  const toggleChecked = vm.showDismissed ? ' checked' : '';
  const toggleHtml = `
    <form method="get" action="/worth-a-look" class="show-dismissed-toggle">
      <label>
        <input type="checkbox" name="showDismissed" value="1"${toggleChecked} onchange="this.form.submit()">
        Show dismissed (${vm.dismissedCount})
      </label>
    </form>
  `;

  if (vm.items.length === 0) {
    const headline = vm.showDismissed
      ? 'Trail is calm — no anomalies recorded.'
      : 'Trail is calm — no active anomalies.';
    return `
<div class="single-col">
  <div class="card">
    <div class="row-between">
      <div class="label">Worth a look</div>
      ${toggleHtml}
    </div>
    <div class="hero">${escapeHtml(headline)}</div>
  </div>
</div>
    `;
  }

  const rows = vm.items.map((a) => renderRow(a)).join('');
  const summary = vm.showDismissed
    ? `${activeCount} active · ${vm.dismissedCount} dismissed`
    : `${activeCount} active`;

  return `
<div class="single-col">
  <div class="card">
    <div class="row-between">
      <div class="label">Worth a look · ${summary}</div>
      ${toggleHtml}
    </div>
    ${rows}
  </div>
</div>
  `;
}

function renderRow(a: WorthALookVM['items'][number]): string {
  const href = a.featureKey
    ? `/feature/${encodeURIComponent(a.featureKey)}`
    : null;
  const target = href
    ? `<a href="${escapeHtml(href)}">${escapeHtml(a.featureKey ?? '')}</a>`
    : (a.sessionId ? `<span class="sha">${escapeHtml(a.sessionId.slice(0, 8))}…</span>` : '');
  const action = a.dismissed ? 'restore' : 'dismiss';
  const dismissedClass = a.dismissed ? ' dismissed' : '';
  return `
    <div class="anomaly-row anomaly-full${dismissedClass}" data-anomaly-id="${a.id}">
      <span class="anomaly-date">${escapeHtml(a.date)}</span>
      <span class="anomaly-kind">${escapeHtml(a.kind)}</span>
      <span class="anomaly-target">${target}</span>
      <span class="anomaly-reason">${escapeHtml(a.reason)}</span>
      <button class="anomaly-action" data-action="${action}">${action}</button>
    </div>
  `;
}
