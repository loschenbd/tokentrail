// Single source of truth for the Midori theme (ported from
// benjaminloschen.com). Light is the "paper" original; dark is a warm
// charcoal that keeps the sage/clay accents. Every color the UI uses is a
// custom property so a single [data-theme] flip re-skins the whole dashboard.
// Imported by the CSS generator (served at /static/tokens.css).

// Light "paper" palette — the canonical Midori look.
export const TOKENS = {
  color: {
    paper:        '#f3f1eb',            // warm cream page background (flat, no gradient)
    ink:          '#2a2825',            // primary text / structure
    inkMuted:     '#524d46',            // secondary text
    inkSubtle:    '#6b5f52',            // eyebrows, tertiary structure
    border:       'rgba(60,58,54,0.1)', // hairline rules
    accent:       '#5f6f5e',            // muted sage — used like punctuation
    accentHover:  '#4a5749',
    warm:         '#c9916b',            // muted terracotta / clay
    warmDeep:     '#8f4f38',            // negative deltas, alerts
    dot:          '#9ebfb4',            // mint dot-grid on cream
    cardBg:       '#faf9f6',
    cardBorder:   'rgba(60,58,54,0.08)',
    // Semantic composites (previously hardcoded across dashboard.css). Naming
    // them here is what makes them themeable in one place.
    hairline:      'rgba(60,58,54,0.09)',  // chart grid / fine rules
    hoverBg:       'rgba(95,111,94,0.07)', // list-row hover wash
    hoverBgSoft:   'rgba(95,111,94,0.08)',
    hoverBgMid:    'rgba(95,111,94,0.12)',
    hoverBgStrong: 'rgba(95,111,94,0.16)',
    fillTrack:     'rgba(60,58,54,0.05)',  // empty bar/track background
    fillMuted:     'rgba(60,58,54,0.08)',  // scrollbar / progress trough
    stripeFg:      '#78716a',              // diagonal-stripe foreground (unattributed)
    stripeHi:      'rgba(255,255,255,0.35)', // stripe highlight
    flashBg:       'rgba(250,204,21,0.35)', // row flash on jump-to
    swatchFallback:'#a8a29a',              // legend swatch when a color is missing
    chartAxis:     '#524d46',              // uPlot axis stroke
    chartGrid:     'rgba(60,58,54,0.09)',  // uPlot gridline stroke
    ruleAccent:    'rgba(95,111,94,0.4)',  // link underline / ghost-button border
    shadowCard:    '0 1px 0 rgba(60,58,54,0.04)',
    shadowPop:     '0 12px 40px -16px rgba(60,58,54,0.25), 0 1px 0 rgba(60,58,54,0.04)',
    // Page atmosphere glow washes (body::before). Kept as full gradient
    // strings so the two themes can diverge completely.
    glow:          'radial-gradient(ellipse 100% 55% at 50% -15%, rgb(255 252 247 / 0.95), transparent 52%), radial-gradient(ellipse 55% 40% at 0% 100%, rgb(236 233 224 / 0.55), transparent 50%), radial-gradient(ellipse 45% 45% at 100% 60%, rgb(232 236 229 / 0.4), transparent 48%)',
    dotOpacity:    '0.46',
  },
  font: {
    // Same faces as benjaminloschen.com, self-hosted via /static/fonts.css:
    // Spectral for headings, M PLUS 1p for UI text, M PLUS 1 Code for
    // numerals/labels, PT Mono for code and commands.
    serif:  'Spectral, Georgia, "Iowan Old Style", ui-serif, serif',
    sans:   '"M PLUS 1p", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    mono:   '"M PLUS 1 Code", ui-monospace, "SF Mono", Menlo, monospace',
    code:   '"PT Mono", ui-monospace, "SF Mono", Menlo, monospace',
  },
  size: {
    hero:   '32px',
    h1:     '24px',
    h2:     '18px',
    body:   '14px',
    small:  '11px',
    label:  '10px',
  },
  space: {
    s: '8px',
    m: '16px',
    l: '24px',
    xl: '32px',
  },
} as const;

