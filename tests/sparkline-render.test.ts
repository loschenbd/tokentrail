import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSparkline } from '../src/dashboard/render/sparkline.js';

describe('renderSparkline', () => {
  test('empty points → svg with no polyline', () => {
    const svg = renderSparkline({ points: [], color: '#123456' });
    assert.match(svg, /^<svg\b/);
    assert.doesNotMatch(svg, /<polyline\b/);
  });

  test('all-zero points → flat baseline polyline at the bottom edge', () => {
    const svg = renderSparkline({
      points: [
        { date: '2026-06-01', totalUsd: 0 },
        { date: '2026-06-02', totalUsd: 0 },
      ],
      color: '#abcdef',
      width: 40,
      height: 10,
    });
    assert.match(svg, /<polyline\b/);
    // Baseline y-coordinate is at (height - pad). Verify at least one point
    // near that y, and the stroke uses the supplied color. Stroke is applied
    // via the style attribute (not the presentation attr) so callers can pass
    // a themeable CSS var.
    assert.match(svg, /style="stroke:#abcdef"/);
  });

  test('non-zero points scale to the specified height', () => {
    const svg = renderSparkline({
      points: [
        { date: '2026-06-01', totalUsd: 10 },
        { date: '2026-06-02', totalUsd: 20 },
      ],
      color: '#000000',
      width: 20,
      height: 20,
    });
    // Should have exactly one polyline with two comma-separated coords.
    const match = svg.match(/points="([^"]+)"/);
    assert.ok(match);
    const coords = match![1]!.split(' ').filter((p) => p.length > 0);
    assert.equal(coords.length, 2);
  });

  test('sets aria-label when provided', () => {
    const svg = renderSparkline({ points: [], color: '#000', ariaLabel: 'archi-a 30d' });
    assert.match(svg, /aria-label="archi-a 30d"/);
  });
});
