import type { Frame, FrameBundle } from '../mascot/load-frames.js';
import { loadFrames } from '../mascot/load-frames.js';

const SEPIA_DARK = '\x1b[38;5;94m';
const SEPIA_MID  = '\x1b[38;5;58m';
const RESET      = '\x1b[0m';

const DARK_CHARS = new Set(['◐', '◑', '●']);
const MID_CHARS  = new Set(['·', '¤']);

export type MascotOptions = { frame?: number; noColor?: boolean };

export function renderFrame(frame: Frame, useColor: boolean): string {
  if (!useColor) {
    return frame.grid.map(row => row.join('')).join('\n');
  }
  return frame.grid.map(row => {
    let out = '';
    let currentColor: '' | typeof SEPIA_DARK | typeof SEPIA_MID = '';
    for (const ch of row) {
      const want: '' | typeof SEPIA_DARK | typeof SEPIA_MID =
        DARK_CHARS.has(ch) ? SEPIA_DARK :
        MID_CHARS.has(ch)  ? SEPIA_MID  : '';
      if (want !== currentColor) {
        if (currentColor) out += RESET;
        if (want) out += want;
        currentColor = want;
      }
      out += ch;
    }
    if (currentColor) out += RESET;
    return out;
  }).join('\n');
}

export function pickFrameIndex(forced: number | undefined, bundle: FrameBundle, now: Date): number {
  if (typeof forced === 'number') {
    if (forced >= 0 && forced < bundle.frames.length) return forced;
    return bundle.centerIndex;
  }
  const h = now.getHours();
  const dyIndex = h < 12 ? 0 : h < 18 ? 1 : 2;
  const idx = dyIndex * 5 + 2;
  return idx < bundle.frames.length ? idx : bundle.centerIndex;
}

export function shouldColor(opts: { noColor?: boolean; env?: NodeJS.ProcessEnv; isTTY?: boolean }): boolean {
  if (opts.noColor) return false;
  const env = opts.env ?? process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return opts.isTTY ?? true;
}

export async function runMascot(opts: MascotOptions): Promise<void> {
  const bundle = loadFrames();
  if (!bundle) {
    process.stderr.write('mascot frames not built — run `npm run build:mascot`\n');
    return;
  }
  const idx = pickFrameIndex(opts.frame, bundle, new Date());
  const useColor = shouldColor({ noColor: opts.noColor, env: process.env, isTTY: process.stdout.isTTY });
  // pickFrameIndex guarantees idx ∈ [0, frames.length)
  process.stdout.write(renderFrame(bundle.frames[idx]!, useColor) + '\n');
}
