export type SparklinePoint = { date: string; totalUsd: number };

export function renderSparkline(opts: {
  points: readonly SparklinePoint[];
  color: string;
  width?: number;
  height?: number;
  ariaLabel?: string;
}): string {
  const w = opts.width ?? 80;
  const h = opts.height ?? 16;
  const pad = 1;
  const aria = opts.ariaLabel
    ? ` aria-label="${escapeAttr(opts.ariaLabel)}"`
    : ' aria-hidden="true"';
  if (opts.points.length === 0) {
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"${aria}></svg>`;
  }
  const max = Math.max(1, ...opts.points.map((p) => p.totalUsd));
  const stepX = (w - pad * 2) / Math.max(1, opts.points.length - 1);
  const pts = opts.points.map((p, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (p.totalUsd / max) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"${aria}>` +
    // stroke via style (not the presentation attr) so callers can pass a
    // themeable CSS var (e.g. var(--color-stripe-fg)) as well as a hex hue.
    `<polyline points="${pts}" fill="none" style="stroke:${escapeAttr(opts.color)}" stroke-width="1.5" />` +
    `</svg>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
