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

  // Trim leading zero-spend days so the chart doesn't open with a dead gap.
  let firstSpend = 0;
  while (firstSpend < opts.days.length - 1 && opts.days[firstSpend]!.total <= 0) firstSpend++;
  const days = opts.days.slice(firstSpend);

  const max = Math.max(1, ...days.map((d) => d.total));
  const slot = drawW / days.length;
  const barW = Math.max(2, slot * 0.7);

  const peakFill = darken(opts.color, 0.15);
  const bars: string[] = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i]!;
    if (d.total <= 0) continue;
    const barH = Math.max(1, (d.total / max) * drawH);
    const x = padLeft + i * slot + (slot - barW) / 2;
    const y = padTop + (drawH - barH);
    const fill = opts.peakDate === d.date ? peakFill : opts.color;
    // data-lift="fill" — these bars carry the project hue, and a fill attribute
    // has no backgroundColor for liftDomBands to rewrite. Each rect stashes its
    // own base, so the peak keeps its darkened variant across theme flips.
    bars.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${escapeAttr(fill)}" rx="1" data-lift="fill" />`);
  }

  // X-axis: label every ~7th day, always including the first and last day.
  const labels: string[] = [];
  const labelIndices = new Set<number>([0, days.length - 1]);
  for (let i = 7; i < days.length - 3; i += 7) labelIndices.add(i);
  for (const i of labelIndices) {
    const d = days[i]!;
    const cx = padLeft + i * slot + slot / 2;
    labels.push(`<text x="${cx.toFixed(1)}" y="${(h - 4).toFixed(1)}" font-size="10" style="fill:var(--color-chart-axis)" text-anchor="middle">${formatShortDate(d.date)}</text>`);
  }

  const gridEls: string[] = [];
  for (const lvl of [max, (max * 2) / 3, max / 3]) {
    const gy = padTop + (drawH - (lvl / max) * drawH);
    gridEls.push(`<line x1="${padLeft}" x2="${(w - padRight).toFixed(1)}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" style="stroke:var(--color-chart-grid)" stroke-dasharray="2 3" />`);
    gridEls.push(`<text x="${padLeft}" y="${(gy - 2).toFixed(1)}" font-size="9" style="fill:var(--color-chart-axis)" text-anchor="start">$${Math.round(lvl)}</text>`);
  }

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${gridEls.join('')}${bars.join('')}${labels.join('')}</svg>`;
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
