// Minimal service worker — exists mainly so the browser considers this
// site "installable" as a home-screen app. It doesn't cache chat data or
// API calls (those must always be live), it just passes requests through.

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
