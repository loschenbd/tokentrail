export const PALETTE: readonly string[] = [
  '#0072B2', '#E69F00', '#009E73', '#CC79A7',
  '#56B4E9', '#D55E00', '#F0E442', '#000000',
] as const;

export const OTHER_KEY = '__other__' as const;
export const OTHER_NAME = 'Other' as const;
export const OTHER_COLOR = '#9CA3AF' as const;

export const UNCATEGORIZED_KEY = 'uncategorized-mainline' as const;
export const UNCATEGORIZED_BASE_COLOR = '#6B7280' as const;
export const STRIPED_SENTINEL = '__striped__' as const;

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  // Mix to improve distribution
  h = Math.imul(h ^ (h >>> 15), 0x9E3779B1);
  return Math.abs(h >>> 0);
}

export function colorFor(featureKey: string): string {
  if (featureKey === OTHER_KEY) return OTHER_COLOR;
  if (featureKey === UNCATEGORIZED_KEY) return STRIPED_SENTINEL;
  return PALETTE[hash(featureKey) % PALETTE.length]!;
}
