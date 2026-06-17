import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { loadFrames } from '../src/mascot/load-frames.js';

const START = '<!-- MASCOT START -->';
const END = '<!-- MASCOT END -->';

export function bakeMascot(readme: string, frameText: string): string {
  const startIdx = readme.indexOf(START);
  if (startIdx < 0) throw new Error(`README is missing the ${START} marker`);
  const endIdx = readme.indexOf(END, startIdx);
  if (endIdx < 0) throw new Error(`README is missing the ${END} marker (after START)`);
  const before = readme.slice(0, startIdx);
  const after = readme.slice(endIdx + END.length);
  return `${before}${START}\n\`\`\`\n${frameText}\n\`\`\`\n${END}${after}`;
}

function main(): void {
  const bundle = loadFrames();
  if (!bundle) {
    process.stderr.write('mascot frames not built — run `npm run build:mascot` first\n');
    process.exit(1);
  }
  const frame = bundle.frames[bundle.centerIndex];
  if (!frame) {
    process.stderr.write('mascot center frame not found in bundle\n');
    process.exit(1);
  }
  const path = resolve(process.cwd(), 'README.md');
  const before = readFileSync(path, 'utf8');
  const frameText = frame.grid.map(row => row.join('')).join('\n');
  const after = bakeMascot(before, frameText);
  if (after === before) {
    console.log('README already up to date');
    return;
  }
  writeFileSync(path, after);
  console.log(`baked centered mascot frame into ${path}`);
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
