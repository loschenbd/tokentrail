import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  daemonWorkingDir,
  renderDaemonPlist,
  resolveTokentrailBin,
  resolveTrackerDbPath,
  workingDirStale,
} from '../src/commands/init.js';

describe('renderDaemonPlist', () => {
  test('plist invokes the installed tokentrail bin and drops the tsx loader', () => {
    const plist = renderDaemonPlist({
      tokentrailBin: '/opt/homebrew/bin/tokentrail',
      workingDir: '/tmp/repo',
      trackerDbPath: '/tmp/repo/data/tracker.db',
    });
    assert.match(plist, /<string>\/opt\/homebrew\/bin\/tokentrail<\/string>/);
    assert.match(plist, /<string>dashboard<\/string>/);
    assert.match(plist, /<string>--no-open<\/string>/);
    assert.doesNotMatch(plist, /tsx/);
    assert.doesNotMatch(plist, /--import/);
    assert.doesNotMatch(plist, /index\.ts/);
  });

  test('plist pins TRACKER_DB_PATH so a brew daemon never opens a Cellar-local DB', () => {
    const plist = renderDaemonPlist({
      tokentrailBin: '/opt/homebrew/bin/tokentrail',
      workingDir: '/Users/dev/Library/Application Support/Tokentrail',
      trackerDbPath: '/Users/dev/Projects/tokentrail/data/tracker.db',
    });
    assert.match(plist, /<key>EnvironmentVariables<\/key>/);
    assert.match(plist, /<key>TRACKER_DB_PATH<\/key>/);
    assert.match(plist, /<string>\/Users\/dev\/Projects\/tokentrail\/data\/tracker\.db<\/string>/);
  });
});

describe('daemonWorkingDir', () => {
  const stable = '/Users/dev/Library/Application Support/Tokentrail';

  test('a brew install never puts the versioned Cellar folder in the plist', () => {
    // `brew upgrade` deletes the old Cellar folder; launchd then can't chdir.
    assert.equal(daemonWorkingDir('/opt/homebrew/Cellar/tokentrail/0.19.0/libexec', stable), stable);
    assert.equal(daemonWorkingDir('/usr/local/Cellar/tokentrail/0.19.0', stable), stable);
  });

  test('a dev checkout keeps its repo root, so the daemon reads the repo .env', () => {
    assert.equal(daemonWorkingDir('/Users/dev/Projects/tokentrail', stable), '/Users/dev/Projects/tokentrail');
  });

  test('the rendered plist names the directory it is given', () => {
    const plist = renderDaemonPlist({
      tokentrailBin: '/opt/homebrew/bin/tokentrail',
      workingDir: daemonWorkingDir('/opt/homebrew/Cellar/tokentrail/0.19.0/libexec', stable),
      trackerDbPath: '/x/tracker.db',
    });
    assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/dev\/Library\/Application Support\/Tokentrail<\/string>/);
    assert.doesNotMatch(plist, /Cellar/);
  });
});

describe('workingDirStale', () => {
  const plistAt = (workingDir: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'tt-plist-')), 'daemon.plist');
    writeFileSync(path, renderDaemonPlist({ tokentrailBin: '/opt/homebrew/bin/tokentrail', workingDir, trackerDbPath: '/x/tracker.db' }));
    return path;
  };

  test('true when the WorkingDirectory was deleted (an old Cellar folder)', () => {
    assert.equal(workingDirStale(plistAt('/opt/homebrew/Cellar/tokentrail/0.0.0-gone/libexec')), true);
  });

  test('true for a Cellar folder that still exists: the next upgrade deletes it', () => {
    const cellar = join(mkdtempSync(join(tmpdir(), 'tt-brew-')), 'Cellar', 'tokentrail', '0.19.0', 'libexec');
    mkdirSync(cellar, { recursive: true });
    assert.equal(workingDirStale(plistAt(cellar)), true);
  });

  test('false when the WorkingDirectory exists', () => {
    assert.equal(workingDirStale(plistAt(mkdtempSync(join(tmpdir(), 'tt-wd-')))), false);
  });

  test('false when the plist is missing or names no WorkingDirectory', () => {
    assert.equal(workingDirStale(join(tmpdir(), 'tt-no-such-plist.plist')), false);
    const bare = join(mkdtempSync(join(tmpdir(), 'tt-plist-')), 'bare.plist');
    writeFileSync(bare, '<plist><dict><key>Label</key><string>x</string></dict></plist>');
    assert.equal(workingDirStale(bare), false);
  });
});

