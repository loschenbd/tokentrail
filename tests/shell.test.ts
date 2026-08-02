import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderShell } from '../src/dashboard/render/shell.js';

describe('escapeHtml', () => {
  test('escapes the five HTML-special characters', () => {
    assert.equal(escapeHtml('<script>alert("x" & \'y\')</script>'), '&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;');
  });

  test('leaves plain text alone', () => {
    assert.equal(escapeHtml('hello world'), 'hello world');
  });
});

describe('renderShell', () => {
  test('includes doctype + body + selected window option', () => {
    const html = renderShell({ title: 'Test', days: 30 }, '<div>body</div>');
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<title>Test<\/title>/);
    assert.match(html, /<main><div>body<\/div><\/main>/);
    assert.match(html, /<option value="30" selected>30d<\/option>/);
  });

  test('omits back link when showBack is unset', () => {
    const html = renderShell({ title: 'T', days: 7 }, '');
    assert.equal(html.includes('class="back"'), false);
  });

  test('includes back link when showBack is true', () => {
    const html = renderShell({ title: 'T', days: 7, showBack: true }, '');
    assert.match(html, /class="back" href="\/">← Trail/);
  });

  test('escapes title to prevent XSS', () => {
    const html = renderShell({ title: '<script>alert(1)</script>', days: 30 }, '');
    assert.equal(html.includes('<script>alert(1)</script>'), false);
    assert.match(html, /<title>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
  });
});

describe('renderShell window selector visibility', () => {
  test('shown on window-scoped views', () => {
    for (const tab of ['overview', 'worth-a-look', 'feature', 'project'] as const) {
      const html = renderShell({ title: 't', activeTab: tab, days: 30 }, '');
      assert.match(html, /name="days"/, `window selector missing on ${tab}`);
    }
  });

  test('hidden on Today and Settings — views with no time window', () => {
    for (const tab of ['today', 'settings'] as const) {
      const html = renderShell({ title: 't', activeTab: tab, days: 30 }, '');
      assert.doesNotMatch(html, /name="days"/, `window selector leaked onto ${tab}`);
      assert.doesNotMatch(html, />Window</, `Window label leaked onto ${tab}`);
    }
  });
});

describe('renderShell bottom nav', () => {
  test('renders a bottom tab bar with all four sections', () => {
    const html = renderShell({ title: 't', activeTab: 'overview', days: 30 }, '');
    assert.match(html, /class="bottom-nav"/);
    for (const [href, label] of [['/today', 'Today'], ['/', 'Overview'], ['/worth-a-look', 'Worth'], ['/settings', 'Settings']] as const) {
      assert.ok(html.includes(`href="${href}"`), `bottom nav missing ${label} link`);
    }
  });

  test('Today is the leftmost tab in both navs', () => {
    const html = renderShell({ title: 't', activeTab: 'today', days: 30 }, '');
    // In each nav block, the Today link appears before the Overview link.
    const navTabs = html.slice(html.indexOf('class="nav-tabs"'));
    assert.ok(navTabs.indexOf('/today') < navTabs.indexOf('href="/"'), 'desktop nav: Today not before Overview');
    const bottom = html.slice(html.indexOf('class="bottom-nav"'));
    assert.ok(bottom.indexOf('/today') < bottom.indexOf('href="/"'), 'bottom nav: Today not before Overview');
  });

  test('marks the active bottom-nav item', () => {
    const html = renderShell({ title: 't', activeTab: 'today', days: 30 }, '');
    assert.match(html, /class="bottom-nav-item active"[^>]*href="\/today"|href="\/today"[^>]*class="bottom-nav-item active"/);
  });
});

describe('jsonForScriptTag', () => {
  test('escapes < so payloads cannot close the script tag', async () => {
    const { jsonForScriptTag } = await import('../src/dashboard/render/shell.js');
    const out = jsonForScriptTag({ name: '</script><script>alert(1)' });
    assert.equal(out.includes('</script>'), false);
    assert.match(out, /\\u003c\/script>/);
    assert.deepEqual(JSON.parse(out), { name: '</script><script>alert(1)' });
  });
});
