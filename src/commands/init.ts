import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { runInstallHook } from './install-hook.js';
import { runInstallSkills } from './install-skills.js';
import { pkgRoot } from '../lib/pkg-root.js';

export type InitOptions = {
  dryRun?: boolean;
  force?: boolean;
  skipSwiftbar?: boolean;
  skipDaemon?: boolean;
  skipHook?: boolean;
  skipApp?: boolean;
  /** Override the tokentrail binary path written into the launchd plist. Surfaced as --node-path on the CLI; used by tests for the resolveTokentrailBin fallback path. */
  nodePath?: string;
};

const DAEMON_LABEL = 'com.tokentrail.daemon';
const DAEMON_PLIST_PATH = join(
  homedir(),
  'Library',
  'LaunchAgents',
  `${DAEMON_LABEL}.plist`
);
const DAEMON_LOG_PATH = join(homedir(), 'Library', 'Logs', 'tokentrail-daemon.log');
const SWIFTBAR_PLUGIN_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  'SwiftBar'
);
const SWIFTBAR_PLUGIN_NAME = 'tokentrail.1m.sh';
const APP_NAME = 'Tokentrail.app';
const APP_DEST_DIR = join(homedir(), 'Applications');

export function runInit(opts: InitOptions = {}): void {
  if (platform() !== 'darwin') {
    console.error('tokentrail init: macOS-only. SwiftBar + launchd are not available elsewhere.');
    process.exitCode = 1;
    return;
  }

  const repoRoot = pkgRoot();

  console.log('Tokentrail init — laying out a trail you can find again.\n');

  if (!opts.skipSwiftbar) installSwiftBarPlugin(opts, repoRoot);
  if (!opts.skipDaemon) installDaemon(opts, repoRoot);
  installSkills(opts);
  if (!opts.skipHook) installRepoHook(opts, repoRoot);
  if (!opts.skipApp) installApp(opts, repoRoot);

  printNextSteps(opts);
}

export function installSwiftBarPlugin(opts: InitOptions, repoRoot: string): void {
  console.log('• SwiftBar plugin');
  if (!existsSync('/Applications/SwiftBar.app')) {
    console.log('    SwiftBar.app not found in /Applications.');
    console.log('    Install it with:  brew install --cask swiftbar');
    console.log('    Then re-run:      tokentrail init');
    return;
  }

  const src = join(repoRoot, 'scripts', 'menubar', SWIFTBAR_PLUGIN_NAME);
  const dst = join(SWIFTBAR_PLUGIN_DIR, SWIFTBAR_PLUGIN_NAME);

  if (!existsSync(src)) {
    console.log(`    [warn] plugin source missing: ${src}`);
    return;
  }

  if (!opts.dryRun) mkdirSync(SWIFTBAR_PLUGIN_DIR, { recursive: true });

  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(dst);
  } catch {
    /* no entry */
  }

  if (existing?.isSymbolicLink()) {
    let target: string | null = null;
    try { target = readlinkSync(dst); } catch { /* unreadable */ }
    if (target === src) {
      console.log(`    [ok] plugin already linked: ${dst}`);
      return;
    }
    if (!opts.force) {
      console.log(`    [skip] ${dst} points elsewhere — pass --force to replace.`);
      return;
    }
    if (!opts.dryRun) unlinkSync(dst);
  } else if (existing) {
    if (!opts.force) {
      console.log(`    [skip] ${dst} exists (not a symlink) — pass --force to replace.`);
      return;
    }
    if (!opts.dryRun) unlinkSync(dst);
  }

  if (opts.dryRun) {
    console.log(`    [dry] would link ${dst} → ${src}`);
    return;
  }

  symlinkSync(src, dst);
  console.log(`    [linked] ${dst} → ${src}`);
}

/**
 * Pick the path to write into the launchd plist's ProgramArguments.
 *
 * On brew installs, process.argv[1] is the symlinked
 *   /opt/homebrew/bin/tokentrail
 * but if Node was invoked via the resolved real path under Cellar/, we
 * pattern-match that and walk up to the symlink — surviving brew upgrade.
 *
 * For dev (tsx) and npm runs, returns process.argv[1] verbatim.
 */
export function resolveTokentrailBin(argv1: string = process.argv[1] ?? ''): string {
  const m = argv1.match(/^(.*)\/Cellar\/tokentrail\/[^/]+\/libexec\/bin\/tokentrail$/);
  if (m) {
    const stable = join(m[1]!, 'bin', 'tokentrail');
    if (existsSync(stable)) return stable;
  }
  return argv1;
}