describe('resolveTrackerDbPath', () => {
  // Explicit neutral cwd: the test process's real cwd is the repo checkout,
  // whose data/tracker.db would otherwise win the candidate search.
  const neutralCwd = () => mkdtempSync(join(tmpdir(), 'tt-cwd-'));

  test('an explicit TRACKER_DB_PATH env always wins', () => {
    assert.equal(
      resolveTrackerDbPath({ TRACKER_DB_PATH: '/custom/tracker.db' }, '/home/none', neutralCwd()),
      '/custom/tracker.db'
    );
  });

  test('an existing DB under the working directory wins over home candidates', () => {
    const home = mkdtempSync(join(tmpdir(), 'tt-home-'));
    const cwd = neutralCwd();
    mkdirSync(join(cwd, 'data'), { recursive: true });
    writeFileSync(join(cwd, 'data', 'tracker.db'), '');
    const homeDbDir = join(home, 'Projects', 'tokentrail', 'data');
    mkdirSync(homeDbDir, { recursive: true });
    writeFileSync(join(homeDbDir, 'tracker.db'), '');
    assert.equal(resolveTrackerDbPath({}, home, cwd), join(cwd, 'data', 'tracker.db'));
  });

  test('picks the first existing candidate under the given home', () => {
    const home = mkdtempSync(join(tmpdir(), 'tt-home-'));
    const dbDir = join(home, 'Projects', 'tokentrail', 'data');
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, 'tracker.db'), '');
    assert.equal(resolveTrackerDbPath({}, home, neutralCwd()), join(dbDir, 'tracker.db'));
  });

  test('falls back to Application Support when no candidate exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'tt-home-'));
    assert.equal(
      resolveTrackerDbPath({}, home, neutralCwd()),
      join(home, 'Library', 'Application Support', 'tokentrail', 'tracker.db')
    );
  });
});

describe('resolveTokentrailBin', () => {
  test('returns argv1 verbatim for non-Cellar paths', () => {
    assert.equal(
      resolveTokentrailBin('/Users/dev/Projects/tokentrail/dist/src/index.js'),
      '/Users/dev/Projects/tokentrail/dist/src/index.js',
    );
    assert.equal(
      resolveTokentrailBin('/usr/local/bin/tokentrail'),
      '/usr/local/bin/tokentrail',
    );
  });

  test('walks Cellar path up to the stable opt symlink when it exists', () => {
    // Build a fake Homebrew layout in tmp: <root>/Cellar/tokentrail/0.2.0/libexec/bin/tokentrail
    // and a sibling <root>/bin/tokentrail that the function should resolve to.
    const root = mkdtempSync(join(tmpdir(), 'tokentrail-cellar-'));
    const cellarBin = join(root, 'Cellar', 'tokentrail', '0.2.0', 'libexec', 'bin', 'tokentrail');
    const stable = join(root, 'bin', 'tokentrail');
    mkdirSync(join(root, 'Cellar', 'tokentrail', '0.2.0', 'libexec', 'bin'), { recursive: true });
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(cellarBin, '#!/usr/bin/env node');
    writeFileSync(stable, '#!/usr/bin/env node');

    assert.equal(resolveTokentrailBin(cellarBin), stable);
  });

  test('falls back to argv1 when Cellar path has no sibling stable symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'tokentrail-cellar-'));
    const cellarBin = join(root, 'Cellar', 'tokentrail', '0.2.0', 'libexec', 'bin', 'tokentrail');
    mkdirSync(join(root, 'Cellar', 'tokentrail', '0.2.0', 'libexec', 'bin'), { recursive: true });
    writeFileSync(cellarBin, '#!/usr/bin/env node');
    // No <root>/bin/tokentrail created.

    assert.equal(resolveTokentrailBin(cellarBin), cellarBin);
  });
});
