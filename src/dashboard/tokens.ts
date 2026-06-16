// Single source of truth for the cartographer theme. Imported by both
// the CSS generator and any rendering code that needs an inline color.

export const TOKENS = {
  color: {
    parchmentTop:    '#f8f3e7',
    parchmentBottom: '#f0e5d0',
    ink:             '#3d2f1f',
    inkMuted:        '#6b563d',
    inkSubtle:       '#8b6f47',
    rule:            '#8b6f47',
    accentGreen:     '#5d7a3e',
    accentBar:       '#8b6f47',
    cardBg:          'rgba(255,255,255,0.5)',
    cardBorder:      '#c9b48d',
  },
  font: {
    serif:  'Georgia, "Times New Roman", serif',
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
    --color-parchment-top: ${TOKENS.color.parchmentTop};
    --color-parchment-bottom: ${TOKENS.color.parchmentBottom};
    --color-ink: ${TOKENS.color.ink};
    --color-ink-muted: ${TOKENS.color.inkMuted};
    --color-ink-subtle: ${TOKENS.color.inkSubtle};
    --color-rule: ${TOKENS.color.rule};
    --color-accent-green: ${TOKENS.color.accentGreen};
    --color-accent-bar: ${TOKENS.color.accentBar};
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
