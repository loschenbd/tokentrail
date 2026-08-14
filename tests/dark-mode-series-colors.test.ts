import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PALETTE } from '../src/dashboard/lib/feature-colors.js';
import { renderVelocityChart } from '../src/dashboard/render/velocity.js';

// The series palette is authored for cream paper; dashboard.js re-tints it at
// paint time via liftForDark. That split only works if two things hold, and
// both are easy to break silently:
//
//   1. liftForDark actually clears a readable contrast on the dark ground.
//   2. every element painting a project hue is REACHABLE by liftDomBands.
//
// (2) is the one that rots — a new coloured element renders fine in light mode
// and nobody notices it stayed cream-tuned on dark.

const DASHBOARD_JS = new URL('../src/dashboard/static/dashboard.js', import.meta.url);
const js = readFileSync(DASHBOARD_JS, 'utf8');

/** Pull a top-level `function name(...) {...}` out of the IIFE by brace matching. */
function extractFn(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `dashboard.js no longer defines ${name}()`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

const liftForDark = new Function(
  `${extractFn(js, 'liftForDark')}; return liftForDark;`,
)() as (hex: string) => string;

// WCAG relative luminance against the dark paper (--color-paper in .dark).
const DARK_PAPER = '#1a1917';
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

describe('dark-mode series colors', () => {
  test('every palette hue clears 4.5:1 on the dark paper once lifted', () => {
    for (const hex of PALETTE) {
      const lifted = liftForDark(hex);
      assert.match(lifted, /^#[0-9a-f]{6}$/i, `${hex} did not lift to a hex`);
      const ratio = contrast(lifted, DARK_PAPER);
      assert.ok(
        ratio >= 4.5,
        `${hex} lifts to ${lifted} at only ${ratio.toFixed(2)}:1 on ${DARK_PAPER}`,
      );
    }
  });

  test('raw palette would NOT clear it — i.e. the lift is load-bearing', () => {
    const dim = PALETTE.filter((hex) => contrast(hex, DARK_PAPER) < 3);
    assert.ok(
      dim.length > 0,
      'palette now passes unlifted; re-check whether liftForDark is still needed',
    );
  });

  test('liftForDark passes non-hex through untouched', () => {
    // Callers legitimately hand in CSS vars (the unattributed sparkline does).
    assert.equal(liftForDark('var(--color-stripe-fg)'), 'var(--color-stripe-fg)');
    assert.equal(liftForDark(''), '');
  });

  test('liftDomBands reaches every class that paints a project hue', () => {
    const selector = /querySelectorAll\('([^']*\.swatch[^']*)'\)/.exec(js)?.[1];
    assert.ok(selector, 'could not find the liftDomBands background selector');
    // Each of these renders a project/feature hue as an inline background.
    for (const cls of ['.swatch', '.subbar-segment', '.pfeat-fill', '.hour-seg']) {
      assert.ok(
        selector!.includes(cls),
        `${cls} paints a project hue but liftDomBands does not select it`,
      );
    }
  });

  test('liftDomBands has an SVG pass for fill/stroke carriers', () => {
    assert.ok(
      js.includes("querySelectorAll('[data-lift]')"),
      'the data-lift pass is gone; SVG fills will not be re-tinted',
    );
  });

  test('velocity bars are marked data-lift so the SVG pass finds them', () => {
    const svg = renderVelocityChart({
      days: [
        { date: '2026-08-01', total: 4 },
        { date: '2026-08-02', total: 9 },
      ],
      peakDate: '2026-08-02',
      color: '#3a5572',
    });
    const rects = svg.match(/<rect\b[^>]*fill="#[0-9a-f]{6}"[^>]*>/gi) ?? [];
    assert.ok(rects.length >= 2, 'expected coloured velocity bars to assert on');
    for (const r of rects) {
      assert.match(r, /data-lift="fill"/, `velocity bar not liftable: ${r}`);
    }
  });
});
