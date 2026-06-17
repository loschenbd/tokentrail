import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pkgRoot } from '../../src/lib/pkg-root.js';

describe('pkgRoot', () => {
  test('returns this package root when called from the source tree', () => {
    const root = pkgRoot();
    assert.ok(existsSync(join(root, 'package.json')), `expected package.json at ${root}`);
    // Sanity-check: this is THIS repo, not some node_modules dependency.
    assert.ok(existsSync(join(root, 'src', 'lib', 'pkg-root.ts')));
  });

  test('is memoized — second call returns identical string', () => {
    const a = pkgRoot();
    const b = pkgRoot();
    assert.equal(a, b);
  });
});
