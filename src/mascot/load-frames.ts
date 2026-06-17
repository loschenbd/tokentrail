import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export type Frame = { bend: { dx: number; dy: number }; grid: string[][] };
export type FrameBundle = { cols: number; rows: number; centerIndex: number; frames: Frame[] };

export function loadFrames(): FrameBundle | null {
  const here = dirname(fileURLToPath(import.meta.url));
  return loadFramesFrom(join(here, 'frames.json'));
}

export function loadFramesFrom(path: string): FrameBundle | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    process.stderr.write(`tokentrail mascot: frames.json not found at ${path}\n`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`tokentrail mascot: frames.json is malformed JSON\n`);
    return null;
  }
  if (!isFrameBundle(parsed)) {
    process.stderr.write(`tokentrail mascot: frames.json has unexpected shape\n`);
    return null;
  }
  return parsed;
}

function isFrameBundle(x: unknown): x is FrameBundle {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.cols === 'number' &&
    typeof o.rows === 'number' &&
    typeof o.centerIndex === 'number' &&
    Array.isArray(o.frames)
  );
}
