self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let d = { title: 'F1 Alarm', body: '' };
  try { d = event.data.json(); } catch { d.body = event.data?.text() || ''; }
  event.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: '/icon.png',
    badge: '/icon.png',
    tag: d.title,
    renotify: true,
    requireInteraction: d.priority >= 5,
    vibrate: d.priority >= 5 ? [300, 120, 300, 120, 300] : [200, 100, 200]
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return clients.openWindow('/');
  }));
});
