// Service worker — makes the site installable as a home-screen app AND
// handles real Web Push notifications so a message can reach you even when
// the app isn't open (this is the part that lets iPhone notify you from a
// closed/backgrounded home-screen app, iOS 16.4+).

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Always go to the network — never cache /api/* or the page itself,
  // so messages/calls stay real-time.
  event.respondWith(fetch(event.request));
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Vanish', body: event.data ? event.data.text() : 'New message' };
  }

  const title = data.title || 'Vanish';
  const options = {
    body: data.body || 'New message',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'vanish-' + (data.room || 'chat'),
    renotify: true,
    data: { room: data.room || '' }
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
