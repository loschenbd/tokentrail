import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTrailMap } from '../../src/dashboard/render/trail-map.js';
import type { SetupStatus } from '../../src/dashboard/data/setup-status.js';

const ALL_FALSE: SetupStatus = {
  swiftbarApp: false,
  menubarPlugin: false,
  daemon: false,
  skills: false,
  hook: false,
};
const ALL_TRUE: SetupStatus = {
  swiftbarApp: true,
  menubarPlugin: true,
  daemon: true,
  skills: true,
  hook: true,
};

describe('renderTrailMap welcome checklist', () => {
  test('renders the 6-row checklist when nothing is installed', () => {
    const html = renderTrailMap({ mode: 'welcome', setupStatus: ALL_FALSE });
    assert.match(html, /data-tt-setup/);
    for (const key of ['cli', 'swiftbarApp', 'menubarPlugin', 'daemon', 'skills', 'hook']) {
      assert.match(html, new RegExp(`data-row="${key}"`));
    }
    assert.match(html, /data-action="menubarPlugin"/);
    assert.match(html, /data-action="daemon"/);
    assert.match(html, /data-action="skills"/);
    assert.match(html, /data-show="swiftbarApp"/);
    assert.match(html, /data-show="hook"/);
    assert.doesNotMatch(html, /tt-setup-done/);
  });

  test('collapses to "Setup complete" when every step is done', () => {
    const html = renderTrailMap({ mode: 'welcome', setupStatus: ALL_TRUE });
    assert.match(html, /tt-setup-done/);
    assert.match(html, /Setup complete/);
    assert.match(html, /href="\/welcome"[^>]*tt-recheck/);
    assert.doesNotMatch(html, /data-row="menubarPlugin"/);
    assert.doesNotMatch(html, /data-action=/);
  });

  test('omits the checklist entirely when setupStatus is not provided', () => {
    const html = renderTrailMap({ mode: 'onboarding' });
    assert.doesNotMatch(html, /data-tt-setup/);
  });
});
