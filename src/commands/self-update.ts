import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';

import { currentUid } from '../lib/daemon-identity.js';
import { pkgRoot } from '../lib/pkg-root.js';
import {
  APP_NAME,
  DAEMON_LABEL,
  MENUBAR_APP_BINARY,
  MENUBAR_APP_SRC_REL,
  MENUBAR_LABEL,
} from './init.js';

// Keeps each Mac account's daemon and menu-bar app on the installed version.
//
// `brew upgrade`, run from one account, replaces the shared code under the
// Homebrew prefix. It can't restart another account's daemon or replace the
// app copy in that account's ~/Applications (that account's ~/Library is
// private). So each account's launchd daemon does it for itself: it exits when
// the installed version changes (KeepAlive starts it again on the new code),
// and on startup it replaces an older menu-bar app copy with the one the
// install built. An account that was logged out catches up at its next login.

const UPGRADE_CHECK_MS = 60_000;
const CLOSE_GRACE_MS = 2_000;

/** True only for the launchd daemon; launchd sets XPC_SERVICE_NAME to the job's label. */
export function isLaunchdDaemon(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.XPC_SERVICE_NAME === DAEMON_LABEL;
}

function readVersion(pkgJson: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(pkgJson, 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/** The version of the code this process loaded. */
export function runningVersion(root: string = pkgRoot()): string | null {
  return readVersion(join(root, 'package.json'));
}

/**
 * The version `entry` points at now. For the daemon that's argv[1], the
 * prefix's bin symlink, which `brew upgrade` repoints at the new Cellar.
 */
export function installedVersion(entry: string | undefined = process.argv[1]): string | null {
  if (!entry) return null;
  let dir: string;
  try {
    dir = dirname(realpathSync(entry));
  } catch {
    return null; // mid-upgrade the symlink can briefly dangle
  }
  const { root } = parse(dir);
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return readVersion(candidate);
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

export type UpgradeWatch = { check: () => boolean; stop: () => void };

/** Calls `onUpgrade` once, the first time the installed version differs from `running`. */
export function watchForUpgrade(
  running: string | null,
  onUpgrade: (installed: string) => void,
  opts: { installed?: () => string | null; intervalMs?: number } = {}
): UpgradeWatch {
  const installed = opts.installed ?? (() => installedVersion());
  let fired = false;
  const timer = setInterval(() => check(), opts.intervalMs ?? UPGRADE_CHECK_MS);
  timer.unref();
  function check(): boolean {
    if (fired || !running) return false;
    const now = installed();
    if (!now || now === running) return false;
    fired = true;
    clearInterval(timer);
    onUpgrade(now);
    return true;
  }
  return { check, stop: () => clearInterval(timer) };
}

/** Numeric x.y.z comparison; anything after a non-digit in a part is ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export function bundleVersion(app: string): string | null {
  try {
    const xml = readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8');
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Runs a command; true when it exits 0 (pgrep: a process matched). */
export type Runner = (file: string, args: string[]) => boolean;

const defaultRun: Runner = (file, args) => {
  try {
    execFileSync(file, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export type AppRefresh = 'updated' | 'current' | 'not-installed' | 'no-build' | 'failed';

/**
 * Replace this account's ~/Applications copy of the menu-bar app when the
 * install built a newer one. Only touches an app `tokentrail init` installed
 * (bundle and LaunchAgent both present), and relaunches it only if it was
 * running, so a Quit stays quit.
 */
export async function refreshMenubarApp(opts: {
  home?: string;
  packagedApp?: string;
  uid?: number | null;
  run?: Runner;
  pauseMs?: number;
} = {}): Promise<AppRefresh> {
  const home = opts.home ?? homedir();
  const src = opts.packagedApp ?? join(pkgRoot(), MENUBAR_APP_SRC_REL);
  const dst = join(home, 'Applications', APP_NAME);
  const agent = join(home, 'Library', 'LaunchAgents', `${MENUBAR_LABEL}.plist`);
  const run = opts.run ?? defaultRun;

  if (!existsSync(dst) || !existsSync(agent)) return 'not-installed';
  const built = bundleVersion(src);
  if (!built) return 'no-build';
  const have = bundleVersion(dst);
  if (have && compareVersions(have, built) >= 0) return 'current';

  const uid = opts.uid === undefined ? currentUid() : opts.uid;
  const match = [...(uid === null ? [] : ['-U', String(uid)]), '-f', join(dst, 'Contents', 'MacOS', MENUBAR_APP_BINARY)];
  const wasRunning = run('/usr/bin/pgrep', match);
  const staged = `${dst}.updating-${process.pid}`;
  try {
    // Copy beside the old bundle first, so a failed copy leaves the old app in place.
    rmSync(staged, { recursive: true, force: true });
    cpSync(src, staged, { recursive: true });
    if (wasRunning) {
      run('/usr/bin/pkill', match);
      // `open` would only re-activate a copy that hasn't exited yet.
      for (let i = 0; i < 20 && run('/usr/bin/pgrep', match); i++) {
        await new Promise((r) => setTimeout(r, opts.pauseMs ?? 150));
      }
    }
    rmSync(dst, { recursive: true, force: true });
    renameSync(staged, dst);
  } catch (err) {
    rmSync(staged, { recursive: true, force: true });
    console.error('[daemon] menu-bar app update failed:', err instanceof Error ? err.message : err);
    return 'failed';
  }
  // `open`, not a launchd kickstart: kickstart after a bundle swap has failed
  // with OS_REASON_CODESIGNING. The LaunchAgent still starts it at login.
  if (wasRunning) run('/usr/bin/open', [dst]);
  return 'updated';
}

/** Daemon-only: bring this account's app up to the install, then restart when the install changes. */
export async function followInstalledVersion(close: () => Promise<unknown>): Promise<void> {
  const app = await refreshMenubarApp();
  if (app === 'updated') console.log('[daemon] menu-bar app updated to the installed version.');

  watchForUpgrade(runningVersion(), (installed) => {
    console.log(`[daemon] tokentrail ${installed} is installed; restarting onto it.`);
    const grace = new Promise((r) => setTimeout(r, CLOSE_GRACE_MS).unref());
    Promise.race([close().catch(() => {}), grace]).finally(() => process.exit(0));
  });
}
