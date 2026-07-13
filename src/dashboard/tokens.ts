// Single source of truth for the Midori paper theme (ported from
// benjaminloschen.com). Imported by both the CSS generator and any
// rendering code that needs an inline color.

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
  },
  font: {
    serif:  'Georgia, "Iowan Old Style", ui-serif, serif',
    sans:   '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    mono:   'ui-monospace, "SF Mono", Menlo, monospace',
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

// Emits the tokens as :root custom properties. Called from the CSS endpoint.
export function tokensCss(): string {
  return `:root {
    --color-paper: ${TOKENS.color.paper};
    --color-ink: ${TOKENS.color.ink};
    --color-ink-muted: ${TOKENS.color.inkMuted};
    --color-ink-subtle: ${TOKENS.color.inkSubtle};
    --color-border: ${TOKENS.color.border};
    --color-accent: ${TOKENS.color.accent};
    --color-accent-hover: ${TOKENS.color.accentHover};
    --color-warm: ${TOKENS.color.warm};
    --color-warm-deep: ${TOKENS.color.warmDeep};
    --color-dot: ${TOKENS.color.dot};
    --color-card-bg: ${TOKENS.color.cardBg};
    --color-card-border: ${TOKENS.color.cardBorder};
    --font-serif: ${TOKENS.font.serif};
    --font-sans: ${TOKENS.font.sans};
    --font-mono: ${TOKENS.font.mono};
    --size-hero: ${TOKENS.size.hero};
    --size-h1: ${TOKENS.size.h1};
    --size-h2: ${TOKENS.size.h2};
    --size-body: ${TOKENS.size.body};
    --size-small: ${TOKENS.size.small};
    --size-label: ${TOKENS.size.label};
    --space-s: ${TOKENS.space.s};
    --space-m: ${TOKENS.space.m};
    --space-l: ${TOKENS.space.l};
    --space-xl: ${TOKENS.space.xl};
  }`;
}
