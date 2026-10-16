/* Offline shell for sCure Org Key: everything it needs is cached on first load, so the app opens with no signal
 * (a phone at the bench). Bump CACHE when any file changes so phones pick up the new version. */
'use strict';

const CACHE = 'scure-org-key-v2';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // cache first, then the network (and keep what the network gave); the page itself falls back to the cached shell
  event.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      if (res.ok) caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    })).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error())));
});
