import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderShell, escapeJsonForScriptTag } from '../src/dashboard/render/shell.js';

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

describe('renderShell mascot', () => {
  test('when mascotJson omitted, no mascot pre/script appears', () => {
    const html = renderShell({ title: 'T', days: 7 }, '<div>body</div>');
    assert.equal(html.includes('id="mascot"'), false);
    assert.equal(html.includes('id="mascot-frames"'), false);
  });

  test('when mascotJson provided, both pre and script appear', () => {
    const html = renderShell({ title: 'T', days: 7, mascotJson: '{"frames":[]}' }, '<div>body</div>');
    assert.match(html, /<pre id="mascot"[^>]*><\/pre>/);
    assert.match(html, /<script type="application\/json" id="mascot-frames">\{"frames":\[\]\}<\/script>/);
  });

  test('mascotJson is HTML-escaped to prevent </script> breakout', () => {
    const evil = '"</script><script>alert(1)</script>';
    const html = renderShell({ title: 'T', days: 7, mascotJson: evil }, '');
    // The literal "</script>" must NOT appear inside the JSON block.
    // Verify by counting closing script tags: the JSON block's content
    // should be escaped so the only </script> tags are the legitimate
    // closers for the dashboard's own script tags.
    assert.equal(html.includes('"</script><script>alert(1)</script>"'), false);
  });
});

describe('escapeJsonForScriptTag', () => {
  test('escapes </script> and its uppercase variants so no closing tag leaks out', () => {
    // All variants must not produce a literal </script in the output
    const lower = escapeJsonForScriptTag('</script>');
    assert.equal(lower.includes('</script'), false);
    const upper = escapeJsonForScriptTag('</SCRIPT>');
    assert.equal(upper.includes('</SCRIPT'), false);
    const mixed = escapeJsonForScriptTag('</Script>');
    assert.equal(mixed.includes('</Script'), false);
  });

  test('leaves safe JSON unchanged', () => {
    const safe = '{"frames":[{"bend":{"dx":0,"dy":0},"grid":[]}]}';
    assert.equal(escapeJsonForScriptTag(safe), safe);
  });
});
