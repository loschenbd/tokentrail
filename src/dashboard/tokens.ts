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

// Dark "ink" palette — synced to benjaminloschen.com's canonical `.dark`
// block (app/globals.css) so the two stay pixel-identical. The base colors,
// borders, page-glow, dot, and card shadow are the site's exact values; the
// tokentrail-only semantic composites (hover washes, chart grid, stripes) are
// derived from those same site colors (accent = #9aab97 = rgb(154,171,151)).
// A warm charcoal, never pure black, with the sage/clay accents lifted so
// they read on the dark ground.
const DARK_COLORS: Record<keyof typeof TOKENS.color, string> = {
  paper:         '#1a1917',            // site --background
  ink:           '#ebe8e2',            // site --foreground
  inkMuted:      '#9c958a',            // site --muted
  inkSubtle:     '#857e73',            // derived: tertiary text (site has no direct token), dimmer than muted
  border:        'rgba(235,232,226,0.1)',  // site --border
  accent:        '#9aab97',            // site --accent (lifted sage)
  accentHover:   '#b4c0b0',            // site --accent-hover
  warm:          '#d4a07a',            // site --accent-warm
  warmDeep:      '#b87d5c',            // site --accent-warm-deep
  dot:           'rgb(154 189 179 / 0.38)', // site --page-dot (dimmed mint)
  cardBg:        '#22211e',            // site --card
  cardBorder:    'rgba(235,232,226,0.08)',  // site --card-border
  hairline:      'rgba(235,232,226,0.09)',  // site border family, one step under --border
  hoverBg:       'rgba(154,171,151,0.10)',  // accent wash
  hoverBgSoft:   'rgba(154,171,151,0.10)',
  hoverBgMid:    'rgba(154,171,151,0.16)',
  hoverBgStrong: 'rgba(154,171,151,0.24)',
  fillTrack:     'rgba(235,232,226,0.06)',
  fillMuted:     'rgba(235,232,226,0.11)',
  stripeFg:      '#6b6459',
  stripeHi:      'rgba(255,255,255,0.10)',
  flashBg:       'rgba(250,204,21,0.20)',
  swatchFallback:'#6b6459',
  chartAxis:     '#9c958a',            // site --muted
  chartGrid:     'rgba(235,232,226,0.09)',
  ruleAccent:    'rgba(154,171,151,0.45)',
  shadowCard:    '0 1px 0 rgba(0,0,0,0.35)',                                   // site --shadow-card
  shadowPop:     '0 12px 40px -16px rgba(0,0,0,0.55), 0 1px 0 rgba(0,0,0,0.35)', // site --shadow-card-hover
  // Site --page-glow (dark): faint warm halos on charcoal.
  glow:          'radial-gradient(ellipse 100% 55% at 50% -15%, rgb(45 44 40 / 0.9), transparent 52%), radial-gradient(ellipse 55% 40% at 0% 100%, rgb(55 52 46 / 0.45), transparent 50%), radial-gradient(ellipse 45% 45% at 100% 60%, rgb(48 52 46 / 0.35), transparent 48%)',
  dotOpacity:    '0.46',               // site keeps the .page-grid-overlay layer opacity in both themes
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
