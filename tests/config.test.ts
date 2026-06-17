import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigFrom } from '../src/lib/config.js';

function writeConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tokentrail-config-'));
  const path = join(dir, '.tokentrail.json');
  writeFileSync(path, content);
  return path;
}

describe('loadConfigFrom', () => {
  test('parses a full example with all four extension knobs', () => {
    const path = writeConfig(JSON.stringify({
      extraMainlineBranches: ['trunk'],
      extraBranchPatterns: [
        { pattern: '^release/(.+)$', keyPrefix: 'release-', namePrefix: 'Release: ' },
      ],
      extraProjectsParentDirs: ['Code'],
      featureOverrides: {
        'owner/repo:feat/foo': { featureKey: 'feat-foo', featureName: 'Foo' },
      },
    }));
    const c = loadConfigFrom(path);

    assert.deepEqual(c.extraMainlineBranches, ['trunk']);
    assert.equal(c.extraBranchPatterns.length, 1);
    assert.ok(c.extraBranchPatterns[0]!.pattern instanceof RegExp);
    assert.equal(c.extraBranchPatterns[0]!.keyPrefix, 'release-');
    assert.equal(c.extraBranchPatterns[0]!.namePrefix, 'Release: ');
    assert.deepEqual(c.extraProjectsParentDirs, ['Code']);
    assert.equal(c.featureOverrides['owner/repo:feat/foo']?.featureKey, 'feat-foo');
    assert.equal(c.source, path);
  });

  test('missing fields default to empty', () => {
    const path = writeConfig('{}');
    const c = loadConfigFrom(path);

    assert.deepEqual(c.extraMainlineBranches, []);
    assert.deepEqual(c.extraBranchPatterns, []);
    assert.deepEqual(c.extraProjectsParentDirs, []);
    assert.deepEqual(c.featureOverrides, {});
  });

  test('throws on malformed JSON with the file path in the error', () => {
    const path = writeConfig('{ this is not json');
    assert.throws(() => loadConfigFrom(path), /failed to parse config/);
  });

  test('throws when extraMainlineBranches is not a string array', () => {
    const path = writeConfig(JSON.stringify({ extraMainlineBranches: [1, 2, 3] }));
    assert.throws(() => loadConfigFrom(path), /must be a string array/);
  });

  test('throws when a branch pattern regex is invalid', () => {
    const path = writeConfig(JSON.stringify({
      extraBranchPatterns: [{ pattern: '(', keyPrefix: 'x-' }],
    }));
    assert.throws(() => loadConfigFrom(path), /not a valid regex/);
  });

  test('throws when a featureOverride is missing required fields', () => {
    const path = writeConfig(JSON.stringify({
      featureOverrides: { 'a:b': { featureKey: 'only-key' } },
    }));
    assert.throws(() => loadConfigFrom(path), /must have string featureKey and featureName/);
  });

  test('keyPrefix and namePrefix default to empty when omitted', () => {
    const path = writeConfig(JSON.stringify({
      extraBranchPatterns: [{ pattern: '^x/(.+)$' }],
    }));
    const c = loadConfigFrom(path);
    assert.equal(c.extraBranchPatterns[0]!.keyPrefix, '');
    assert.equal(c.extraBranchPatterns[0]!.namePrefix, '');
  });
});
