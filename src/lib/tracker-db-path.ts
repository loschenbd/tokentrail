import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where "the" tracker DB lives. Every entry point (CLI, launchd daemon,
 * menu-bar app via the daemon's /api) must agree on this, or a user ends up
 * with disjoint databases depending on how they launched Tokentrail.
 *
 * Order: explicit env override; a DB already sitting under the working
 * directory (pre-0.3.4 CLI runs created ./data/tracker.db, and dev checkouts
 * keep theirs there); the known dev-checkout locations; then the stable
 * per-user Application Support path, which is also the default when nothing
 * exists yet.
 */
export function resolveTrackerDbPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  cwd: string = process.cwd()
): string {
  if (env.TRACKER_DB_PATH) return env.TRACKER_DB_PATH;
  const candidates = [
    resolve(cwd, 'data', 'tracker.db'),
    join(home, 'Projects', 'tokentrail', 'data', 'tracker.db'),
    join(home, 'tokentrail', 'data', 'tracker.db'),
    join(home, 'Library', 'Application Support', 'tokentrail', 'tracker.db'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1]!;
}