// Dark "ink" palette — a warm charcoal (never pure black) so the paper
// warmth survives. Sage/clay accents are lifted so they read on the dark
// ground; hover/hairline washes switch to light-on-dark alphas.
const DARK_COLORS: Record<keyof typeof TOKENS.color, string> = {
  paper:         '#1a1815',
  ink:           '#e8e4db',
  inkMuted:      '#a9a298',
  inkSubtle:     '#8a8175',
  border:        'rgba(255,252,245,0.12)',
  accent:        '#93a891',            // lifted sage
  accentHover:   '#b0c2ad',
  warm:          '#d4a683',
  warmDeep:      '#e0946f',
  dot:           '#3a4a44',            // dim mint on charcoal
  cardBg:        '#232019',
  cardBorder:    'rgba(255,252,245,0.09)',
  hairline:      'rgba(255,252,245,0.10)',
  hoverBg:       'rgba(147,168,145,0.10)',
  hoverBgSoft:   'rgba(147,168,145,0.10)',
  hoverBgMid:    'rgba(147,168,145,0.16)',
  hoverBgStrong: 'rgba(147,168,145,0.24)',
  fillTrack:     'rgba(255,252,245,0.06)',
  fillMuted:     'rgba(255,252,245,0.11)',
  stripeFg:      '#6b6459',
  stripeHi:      'rgba(255,255,255,0.10)',
  flashBg:       'rgba(250,204,21,0.20)',
  swatchFallback:'#6b6459',
  chartAxis:     '#a9a298',
  chartGrid:     'rgba(255,252,245,0.09)',
  ruleAccent:    'rgba(147,168,145,0.45)',
  shadowCard:    '0 1px 0 rgba(0,0,0,0.35)',
  shadowPop:     '0 14px 44px -16px rgba(0,0,0,0.65), 0 1px 0 rgba(0,0,0,0.35)',
  // Faint warm halos instead of bright cream washes; dimmer dot grid.
  glow:          'radial-gradient(ellipse 100% 55% at 50% -15%, rgb(80 76 66 / 0.35), transparent 55%), radial-gradient(ellipse 55% 40% at 0% 100%, rgb(45 55 50 / 0.30), transparent 52%), radial-gradient(ellipse 45% 45% at 100% 60%, rgb(60 55 48 / 0.28), transparent 50%)',
  dotOpacity:    '0.30',
};

// Map a token camelCase key to its CSS custom-property name.
// paper -> --color-paper, hoverBgStrong -> --color-hover-bg-strong.
function cssVarName(key: string): string {
  return '--color-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

function colorVars(source: Record<string, string>): string {
  return Object.entries(source)
    .map(([k, v]) => `    ${cssVarName(k)}: ${v};`)
    .join('\n');
}

// Emits light tokens on :root, plus dark overrides that (a) auto-apply under
// prefers-color-scheme: dark UNLESS the user has forced light, and (b) always
// apply when data-theme="dark" is set explicitly. This is the standard
// system-default-with-manual-override pattern.
export function tokensCss(): string {
  const nonColor = `    --font-serif: ${TOKENS.font.serif};
    --font-sans: ${TOKENS.font.sans};
    --font-mono: ${TOKENS.font.mono};
    --font-code: ${TOKENS.font.code};
    --size-hero: ${TOKENS.size.hero};
    --size-h1: ${TOKENS.size.h1};
    --size-h2: ${TOKENS.size.h2};
    --size-body: ${TOKENS.size.body};
    --size-small: ${TOKENS.size.small};
    --size-label: ${TOKENS.size.label};
    --space-s: ${TOKENS.space.s};
    --space-m: ${TOKENS.space.m};
    --space-l: ${TOKENS.space.l};
    --space-xl: ${TOKENS.space.xl};`;

  const light = colorVars(TOKENS.color as Record<string, string>);
  const dark = colorVars(DARK_COLORS as Record<string, string>);

  return `:root {
${light}
${nonColor}
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
${dark}
    }
  }
  :root[data-theme="dark"] {
${dark}
  }`;
}
