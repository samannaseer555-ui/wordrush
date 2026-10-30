// Minimal service worker. It lets the phone treat WordRush as an installable app.
// It caches nothing, so players always get the latest files from GitHub Pages.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () {});
