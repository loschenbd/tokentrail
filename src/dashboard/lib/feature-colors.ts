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

function hashProject(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  // Same finalizer as colorFor to preserve distribution quality.
  h = Math.imul(h ^ (h >>> 15), 0x9E3779B1);
  // XOR with a non-zero constant so a same-slug project and feature don't
  // necessarily land on the same colour. Independent keyspace, per spec.
  return Math.abs((h ^ 0xC0FFEE) >>> 0);
}

export function colorFor(featureKey: string): string {
  if (featureKey === OTHER_KEY) return OTHER_COLOR;
  if (featureKey === UNCATEGORIZED_KEY) return STRIPED_SENTINEL;
  return PALETTE[hash(featureKey) % PALETTE.length]!;
}

export function colorForProject(projectKey: string): string {
  return PALETTE[hashProject(projectKey) % PALETTE.length]!;
}

// Feature colors are within-hue shades of the parent project color, so a
// sub-bar segment visually belongs to its row's project swatch. Same
// (projectKey, featureKey) always yields the same shade.
export function colorForFeatureInProject(projectKey: string, featureKey: string): string {
  const base = colorForProject(projectKey);
  const shifts = [-18, -9, 0, 9, 18];
  const shift = shifts[hash(featureKey) % shifts.length]!;
  return shiftLightness(base, shift);
}

function shiftLightness(hex: string, delta: number): string {
  const [h, s, l] = hexToHsl(hex);
  const nl = Math.max(22, Math.min(78, l + delta));
  return hslToHex(h, s, nl);
}

function hexToHsl(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let s = 0;
  let hh = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hh = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60;
  }
  return [hh, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  const S = s / 100;
  const L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
