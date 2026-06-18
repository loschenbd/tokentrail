import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SetupStatus = {
  swiftbarApp: boolean;
  menubarPlugin: boolean;
  daemon: boolean;
  skills: boolean;
  hook: boolean;
};

export function readSetupStatus(opts: { home?: string; appsDir?: string } = {}): SetupStatus {
  const home = opts.home ?? homedir();
  const appsDir = opts.appsDir ?? '/Applications';

  return {
    swiftbarApp: existsSync(join(appsDir, 'SwiftBar.app')),
    menubarPlugin: existsSync(
      join(home, 'Library', 'Application Support', 'SwiftBar', 'tokentrail.1m.sh'),
    ),
    daemon: existsSync(
      join(home, 'Library', 'LaunchAgents', 'com.tokentrail.daemon.plist'),
    ),
    skills: existsSync(join(home, '.claude', 'skills', 'tokentrail-spend')),
    hook: detectHookInAnyProject(home),
  };
}

function detectHookInAnyProject(home: string): boolean {
  const projectsRoot = join(home, '.claude', 'projects');
  if (!existsSync(projectsRoot)) return false;

  let projects: string[];
  try {
    projects = readdirSync(projectsRoot);
  } catch {
    return false;
  }

  for (const name of projects) {
    const cwdFile = join(projectsRoot, name, 'cwd');
    if (!existsSync(cwdFile)) continue;

    let repo: string;
    try {
      repo = readFileSync(cwdFile, 'utf-8').trim();
    } catch {
      continue;
    }
    if (!repo || !existsSync(repo)) continue;

    const settingsPath = join(repo, '.claude', 'settings.json');
    if (!existsSync(settingsPath)) continue;

    let raw: string;
    try {
      raw = readFileSync(settingsPath, 'utf-8');
    } catch {
      continue;
    }
    if (hasTokentrailStopHook(raw)) return true;
  }
  return false;
}

// Walk the parsed settings.json's Stop hooks and look for a `command` field
// that names Tokentrail's session-end hook. Tighter than the previous
// substring check (which matched if `tokentrail` and `session-end.sh` appeared
// anywhere — including unrelated comments or matcher strings).
function hasTokentrailStopHook(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const stop = (parsed as { hooks?: { Stop?: unknown } })?.hooks?.Stop;
  if (!Array.isArray(stop)) return false;
  for (const group of stop) {
    const hooks = (group as { hooks?: unknown })?.hooks;
    if (!Array.isArray(hooks)) continue;
    for (const h of hooks) {
      const cmd = (h as { command?: unknown })?.command;
      if (typeof cmd !== 'string') continue;
      if (cmd.includes('tokentrail') && cmd.endsWith('session-end.sh')) {
        return true;
      }
    }
  }
  return false;
}
