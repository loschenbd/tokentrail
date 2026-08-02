import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tokensCss } from '../src/dashboard/tokens.js';

describe('tokensCss', () => {
  const css = tokensCss();

  test('emits a light :root with the base palette', () => {
    assert.match(css, /:root\s*\{/);
    assert.match(css, /--color-paper:\s*#f3f1eb;/);
    assert.match(css, /--color-ink:\s*#2a2825;/);
  });

  test('camelCase token keys become kebab-case custom properties', () => {
    // hoverBgStrong -> --color-hover-bg-strong; chartAxis -> --color-chart-axis.
    assert.match(css, /--color-hover-bg-strong:/);
    assert.match(css, /--color-chart-axis:/);
    assert.match(css, /--color-shadow-card:/);
  });

  test('provides both the system-default dark block and the explicit override', () => {
    // Auto dark unless the user forced light.
    assert.match(css, /@media \(prefers-color-scheme: dark\)/);
    assert.match(css, /:root:not\(\[data-theme="light"\]\)/);
    // Manual dark always wins.
    assert.match(css, /:root\[data-theme="dark"\]/);
  });

  test('dark overrides actually change values (paper flips to the charcoal)', () => {
    // The dark paper token must appear (it only exists in the dark blocks).
    assert.match(css, /--color-paper:\s*#1a1815;/);
    // And the lifted sage accent for dark.
    assert.match(css, /--color-accent:\s*#93a891;/);
  });
});
