import { coinTrailSvg, type Bend } from './coin-trail.js';

export const BEND_DXS = [-1.0, -0.5, 0, 0.5, 1.0] as const;
export const BEND_DYS = [-1.0, 0, 1.0] as const;
export const CENTER_INDEX = 7; // BEND_DYS index 1 × 5 + BEND_DXS index 2

export type Variant = { bend: Bend; svg: string };

export function variants(): Variant[] {
  const out: Variant[] = [];
  for (const dy of BEND_DYS) {
    for (const dx of BEND_DXS) {
      out.push({ bend: { dx, dy }, svg: coinTrailSvg({ dx, dy }) });
    }
  }
  return out;
}
