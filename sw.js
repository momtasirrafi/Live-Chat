// Service worker — makes the site installable as a home-screen app AND
// handles real Web Push notifications so a message can reach you even when
// the app isn't open (this is the part that lets iPhone notify you from a
// closed/backgrounded home-screen app, iOS 16.4+).
//
// Caching policy, deliberately narrow:
//   /api/*        -> never touched. Messages, signalling and presence are
//                    realtime; a stale reply here would be worse than none.
//   navigations   -> network first, cached shell as the fallback. Opening the
//                    app icon with no signal used to hand you a browser error
//                    page, which is not something an installed app should do.
//   static assets -> cache first (icons, manifest), refreshed in the
//                    background so an update lands on the next launch.
// Anything cross-origin (the Google Fonts stylesheet) is left entirely alone.

const CACHE = 'vanish-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // allSettled, not addAll: addAll rejects the whole install if any single
      // entry 404s, which would leave the app with no service worker at all.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Leave anything we have no business caching to the browser's own handling:
  // non-GET (every message send), cross-origin, and the whole API surface.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      } catch (e) {
        // Chained with await, not `a || b`: caches.match() resolves to
        // undefined on a miss but the *promise* is always truthy, so a `||`
        // chain would stop at the first miss and hand respondWith undefined.
        const hit = (await caches.match(req)) || (await caches.match('/index.html')) || (await caches.match('/'));
        if (hit) return hit;
        return new Response('<!doctype html><meta charset="utf-8"><title>Vanish — offline</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:#0d0a12;color:#9c90ad;font:15px system-ui">You\'re offline.</body>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        // Refresh in the background so a redeploy is picked up next launch
        // without ever making the user wait on the network for an icon.
        fetch(req)
          .then((res) => caches.open(CACHE).then((cache) => cache.put(req, res)))
          .catch(() => {});
        return hit;
      }
      return fetch(req);
    })
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Vanish', body: event.data ? event.data.text() : 'New message' };
  }

  const title = data.title || 'Vanish';
  const isCall = !!data.call;
  const options = {
    body: data.body || 'New message',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'vanish-' + (isCall ? 'call-' : '') + (data.room || 'chat'),
    renotify: true,
    // Calls stay on screen until tapped or the ring window passes, instead
    // of auto-dismissing like a normal message alert.
    requireInteraction: isCall,
    vibrate: isCall ? [300, 150, 300, 150, 300] : [150],
    data: { room: data.room || '', call: isCall }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
