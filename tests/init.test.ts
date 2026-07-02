import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderDaemonPlist, resolveTokentrailBin, resolveTrackerDbPath } from '../src/commands/init.js';

describe('renderDaemonPlist', () => {
  test('plist invokes the installed tokentrail bin and drops the tsx loader', () => {
    const plist = renderDaemonPlist({
      tokentrailBin: '/opt/homebrew/bin/tokentrail',
      repoRoot: '/tmp/repo',
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
      repoRoot: '/opt/homebrew/Cellar/tokentrail/0.2.6/libexec',
      trackerDbPath: '/Users/dev/Projects/tokentrail/data/tracker.db',
    });
    assert.match(plist, /<key>EnvironmentVariables<\/key>/);
    assert.match(plist, /<key>TRACKER_DB_PATH<\/key>/);
    assert.match(plist, /<string>\/Users\/dev\/Projects\/tokentrail\/data\/tracker\.db<\/string>/);
  });
});

describe('resolveTrackerDbPath', () => {
  test('an explicit TRACKER_DB_PATH env always wins', () => {
    assert.equal(
      resolveTrackerDbPath({ TRACKER_DB_PATH: '/custom/tracker.db' }, '/home/none'),
      '/custom/tracker.db'
    );
  });

  test('picks the first existing candidate under the given home', () => {
    const home = mkdtempSync(join(tmpdir(), 'tt-home-'));
    const dbDir = join(home, 'Projects', 'tokentrail', 'data');
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, 'tracker.db'), '');
    assert.equal(resolveTrackerDbPath({}, home), join(dbDir, 'tracker.db'));
  });

  test('falls back to Application Support when no candidate exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'tt-home-'));
    assert.equal(
      resolveTrackerDbPath({}, home),
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
