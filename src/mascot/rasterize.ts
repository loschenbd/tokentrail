import { Resvg } from '@resvg/resvg-js';

export type CharGrid = string[][];

export const DENSITY_CHARS = {
  empty: ' ',
  sparse: '·',
  mid: '¤',
  faceLeft: '◐',
  faceRight: '◑',
  full: '●',
} as const;

const CELL_PX_W = 6;
const CELL_PX_H = 12;

export function rasterizeSvgToChars(svg: string, opts: { cols: number; rows: number }): CharGrid {
  const width = opts.cols * CELL_PX_W;
  const height = opts.rows * CELL_PX_H;
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
  const png = resvg.render();
  const { pixels, width: w, height: h } = png;
  // pixels is RGBA Uint8Array of size w*h*4. Use the actual w/h from the
  // pixmap, then sample per cell.
  const cellW = w / opts.cols;
  const cellH = h / opts.rows;

  const grid: CharGrid = [];
  for (let r = 0; r < opts.rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < opts.cols; c++) {
      const x0 = Math.floor(c * cellW);
      const y0 = Math.floor(r * cellH);
      const x1 = Math.floor((c + 1) * cellW);
      const y1 = Math.floor((r + 1) * cellH);
      const density = cellDensity(pixels, w, x0, y0, x1, y1);
      row.push(charFor(density, c, opts.cols));
    }
    grid.push(row);
  }
  return trim(grid);
}

function cellDensity(pixels: Uint8Array, stride: number, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * stride + x) * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const a = pixels[i + 3];
      if (r === undefined || g === undefined || b === undefined || a === undefined) continue;
      // darkness = 1 - luminance, weighted by alpha
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const dark = (1 - lum) * (a / 255);
      sum += dark;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

function charFor(d: number, col: number, totalCols: number): string {
  if (d < 0.10) return DENSITY_CHARS.empty;
  if (d < 0.30) return DENSITY_CHARS.sparse;
  if (d < 0.55) return DENSITY_CHARS.mid;
  if (d < 0.80) return col < totalCols / 2 ? DENSITY_CHARS.faceLeft : DENSITY_CHARS.faceRight;
  return DENSITY_CHARS.full;
}

function trim(grid: CharGrid): CharGrid {
  const isBlank = (row: string[]) => row.every(c => c === ' ');
  let top = 0;
  while (top < grid.length && isBlank(grid[top]!)) top++;
  let bottom = grid.length - 1;
  while (bottom >= top && isBlank(grid[bottom]!)) bottom--;
  return grid.slice(top, bottom + 1);
}