export function installDaemon(opts: InitOptions, repoRoot: string): void {
  console.log('• Dashboard daemon (launchd)');

  const tokentrailBin = opts.nodePath ?? resolveTokentrailBin();
  if (!tokentrailBin || !existsSync(tokentrailBin)) {
    console.log(`    [warn] could not resolve tokentrail binary path (argv1=${process.argv[1]})`);
    console.log('           Daemon not installed. Re-run with --node-path <absolute path> to override.');
    return;
  }

  const plist = renderDaemonPlist({ tokentrailBin, repoRoot });

  const plistDir = dirname(DAEMON_PLIST_PATH);
  const exists = existsSync(DAEMON_PLIST_PATH);

  if (exists && !opts.force) {
    if (isLoaded(DAEMON_LABEL)) {
      console.log(`    [ok] daemon already loaded (${DAEMON_LABEL}).`);
    } else {
      console.log(`    [ok] plist exists at ${DAEMON_PLIST_PATH}, loading...`);
      if (!opts.dryRun) launchctlLoad(DAEMON_PLIST_PATH);
    }
    return;
  }

  if (opts.dryRun) {
    console.log(`    [dry] would write ${DAEMON_PLIST_PATH}`);
    console.log(`    [dry] would launchctl load ${DAEMON_PLIST_PATH}`);
    return;
  }

  mkdirSync(plistDir, { recursive: true });
  mkdirSync(dirname(DAEMON_LOG_PATH), { recursive: true });

  if (exists && opts.force && isLoaded(DAEMON_LABEL)) {
    launchctlUnload(DAEMON_PLIST_PATH);
  }

  writeFileSync(DAEMON_PLIST_PATH, plist);
  console.log(`    [wrote] ${DAEMON_PLIST_PATH}`);
  launchctlLoad(DAEMON_PLIST_PATH);
  console.log(`    [loaded] ${DAEMON_LABEL} — dashboard on 127.0.0.1:4920`);
}

function installSkills(opts: InitOptions): void {
  console.log('• Claude Code skill + slash commands');
  runInstallSkills({ dryRun: opts.dryRun, force: opts.force });
}

function installRepoHook(opts: InitOptions, repoRoot: string): void {
  console.log('• Session-end hook (this repo)');
  runInstallHook({ repo: repoRoot, dryRun: opts.dryRun });
}

/**
 * Symlink the Tokentrail.app launcher into ~/Applications/ so it shows up
 * in Spotlight, LaunchPad, and Finder. We do this from init (not from the
 * Homebrew formula's post_install) because brew's post_install context
 * silently drops writes outside HOMEBREW_PREFIX — the symlink to ~/Apps/
 * never lands. Running it here as the user, post-install, avoids that.
 *
 * Source path: <repoRoot>/scripts/macos-app/dist/Tokentrail.app
 *   - On brew installs, repoRoot is libexec, so the .app is already built
 *     and waiting for us there (the formula's `make app` step produces it).
 *   - On dev checkouts, the .app exists only if the user ran
 *     `make -C scripts/macos-app app` themselves — we skip with a hint if
 *     it's missing rather than erroring.
 */
export function installApp(opts: InitOptions, repoRoot: string): void {
  console.log('• Tokentrail.app launcher');

  const src = join(repoRoot, 'scripts', 'macos-app', 'dist', APP_NAME);
  const dst = join(APP_DEST_DIR, APP_NAME);

  if (!existsSync(src)) {
    console.log(`    [skip] no .app at ${src}`);
    console.log('           (Build it with: make -C scripts/macos-app app)');
    return;
  }

  if (!opts.dryRun) mkdirSync(APP_DEST_DIR, { recursive: true });

  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(dst);
  } catch {
    /* no entry */
  }

  if (existing?.isSymbolicLink()) {
    let target: string | null = null;
    try { target = readlinkSync(dst); } catch { /* unreadable */ }
    if (target === src) {
      console.log(`    [ok] launcher already linked: ${dst}`);
      return;
    }
    if (!opts.force) {
      console.log(`    [skip] ${dst} points elsewhere — pass --force to replace.`);
      return;
    }
    if (!opts.dryRun) unlinkSync(dst);
  } else if (existing) {
    if (!opts.force) {
      console.log(`    [skip] ${dst} exists (not a symlink) — pass --force to replace.`);
      return;
    }
    if (!opts.dryRun) unlinkSync(dst);
  }

  if (opts.dryRun) {
    console.log(`    [dry] would link ${dst} → ${src}`);
    return;
  }

  symlinkSync(src, dst);
  console.log(`    [linked] ${dst} → ${src}`);
}

function printNextSteps(opts: InitOptions): void {
  console.log('\nTrail laid.');
  if (opts.dryRun) {
    console.log('(Dry run — nothing was written. Re-run without --dry-run to apply.)');
    return;
  }
  console.log('  · Check your menu bar in the next ~60 seconds for the running total.');
  console.log('  · Open the dashboard:  open http://127.0.0.1:4920');
  console.log('  · See the trail:       tokentrail report');
}

export function renderDaemonPlist(args: { tokentrailBin: string; repoRoot: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${args.tokentrailBin}</string>
    <string>dashboard</string>
    <string>--no-open</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${args.repoRoot}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DAEMON_LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${DAEMON_LOG_PATH}</string>
</dict>
</plist>
`;
}

function isLoaded(label: string): boolean {
  try {
    execFileSync('/bin/launchctl', ['list', label], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function launchctlLoad(plistPath: string): void {
  try {
    execFileSync('/bin/launchctl', ['load', plistPath], { stdio: 'pipe' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`    [warn] launchctl load failed: ${msg.trim()}`);
  }
}

function launchctlUnload(plistPath: string): void {
  try {
    execFileSync('/bin/launchctl', ['unload', plistPath], { stdio: 'ignore' });
  } catch {
    /* not loaded — fine */
  }
}
