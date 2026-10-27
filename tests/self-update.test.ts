import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundleVersion,
  compareVersions,
  installedVersion,
  isLaunchdDaemon,
  refreshMenubarApp,
  runningVersion,
  watchForUpgrade,
  type Runner,
} from '../src/commands/self-update.js';

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

function writeBundle(app: string, version: string, marker = version): void {
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    `<plist version="1.0"><dict>\n  <key>CFBundleShortVersionString</key><string>${version}</string>\n</dict></plist>\n`
  );
  writeFileSync(join(app, 'Contents', 'MacOS', 'Tokentrail'), marker);
}

/** A home with an init-installed app (bundle + LaunchAgent) and a packaged build. */
function fixture(installed: string | null, packaged: string | null, agent = true) {
  const home = tmp('tt-home-');
  const app = join(home, 'Applications', 'Tokentrail.app');
  if (installed) writeBundle(app, installed);
  if (agent) {
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.benjaminloschen.tokentrail.menubar.plist'), '<plist/>');
  }
  const packagedApp = join(tmp('tt-pkg-'), 'Tokentrail.app');
  if (packaged) writeBundle(packagedApp, packaged);
  return { home, app, packagedApp };
}

/** Fake pgrep/pkill/open: the app "runs" until pkill. */
function fakeProcs(running: boolean) {
  const calls: string[] = [];
  let alive = running;
  const run: Runner = (file, args) => {
    calls.push(`${file.split('/').pop()} ${args.join(' ')}`);
    if (file.endsWith('pgrep')) return alive;
    if (file.endsWith('pkill')) alive = false;
    return true;
  };
  return { run, calls };
}

describe('isLaunchdDaemon', () => {
  test('only the launchd job counts, not a terminal run', () => {
    assert.equal(isLaunchdDaemon({ XPC_SERVICE_NAME: 'com.tokentrail.daemon' }), true);
    assert.equal(isLaunchdDaemon({ XPC_SERVICE_NAME: 'application.com.mitchellh.ghostty.1' }), false);
    assert.equal(isLaunchdDaemon({}), false);
  });
});

describe('installed and running versions', () => {
  test('installedVersion follows the bin symlink into the current Cellar', () => {
    const prefix = tmp('tt-brew-');
    const libexec = join(prefix, 'Cellar', 'tokentrail', '0.19.1', 'libexec');
    mkdirSync(join(libexec, 'dist', 'src'), { recursive: true });
    writeFileSync(join(libexec, 'package.json'), JSON.stringify({ version: '0.19.1' }));
    writeFileSync(join(libexec, 'dist', 'src', 'index.js'), '');
    mkdirSync(join(prefix, 'bin'));
    symlinkSync(join(libexec, 'dist', 'src', 'index.js'), join(prefix, 'bin', 'tokentrail'));
    assert.equal(installedVersion(join(prefix, 'bin', 'tokentrail')), '0.19.1');
  });

  test('installedVersion is null when the entry dangles (mid-upgrade)', () => {
    const dir = tmp('tt-brew-');
    symlinkSync(join(dir, 'gone.js'), join(dir, 'tokentrail'));
    assert.equal(installedVersion(join(dir, 'tokentrail')), null);
    assert.equal(installedVersion(''), null);
  });

  test('runningVersion reads the package root', () => {
    const root = tmp('tt-root-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.19.0' }));
    assert.equal(runningVersion(root), '0.19.0');
  });
});

describe('watchForUpgrade', () => {
  test('fires once when the installed version changes', () => {
    let installed: string | null = '0.19.0';
    const seen: string[] = [];
    const w = watchForUpgrade('0.19.0', (v) => seen.push(v), { installed: () => installed });
    assert.equal(w.check(), false);
    installed = '0.19.1';
    assert.equal(w.check(), true);
    assert.equal(w.check(), false);
    assert.deepEqual(seen, ['0.19.1']);
    w.stop();
  });

  test('ignores an unreadable install and an unknown running version', () => {
    const seen: string[] = [];
    const a = watchForUpgrade('0.19.0', (v) => seen.push(v), { installed: () => null });
    const b = watchForUpgrade(null, (v) => seen.push(v), { installed: () => '0.19.1' });
    assert.equal(a.check(), false);
    assert.equal(b.check(), false);
    assert.deepEqual(seen, []);
    a.stop();
    b.stop();
  });
});

