export type VelocityDay = { date: string; total: number };

export function renderVelocityChart(opts: {
  days: readonly VelocityDay[];
  color: string;
  width?: number;
  height?: number;
  peakDate?: string | null;
}): string {
  const w = opts.width ?? 640;
  const h = opts.height ?? 140;
  const padLeft = 10;
  const padRight = 10;
  const padTop = 8;
  const padBottom = 18;
  const drawW = w - padLeft - padRight;
  const drawH = h - padTop - padBottom;

  if (opts.days.length === 0) {
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
  }

  const max = Math.max(1, ...opts.days.map((d) => d.total));
  const slot = drawW / opts.days.length;
  const barW = Math.max(2, slot * 0.7);

  const peakFill = darken(opts.color, 0.15);
  const bars: string[] = [];
  for (let i = 0; i < opts.days.length; i++) {
    const d = opts.days[i]!;
    if (d.total <= 0) continue;
    const barH = Math.max(1, (d.total / max) * drawH);
    const x = padLeft + i * slot + (slot - barW) / 2;
    const y = padTop + (drawH - barH);
    const fill = opts.peakDate === d.date ? peakFill : opts.color;
    bars.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${escapeAttr(fill)}" rx="1" />`);
  }

  // X-axis: label every ~7th day, always including the first and last day.
  const labels: string[] = [];
  const labelIndices = new Set<number>([0, opts.days.length - 1]);
  for (let i = 7; i < opts.days.length - 3; i += 7) labelIndices.add(i);
  for (const i of labelIndices) {
    const d = opts.days[i]!;
    const cx = padLeft + i * slot + slot / 2;
    labels.push(`<text x="${cx.toFixed(1)}" y="${(h - 4).toFixed(1)}" font-size="10" style="fill:var(--color-chart-axis)" text-anchor="middle">${formatShortDate(d.date)}</text>`);
  }

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${bars.join('')}${labels.join('')}</svg>`;
}

function formatShortDate(iso: string): string {
  // iso is yyyy-mm-dd; parse without a timezone shift.
  const [y, m, dRaw] = iso.split('-').map(Number);
  const d = dRaw ?? 1;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${MONTHS[(m ?? 1) - 1]} ${d}`;
}

function darken(hex: string, amount: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const dr = Math.max(0, Math.round(r * (1 - amount)));
  const dg = Math.max(0, Math.round(g * (1 - amount)));
  const db = Math.max(0, Math.round(b * (1 - amount)));
  return `#${dr.toString(16).padStart(2,'0')}${dg.toString(16).padStart(2,'0')}${db.toString(16).padStart(2,'0')}`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
