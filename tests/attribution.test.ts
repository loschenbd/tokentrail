import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { attribute } from '../src/lib/attribution.js';

describe('attribute()', () => {
  test('mainline branch is scoped by repo so different projects do not collapse', () => {
    const a = attribute({ repo: 'octo/anamnesis', branch: 'main' });
    const b = attribute({ repo: 'octo/tokentrail', branch: 'main' });
    assert.notEqual(a.featureKey, b.featureKey);
    assert.equal(a.source, 'mainline');
    assert.equal(b.source, 'mainline');
    assert.match(a.featureKey, /anamnesis/);
    assert.match(b.featureKey, /tokentrail/);
    assert.equal(a.featureName, 'anamnesis (main)');
    assert.equal(b.featureName, 'tokentrail (main)');
  });

  test('feature/ branch prefix still produces a feature-scoped key', () => {
    const a = attribute({ repo: 'octo/x', branch: 'feature/cool-thing' });
    assert.equal(a.source, 'branch-prefix');
    assert.equal(a.featureKey, 'cool-thing');
  });

  test('global mainline fallback when repo is missing', () => {
    const a = attribute({ repo: '', branch: 'main' });
    assert.equal(a.featureKey, 'mainline-main');
    assert.equal(a.featureName, 'Mainline (main)');
  });
});
