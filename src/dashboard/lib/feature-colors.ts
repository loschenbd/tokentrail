// Midori MD "Color Dot" palette — series read as notebook color dots on
// cream paper. Low chroma on purpose; distinguish by hue, not saturation.
//
// All eight are now canonical benjaminloschen.com tokens. The last two used to
// be local inventions ('#4a6a6b' teal-slate, '#8a6a8c' plum) made before the
// site had mint and purple tokens; adopting the real ones raised the palette's
// worst pairwise Oklab distance from dE 3.98 to 4.81 and the mean from 13.5 to
// 15.1, because the invented plum sat at C 6.4 where the real purple sits at
// 10.9.
//
// These are the LIGHT values, and they are correct as authored. colorFor() runs
// server-side while the theme resolves in the client, so a server-emitted hex
// can never be theme-correct on its own; dashboard.js closes that with
// liftForDark(), which raises HSL lightness ~0.24 at paint time for BOTH the
// uPlot canvas and the DOM swatches. Do not add a dark column here — the lift
// is the mechanism, and a second source of truth would drift from it.
//
// The lift is well calibrated against the site: it takes purple #653f7f to
// #a379bf, where benjaminloschen.com's hand-tuned dark token is #a079be — a
// 3/255 difference. On the dark ground every series clears 5:1 (purple 5.06,
// indigo 5.41, wine 5.73, up to ochre 10.01).
//
// The corollary is that a colour-bearing element only gets lifted if
// liftDomBands can see it. Anything painting one of these hues must either
// carry a class in that selector or be marked data-lift — see the note there.
export const PALETTE: readonly string[] = [
  '#3a5572', // indigo     --midori-indigo
  '#b88a3a', // ochre      --midori-ochre
  '#6c7d52', // olive      --midori-olive
  '#7a4a4a', // wine       --midori-wine
  '#5f6f5e', // sage       --midori-sage
  '#b06d4a', // terracotta --accent-warm-strong
  '#548373', // mint       --midori-mint   (was #4a6a6b, a local invention)
  '#653f7f', // purple     --midori-purple (was #8a6a8c, a local invention)
] as const;

export const OTHER_KEY = '__other__' as const;
export const OTHER_NAME = 'Other' as const;
export const OTHER_COLOR = '#a8a29a' as const;

export const UNCATEGORIZED_KEY = 'uncategorized-mainline' as const;
export const UNCATEGORIZED_BASE_COLOR = '#78716a' as const;
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

// Single-project picker (used when caller doesn't have the sibling set).
// Prefer resolveProjectColors when you have the full visible list — it
// guarantees no collisions across siblings.
export function colorForProject(projectKey: string): string {
  if (projectKey === OTHER_KEY) return OTHER_COLOR;
  const hue = hashProject(projectKey) % 360;
  return hslToHex(hue, PROJECT_SAT, PROJECT_LIGHT);
}

// Muted "color dot" chroma for hashed project hues — matches the Midori
// palette above (s ≈ 20–50, l ≈ 34–47) instead of full-saturation rainbow.
const PROJECT_SAT = 28;
const PROJECT_LIGHT = 40;

// Given a set of project keys, return {key: hex} with no two projects
// sharing a similar hue. First pass hashes each key to a hue; subsequent
// collisions (within MIN_SEP degrees) get rotated forward until they fit.
// Earlier keys win hue fights, so ORDER IS PRIORITY. Callers must pass a
// canonical, view-independent order (see canonicalProjectColors — all-time
// spend), never a windowed ranking: if per-view rank drove rotation, the
// same project could land on different hues per view, and bars/swatches/
// menubar dots would disagree.
export function resolveProjectColors(projectKeys: readonly string[]): Record<string, string> {
  const MIN_SEP = 22;
  const out: Record<string, string> = {};
  const used: number[] = [];
  for (const key of projectKeys) {
    if (key === OTHER_KEY) {
      out[key] = OTHER_COLOR;
      continue;
    }
    let h = hashProject(key) % 360;
    let guard = 360;
    while (guard-- > 0 && used.some((u) => {
      const d = Math.abs(u - h);
      return Math.min(d, 360 - d) < MIN_SEP;
    })) {
      h = (h + 17) % 360;
    }
    used.push(h);
    out[key] = hslToHex(h, PROJECT_SAT, PROJECT_LIGHT);
  }
  return out;
}

export function shadeForFeature(baseHex: string, featureKey: string): string {
  const [h, s, l] = hexToHsl(baseHex);
  // Tight spread: segments must still read as the project's color, so the
  // subbar visibly matches the project's swatch/legend dot at a glance.
  const shifts = [-10, -5, 0, 5, 10];
  const shift = shifts[hash(featureKey) % shifts.length]!;
  const nl = Math.max(22, Math.min(78, l + shift));
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
