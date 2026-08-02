import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceWorkerJs } from '../src/dashboard/sw.js';

describe('serviceWorkerJs', () => {
  test('caches static, versions the cache, and never caches api/html', () => {
    const src = serviceWorkerJs();
    assert.match(src, /addEventListener\(['"]install['"]/);
    assert.match(src, /addEventListener\(['"]fetch['"]/);
    assert.match(src, /tt-static-v\d+\.\d+\.\d+/, 'cache name must embed the semver');
    assert.match(src, /\/static\//, 'must special-case /static/ for cache-first');
  });
});
