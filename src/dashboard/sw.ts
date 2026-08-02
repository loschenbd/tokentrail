import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pkgRoot } from '../lib/pkg-root.js';

// Read the app version from package.json via the shared pkgRoot() walk-up
// (works in dev and from the installed dist/ layout). Falls back to '0.0.0'
// rather than throwing — a service worker should still generate.
function appVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(pkgRoot(), 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

// Cache-first for /static/* only; everything else (HTML pages, /api/*) is
// network-only so live spend figures are never served stale.
export function serviceWorkerJs(): string {
  const cache = `tt-static-v${appVersion()}`;
  return `const CACHE = ${JSON.stringify(cache)};
const PRECACHE = [
  '/static/dashboard.css', '/static/dashboard.js',
  '/static/uPlot.iife.min.js', '/static/uPlot.min.css',
  '/static/fonts.css', '/static/logo.png',
  '/static/icon-192.png', '/static/icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !url.pathname.startsWith('/static/')) return; // network-only
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (!res.ok) return res;
      const copy = res.clone();
      e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy)));
      return res;
    }))
  );
});
`;
}
