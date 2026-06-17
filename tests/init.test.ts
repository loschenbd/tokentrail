import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderDaemonPlist, resolveTokentrailBin } from '../src/commands/init.js';

describe('renderDaemonPlist', () => {
  test('plist invokes the installed tokentrail bin and drops the tsx loader', () => {
    const plist = renderDaemonPlist({
      tokentrailBin: '/opt/homebrew/bin/tokentrail',
      repoRoot: '/tmp/repo',
    });
    assert.match(plist, /<string>\/opt\/homebrew\/bin\/tokentrail<\/string>/);
    assert.match(plist, /<string>dashboard<\/string>/);
    assert.match(plist, /<string>--no-open<\/string>/);
    assert.doesNotMatch(plist, /tsx/);
    assert.doesNotMatch(plist, /--import/);
    assert.doesNotMatch(plist, /index\.ts/);
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