describe('compareVersions / bundleVersion', () => {
  test('compares numerically, not as strings', () => {
    assert.equal(compareVersions('0.19.0', '0.19.1'), -1);
    assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
    assert.equal(compareVersions('0.19.0', '0.19.0'), 0);
  });

  test('reads CFBundleShortVersionString, null when there is no bundle', () => {
    const app = join(tmp('tt-app-'), 'Tokentrail.app');
    writeBundle(app, '0.18.0');
    assert.equal(bundleVersion(app), '0.18.0');
    assert.equal(bundleVersion(join(tmpdir(), 'tt-no-such.app')), null);
  });
});

describe('refreshMenubarApp', () => {
  test('replaces an older running copy and relaunches it', async () => {
    const f = fixture('0.18.0', '0.19.1');
    const p = fakeProcs(true);
    const result = await refreshMenubarApp({ home: f.home, packagedApp: f.packagedApp, uid: 503, run: p.run, pauseMs: 0 });
    assert.equal(result, 'updated');
    assert.equal(bundleVersion(f.app), '0.19.1');
    assert.equal(readFileSync(join(f.app, 'Contents', 'MacOS', 'Tokentrail'), 'utf8'), '0.19.1');
    const binary = join(f.app, 'Contents', 'MacOS', 'Tokentrail');
    // Scoped to this account's uid and this exact binary, never another user's app.
    assert.ok(p.calls.includes(`pkill -U 503 -f ${binary}`), p.calls.join('\n'));
    assert.equal(p.calls.at(-1), `open ${f.app}`);
    assert.equal(existsSync(`${f.app}.updating-${process.pid}`), false);
  });

  test('swaps the files but leaves a quit app quit', async () => {
    const f = fixture('0.18.0', '0.19.1');
    const p = fakeProcs(false);
    assert.equal(await refreshMenubarApp({ home: f.home, packagedApp: f.packagedApp, uid: 503, run: p.run }), 'updated');
    assert.equal(bundleVersion(f.app), '0.19.1');
    assert.ok(!p.calls.some((c) => c.startsWith('pkill') || c.startsWith('open')), p.calls.join('\n'));
  });

  test('leaves a current or newer copy alone', async () => {
    for (const installed of ['0.19.1', '0.20.0']) {
      const f = fixture(installed, '0.19.1');
      const p = fakeProcs(true);
      assert.equal(await refreshMenubarApp({ home: f.home, packagedApp: f.packagedApp, run: p.run }), 'current');
      assert.equal(bundleVersion(f.app), installed);
      assert.deepEqual(p.calls, []);
    }
  });

  test('never installs an app the account did not install with init', async () => {
    const noApp = fixture(null, '0.19.1');
    const noAgent = fixture('0.18.0', '0.19.1', false);
    for (const f of [noApp, noAgent]) {
      const p = fakeProcs(false);
      assert.equal(await refreshMenubarApp({ home: f.home, packagedApp: f.packagedApp, run: p.run }), 'not-installed');
      assert.deepEqual(p.calls, []);
    }
    assert.equal(existsSync(noApp.app), false);
  });

  test('does nothing when the install has no app build (Swift build skipped)', async () => {
    const f = fixture('0.18.0', null);
    const p = fakeProcs(true);
    assert.equal(await refreshMenubarApp({ home: f.home, packagedApp: f.packagedApp, run: p.run }), 'no-build');
    assert.equal(bundleVersion(f.app), '0.18.0');
  });
});
