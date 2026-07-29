'use strict';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  // A push event must immediately produce a visible notification. The payload
  // also follows Declarative Web Push so newer Apple devices can display it
  // even before this service worker runs.
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch (_) {
    payload = { notification: { title: 'VoxHF', body: event.data?.text() || 'New message' } };
  }
  const notification = payload.notification || payload;
  const title = String(notification.title || 'VoxHF');
  const navigate = safeAppUrl(notification.navigate);
  event.waitUntil(self.registration.showNotification(title, {
    body: String(notification.body || 'New message'),
    tag: String(notification.tag || 'voxhf-message'),
    silent: notification.silent === true,
    data: { navigate },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = safeAppUrl(event.notification.data?.navigate);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.navigate(target);
      return client.focus();
    }
    return self.clients.openWindow(target);
  })());
});

function safeAppUrl(value) {
  try {
    const url = new URL(String(value || './app.html'), self.location.origin);
    return url.origin === self.location.origin ? url.href : new URL('./app.html', self.location.href).href;
  } catch (_) {
    return new URL('./app.html', self.location.href).href;
  }
}
