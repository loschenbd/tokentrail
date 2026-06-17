import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bakeMascot } from '../../scripts/bake-readme-mascot.js';

const FRAME = '  ·  ·\n● ● ●';

describe('bakeMascot', () => {
  test('replaces content between markers and wraps it in a fenced code block', () => {
    const before = 'one\n<!-- MASCOT START -->\nOLD CONTENT\n<!-- MASCOT END -->\ntwo\n';
    const after = bakeMascot(before, FRAME);
    assert.match(after, /<!-- MASCOT START -->\n```\n {2}·  ·\n● ● ●\n```\n<!-- MASCOT END -->/);
    assert.equal(after.includes('OLD CONTENT'), false);
    assert.match(after, /^one\n/);
    assert.match(after, /two\n$/);
  });

  test('is idempotent', () => {
    const before = '<!-- MASCOT START -->\nplaceholder\n<!-- MASCOT END -->';
    const once = bakeMascot(before, FRAME);
    const twice = bakeMascot(once, FRAME);
    assert.equal(twice, once);
  });

  test('throws when START marker is missing', () => {
    assert.throws(() => bakeMascot('no markers here\n<!-- MASCOT END -->', FRAME), /MASCOT START/);
  });

  test('throws when END marker is missing', () => {
    assert.throws(() => bakeMascot('<!-- MASCOT START -->\nopen\n', FRAME), /MASCOT END/);
  });
});
