import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { pkgRoot } from '../lib/pkg-root.js';

export type InstallHookOptions = {
  /** Repo to patch — defaults to CWD. */
  repo?: string;
  dryRun?: boolean;
  /** Override the hook script's absolute path (for tests). */
  hookPath?: string;
};

export type InstallHookResult = {
  action: 'noop' | 'added' | 'updated';
  settingsPath: string;
  hookPath: string;
};

type StopGroup = { matcher?: string; hooks?: HookEntry[] };
type HookEntry = { type: string; command: string };
type Settings = { hooks?: { Stop?: StopGroup[]; [k: string]: unknown }; [k: string]: unknown };

export function runInstallHook(opts: InstallHookOptions = {}): InstallHookResult {
  const repo = resolve(opts.repo ?? process.cwd());
  const settingsPath = join(repo, '.claude', 'settings.json');
  const hookPath = opts.hookPath ?? join(pkgRoot(), 'src', 'hooks', 'session-end.sh');

  let settings: Settings = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf-8').trim();
    if (raw.length > 0) settings = JSON.parse(raw) as Settings;
  }

  settings.hooks ??= {};
  settings.hooks.Stop ??= [];

  // Find an existing Stop group with matcher "*"; create one if absent.
  let stopGroup = settings.hooks.Stop.find((g) => g.matcher === '*');
  if (!stopGroup) {
    stopGroup = { matcher: '*', hooks: [] };
    settings.hooks.Stop.push(stopGroup);
  }
  stopGroup.hooks ??= [];

  // Look for an existing tokentrail session-end hook (any path that ends in
  // session-end.sh and includes "tokentrail") so we can update its path
  // instead of stacking duplicates when the repo moves.
  const existing = stopGroup.hooks.find(
    (h) =>
      h.type === 'command' &&
      typeof h.command === 'string' &&
      h.command.includes('tokentrail') &&
      h.command.endsWith('session-end.sh')
  );

  if (existing) {
    if (existing.command === hookPath) {
      console.log(`[ok] hook already installed at ${settingsPath}`);
      return { action: 'noop', settingsPath, hookPath };
    }
    if (opts.dryRun) {
      console.log(`[dry] would update hook path: ${existing.command} → ${hookPath}`);
      return { action: 'updated', settingsPath, hookPath };
    }
    existing.command = hookPath;
    writeSettings(settingsPath, settings);
    console.log(`[updated] hook path in ${settingsPath}`);
    return { action: 'updated', settingsPath, hookPath };
  }

  stopGroup.hooks.push({ type: 'command', command: hookPath });

  if (opts.dryRun) {
    console.log(`[dry] would write hook to ${settingsPath}`);
    return { action: 'added', settingsPath, hookPath };
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeSettings(settingsPath, settings);
  console.log(`[added] hook at ${settingsPath} → ${hookPath}`);
  return { action: 'added', settingsPath, hookPath };
}

function writeSettings(path: string, settings: Settings): void {
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
}
