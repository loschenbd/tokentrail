import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommit } from '../src/services/mainline-inference-rules.js';

describe('classifyCommit()', () => {
  test('conventional scope: feat(menubar): X', () => {
    const r = classifyCommit('feat(menubar): visual redesign');
    assert.deepEqual(r, { key: 'menubar', name: 'Menubar', source: 'commit-scope' });
  });

  test('breaking-change bang variant', () => {
    const r = classifyCommit('feat(menubar)!: drop hero title');
    assert.deepEqual(r, { key: 'menubar', name: 'Menubar', source: 'commit-scope' });
  });

  test('no scope: fix: thing → null', () => {
    assert.equal(classifyCommit('fix: broken thing'), null);
  });

  test('non-conventional → null', () => {
    assert.equal(classifyCommit('whatever I did today'), null);
  });

  test('meta-work resolves honestly: chore(release): v0.3', () => {
    const r = classifyCommit('chore(release): v0.3');
    assert.deepEqual(r, { key: 'release', name: 'Release', source: 'commit-scope' });
  });

  test('empty scope → null', () => {
    assert.equal(classifyCommit('feat(): empty'), null);
  });

  test('slash inside scope → slug-normalized', () => {
    const r = classifyCommit('feat(macos/menubar): power off');
    assert.deepEqual(r, { key: 'macos-menubar', name: 'Macos menubar', source: 'commit-scope' });
  });

  test('multi-word scope humanized', () => {
    const r = classifyCommit('refactor(api-client): split');
    assert.deepEqual(r, { key: 'api-client', name: 'Api client', source: 'commit-scope' });
  });
});
