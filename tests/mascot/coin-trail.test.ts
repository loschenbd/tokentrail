import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { coinTrailSvg } from '../../src/mascot/coin-trail.js';

describe('coinTrailSvg', () => {
  test('returns SVG with the canonical viewBox 0 0 360 160', () => {
    const svg = coinTrailSvg({ dx: 0, dy: 0 });
    assert.match(svg, /^<svg /);
    assert.match(svg, /viewBox="0 0 360 160"/);
  });

  test('contains 6 pile coins at fixed positions', () => {
    const svg = coinTrailSvg({ dx: 0, dy: 0 });
    const pileMatches = svg.match(/<circle class="coin pile"/g) ?? [];
    assert.equal(pileMatches.length, 6, 'expected 6 pile coins');
  });

  test('contains 5 trail coins (along the arc)', () => {
    const svg = coinTrailSvg({ dx: 0, dy: 0 });
    const trailMatches = svg.match(/<circle class="coin trail"/g) ?? [];
    assert.equal(trailMatches.length, 5, 'expected 5 trail coins');
  });

  test('uses the brand palette colors only', () => {
    const svg = coinTrailSvg({ dx: 0, dy: 0 });
    assert.match(svg, /fill="#c9b48d"/);  // coin face = light sepia
    assert.match(svg, /stroke="#3d2f1f"/); // coin rim = ink
    assert.equal(svg.includes('#000'), false);
    assert.equal(svg.includes('#fff'), false);
  });

  test('bend dx=+1 shifts trail endpoint +40px in x vs centered', () => {
    const centered = coinTrailSvg({ dx: 0, dy: 0 });
    const right = coinTrailSvg({ dx: 1.0, dy: 0 });
    const cxCenter = extractLastTrailCx(centered);
    const cxRight = extractLastTrailCx(right);
    assert.equal(cxRight - cxCenter, 40);
  });

  test('bend dy=+1 shifts trail endpoint +24px in y vs centered', () => {
    const centered = coinTrailSvg({ dx: 0, dy: 0 });
    const down = coinTrailSvg({ dx: 0, dy: 1.0 });
    const cyCenter = extractLastTrailCy(centered);
    const cyDown = extractLastTrailCy(down);
    assert.equal(cyDown - cyCenter, 24);
  });
});

function extractLastTrailCx(svg: string): number {
  const matches = [...svg.matchAll(/<circle class="coin trail"[^>]*cx="([-\d.]+)"/g)];
  const last = matches[matches.length - 1];
  return Number(last?.[1]);
}
function extractLastTrailCy(svg: string): number {
  const matches = [...svg.matchAll(/<circle class="coin trail"[^>]*cy="([-\d.]+)"/g)];
  const last = matches[matches.length - 1];
  return Number(last?.[1]);
}
