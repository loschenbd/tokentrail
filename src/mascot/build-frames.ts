import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { variants, CENTER_INDEX } from './variants.js';
import { rasterizeSvgToChars } from './rasterize.js';
import { coinTrailSvg } from './coin-trail.js';

const COLS = 36;
const ROWS = 16;

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const logoSvgPath = join(process.cwd(), 'docs', 'logo.svg');
  writeFileSync(logoSvgPath, coinTrailSvg({ dx: 0, dy: 0 }));
  // eslint-disable-next-line no-console
  console.log(`mascot: wrote canonical SVG to ${logoSvgPath}`);
  const outPath = join(here, 'frames.json');
  const frames = variants().map(v => ({
    bend: v.bend,
    grid: rasterizeSvgToChars(v.svg, { cols: COLS, rows: ROWS }),
  }));
  const bundle = { cols: COLS, rows: ROWS, centerIndex: CENTER_INDEX, frames };
  writeFileSync(outPath, JSON.stringify(bundle));
  // eslint-disable-next-line no-console
  console.log(`mascot: wrote ${frames.length} frames to ${outPath}`);
}

main();
