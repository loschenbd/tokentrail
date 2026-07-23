import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { findGitRoot, runInstallHook } from './install-hook.js';
import { runInstallSkills } from './install-skills.js';
import { pkgRoot } from '../lib/pkg-root.js';
import { resolveTrackerDbPath } from '../lib/tracker-db-path.js';

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

// Native menu-bar app (SwiftUI). Built by scripts/menubar-native/build.sh
// into dist/Tokentrail.app; the formula runs that build so on brew installs
// it's waiting in libexec. A LaunchAgent (mirroring the daemon) keeps it
// running across logins without needing a login-item / SMAppService dance.
const MENUBAR_APP_SRC_REL = join('scripts', 'menubar-native', 'dist', APP_NAME);
const MENUBAR_APP_BINARY = 'Tokentrail'; // Contents/MacOS/<CFBundleExecutable>
const MENUBAR_LABEL = 'com.benjaminloschen.tokentrail.menubar';
const MENUBAR_PLIST_PATH = join(
  homedir(),
  'Library',
  'LaunchAgents',
  `${MENUBAR_LABEL}.plist`
);

export function runInit(opts: InitOptions = {}): void {
  if (platform() !== 'darwin') {
    console.error('tokentrail init: macOS-only. SwiftBar + launchd are not available elsewhere.');
    process.exitCode = 1;
    return;
  }

  const repoRoot = pkgRoot();

  console.log('Tokentrail init — laying out a trail you can find again.\n');

  if (!opts.skipDaemon) installDaemon(opts, repoRoot);
  installSkills(opts);
  if (!opts.skipHook) installRepoHook(opts);
  // The native menu-bar app replaces the old SwiftBar plugin + launcher.
  // --skip-swiftbar is kept as a back-compat alias for --skip-app.
  if (!opts.skipApp && !opts.skipSwiftbar) installMenubarApp(opts, repoRoot);

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

// The daemon's WorkingDirectory is pkgRoot() — on brew installs that's the
// Cellar libexec, where a cwd-relative `data/tracker.db` would spawn a fresh
// empty DB that gets wiped on every upgrade. The plist therefore pins an
// absolute TRACKER_DB_PATH, resolved by the same shared search every other
// entry point uses.
export { resolveTrackerDbPath };

export function installDaemon(opts: InitOptions, repoRoot: string): void {
  console.log('• Dashboard daemon (launchd)');

  const tokentrailBin = opts.nodePath ?? resolveTokentrailBin();
  if (!tokentrailBin || !existsSync(tokentrailBin)) {
    console.log(`    [warn] could not resolve tokentrail binary path (argv1=${process.argv[1]})`);
    console.log('           Daemon not installed. Re-run with --node-path <absolute path> to override.');
    return;
  }

  const plist = renderDaemonPlist({ tokentrailBin, repoRoot, trackerDbPath: resolveTrackerDbPath() });

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

function installRepoHook(opts: InitOptions): void {
  console.log('• Session-end hook (this repo)');
  // "This repo" is the git repo init was run from — NOT pkgRoot(), which on
  // brew installs is the Cellar libexec: a settings.json written there is
  // not the user's repo and gets wiped on every upgrade.
  const repo = findGitRoot(process.cwd());
  if (!repo) {
    console.log(
      '    (skipped — not inside a git repo. Run `tokentrail init` from a repo\n' +
      '    you use Claude Code in, or `tokentrail install-hook` there later.)'
    );
    return;
  }
  runInstallHook({ repo, dryRun: opts.dryRun });
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

/**
 * Install the native SwiftUI menu-bar app — the replacement for the old
 * SwiftBar plugin + AppKit launcher. Copies the built .app into
 * ~/Applications (a real bundle survives brew upgrades; a symlink into the
 * versioned Cellar would dangle), then registers a LaunchAgent that launches
 * it at login and immediately. Ad-hoc signing is fine because the app is
 * BUILT on this machine — no com.apple.quarantine, so Gatekeeper never
 * challenges it (no "Open Anyway" needed).
 *
 * Source: <repoRoot>/scripts/menubar-native/dist/Tokentrail.app
 *   - brew: repoRoot is libexec; the formula's build.sh step produced it.
 *   - dev:  exists only if you ran scripts/menubar-native/build.sh — we skip
 *           with a hint (and a Swift-toolchain nudge) rather than erroring.
 */
export function installMenubarApp(opts: InitOptions, repoRoot: string): void {
  console.log('• Tokentrail menu-bar app');

  const src = join(repoRoot, MENUBAR_APP_SRC_REL);
  const dst = join(APP_DEST_DIR, APP_NAME);

  if (!existsSync(src)) {
    console.log(`    [skip] no .app at ${src}`);
    console.log('           Build it with: scripts/menubar-native/build.sh');
    console.log('           (needs the Swift toolchain — xcode-select --install)');
    return;
  }

  if (opts.dryRun) {
    console.log(`    [dry] would copy ${src} → ${dst}`);
    console.log(`    [dry] would write + load ${MENUBAR_PLIST_PATH}`);
    return;
  }

  mkdirSync(APP_DEST_DIR, { recursive: true });

  // Stop any running instance so the copy doesn't clobber a live bundle,
  // then replace the copy and relaunch via launchd below.
  stopMenubarApp();
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  console.log(`    [copied] ${dst}`);

  // LaunchAgent → starts now and at each login. No KeepAlive, so the app's
  // own Quit stays quit until the next login (not instantly relaunched).
  const appBinary = join(dst, 'Contents', 'MacOS', MENUBAR_APP_BINARY);
  mkdirSync(dirname(MENUBAR_PLIST_PATH), { recursive: true });
  if (isLoaded(MENUBAR_LABEL)) launchctlUnload(MENUBAR_PLIST_PATH);
  writeFileSync(MENUBAR_PLIST_PATH, renderMenubarPlist(appBinary));
  launchctlLoad(MENUBAR_PLIST_PATH);
  console.log(`    [loaded] ${MENUBAR_LABEL} — menu-bar total appears within ~60s`);
}

function stopMenubarApp(): void {
  try {
    execFileSync(
      '/usr/bin/pkill',
      ['-f', `${APP_NAME}/Contents/MacOS/${MENUBAR_APP_BINARY}`],
      { stdio: 'ignore' }
    );
  } catch {
    /* not running — fine */
  }
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

export function renderDaemonPlist(args: {
  tokentrailBin: string;
  repoRoot: string;
  trackerDbPath: string;
}): string {
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
  <key>EnvironmentVariables</key>
  <dict>
    <key>TRACKER_DB_PATH</key>
    <string>${args.trackerDbPath}</string>
  </dict>
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

export function renderMenubarPlist(appBinary: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MENUBAR_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${appBinary}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
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
