import { escapeHtml } from './shell.js';

export type ProjectRowItem = {
  key: string;
  name: string;
  totalUsd: number;
  pct: number;
  featureCount: number;
  color: string;
};

/**
 * Shared burn-paths row. Overview and Today MUST both render project rows
 * through this function: the .project-row CSS grid places children by the
 * exact classes below, and hand-rolled markup drifts (see the 2026-07-11
 * Today-page overlap bug).
 *
 * staticFill: Today has no trend-data JSON, so dashboard.js never injects
 * feature segments there — pass true to emit one solid segment instead.
 */
export function renderProjectRows(
  items: ProjectRowItem[],
  opts: { staticFill?: boolean; emptyMessage?: string } = {}
): string {
  if (items.length === 0) {
    return `<div class="muted">${escapeHtml(opts.emptyMessage ?? 'No project activity yet.')}</div>`;
  }
  return items
    .map((p, i) => {
      const color = escapeHtml(p.color);
      const fill = opts.staticFill
        ? `<div class="subbar-segment" style="background:${color};width:100%"></div>`
        : '';
      return `<div class="project-row" data-project-key="${escapeHtml(p.key)}" data-project-color="${color}">
          <div class="rank">${i + 1}</div>
          <span class="swatch" style="background:${color}"></span>
          <div class="name-col"><a href="/project/${encodeURIComponent(p.key)}">${escapeHtml(p.name)}</a> <span class="muted">· ${p.featureCount} features</span></div>
          <div class="amt-col">$${p.totalUsd.toFixed(0)} · ${p.pct.toFixed(0)}%</div>
          <div class="subbar" data-project-key="${escapeHtml(p.key)}" style="--pct:${p.pct}">${fill}</div>
        </div>`;
    })
    .join('');
}
