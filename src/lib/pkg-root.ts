import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

/**
 * Walk up from this module's directory until a `package.json` is found.
 * Returns that directory. Throws after 8 hops without a hit.
 *
 * Works in dev (finds the git checkout root) and post-install
 * (finds the installed package root, e.g.
 *  /opt/homebrew/lib/node_modules/tokentrail/).
 */
export function pkgRoot(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json'))) {
      cached = dir;
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`tokentrail: could not locate package root from ${import.meta.url}`);
}
