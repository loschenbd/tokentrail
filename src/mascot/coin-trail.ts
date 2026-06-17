export type Bend = { dx: number; dy: number };

const PILE_COINS: ReadonlyArray<{ cx: number; cy: number; r: number }> = [
  { cx:  60, cy: 110, r: 22 },
  { cx:  90, cy: 100, r: 22 },
  { cx:  75, cy: 130, r: 22 },
  { cx: 110, cy: 122, r: 22 },
  { cx:  45, cy: 130, r: 20 },
  { cx:  95, cy: 118, r: 18 },
];

const ARC_START = { x: 130, y: 100 };
const ARC_END_CENTERED = { x: 320, y: 30 };
const ARC_CTRL_CENTERED = { x: 220, y: 40 };
const TRAIL_FRACTIONS = [0.2, 0.4, 0.6, 0.8, 1.0] as const;
const TRAIL_RADII = [16, 15, 14, 13, 12] as const;

export function coinTrailSvg(bend: Bend): string {
  const endX = ARC_END_CENTERED.x + bend.dx * 40;
  const endY = ARC_END_CENTERED.y + bend.dy * 24;
  const ctrlX = ARC_CTRL_CENTERED.x + bend.dx * 20;
  const ctrlY = ARC_CTRL_CENTERED.y + bend.dy * 12;

  const trailCoins = TRAIL_FRACTIONS.map((t, i) => {
    const { x, y } = quadBezier(ARC_START, { x: ctrlX, y: ctrlY }, { x: endX, y: endY }, t);
    return `<circle class="coin trail" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${TRAIL_RADII[i]}" fill="#c9b48d" stroke="#3d2f1f" stroke-width="2"/>`;
  }).join('');

  const pileCoins = PILE_COINS
    .map(c => `<circle class="coin pile" cx="${c.cx}" cy="${c.cy}" r="${c.r}" fill="#c9b48d" stroke="#3d2f1f" stroke-width="2.5"/>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 160" width="360" height="160">${pileCoins}${trailCoins}</svg>`;
}

function quadBezier(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}
