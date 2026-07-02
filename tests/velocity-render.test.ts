import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderVelocityChart } from '../src/dashboard/render/velocity.js';

describe('renderVelocityChart', () => {
  test('empty days → svg with no bars', () => {
    const svg = renderVelocityChart({ days: [], color: '#F0E442' });
    assert.match(svg, /^<svg\b/);
    assert.doesNotMatch(svg, /<rect\b/);
  });

  test('renders one bar per day and skips zero-total days', () => {
    const svg = renderVelocityChart({
      days: [
        { date: '2026-06-01', total: 0 },
        { date: '2026-06-02', total: 50 },
        { date: '2026-06-03', total: 0 },
      ],
      color: '#F0E442',
    });
    const rects = (svg.match(/<rect\b/g) ?? []).length;
    assert.equal(rects, 1);
  });

  test('emits x-axis labels formatted as "Mon D"', () => {
    const svg = renderVelocityChart({
      days: [
        { date: '2026-06-01', total: 10 },
        { date: '2026-06-08', total: 20 },
      ],
      color: '#F0E442',
    });
    assert.match(svg, /Jun 1/);
    assert.match(svg, /Jun 8/);
  });

  test('peakDate bar is rendered with a distinct fill', () => {
    const svg = renderVelocityChart({
      days: [
        { date: '2026-06-01', total: 100 },
        { date: '2026-06-02', total: 200 },
      ],
      color: '#F0E442',
      peakDate: '2026-06-02',
    });
    // Two rects with two DIFFERENT fill attributes.
    const fills = [...svg.matchAll(/<rect[^>]*fill="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(fills.length, 2);
    assert.notEqual(fills[0], fills[1]);
  });
});
