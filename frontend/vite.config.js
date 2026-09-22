import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SW_CACHE = 'fcm-pwa-v5';
const SW_VERSION = 'v5-native-push';

function buildFirebaseMessagingSw() {
  // Native push listener — no Firebase CDN importScripts (reliable after Android kills Chrome).
  return [
    '/* Generated service worker: native Web Push (no Firebase CDN). */',
    "'use strict';",
    '',
    "self.addEventListener('notificationclick', (event) => {",
    "  console.log('[SW] Notification clicked');",
    '  event.notification.close();',
    "  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href;",
    '',
    '  event.waitUntil((async () => {',
    '    const clientList = await self.clients.matchAll({',
    "      type: 'window',",
    '      includeUncontrolled: true,',
    '    });',
    '',
    '    for (const client of clientList) {',
    "      if (client.url.startsWith(self.location.origin) && 'focus' in client) {",
    "        if ('navigate' in client) {",
    '          try {',
    '            await client.navigate(targetUrl);',
    '          } catch {',
    '            /* ignore */',
    '          }',
    '        }',
    '        await client.focus();',
    '        return;',
    '      }',
    '    }',
    '',
    '    if (self.clients.openWindow) {',
    '      await self.clients.openWindow(targetUrl);',
    '    }',
    '  })());',
    '});',
    '',
    `const CACHE_NAME = '${SW_CACHE}';`,
    "const PRECACHE_URLS = ['/', '/index.html', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];",
    `const SW_VERSION = '${SW_VERSION}';`,
    '',
    "self.addEventListener('install', (event) => {",
    "  console.log('[SW] install', SW_VERSION);",
    '  event.waitUntil(',
    '    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())',
    '  );',
    '});',
    '',
    "self.addEventListener('activate', (event) => {",
    "  console.log('[SW] activate', SW_VERSION);",
    '  event.waitUntil(',
    '    caches.keys().then((keys) =>',
    '      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))',
    '    ).then(() => self.clients.claim())',
    '  );',
    '});',
    '',
    "self.addEventListener('message', (event) => {",
    "  if (event.data && event.data.type === 'SKIP_WAITING') {",
    '    self.skipWaiting();',
    '  }',
    '});',
    '',
    "self.addEventListener('fetch', (event) => {",
    "  if (event.request.method !== 'GET') return;",
    '',
    '  const url = new URL(event.request.url);',
    '  if (url.origin !== self.location.origin) return;',
    '',
    '  event.respondWith(',
    '    fetch(event.request)',
    '      .then((response) => {',
    '        const shouldCache =',
    "          event.request.mode === 'navigate' || PRECACHE_URLS.includes(url.pathname);",
    '        if (shouldCache && response.ok) {',
    '          const copy = response.clone();',
    '          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));',
    '        }',
    '        return response;',
    '      })',
    "      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/index.html')))",
    '  );',
    '});',
    '',
    "self.addEventListener('push', (event) => {",
    "  console.log('[SW] Push event received', SW_VERSION);",
    '  event.waitUntil((async () => {',
    '    let payload = {};',
    '    try {',
    "      if (event.data) {",
    '        payload = event.data.json();',
    '      }',
    '    } catch (error) {',
    "      console.warn('[SW] Failed to parse push JSON', error);",
    '      try {',
    "        payload = { data: { body: event.data ? event.data.text() : '' } };",
    '      } catch {',
    '        payload = {};',
    '      }',
    '    }',
    '',
    '    const notification = payload.notification || {};',
    '    const data = payload.data || {};',
    "    const title = notification.title || data.title || 'New notification';",
    "    const body = notification.body || data.body || '';",
    "    const url = (payload.fcmOptions && payload.fcmOptions.link) || data.url || '/';",
    '',
    '    const uiMessage = { title: title, body: body, receivedAt: new Date().toLocaleTimeString() };',
    '',
    '    try {',
    "      const channel = new BroadcastChannel('fcm-ui');",
    '      channel.postMessage(uiMessage);',
    '      channel.close();',
    '    } catch (error) {',
    "      console.warn('[SW] BroadcastChannel failed', error);",
    '    }',
    '',
    '    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });',
    '    for (var i = 0; i < clientList.length; i++) {',
    "      clientList[i].postMessage({ type: 'FCM_MESSAGE', payload: payload });",
    '    }',
    '',
    '    var options = {',
    '      body: body,',
    "      icon: notification.icon || '/icons/icon-192.png',",
    "      badge: notification.badge || '/icons/icon-192.png',",
    '      renotify: true,',
    "      tag: 'fcm-' + Date.now(),",
    '      requireInteraction: false,',
    '      data: Object.assign({ url: url }, data),',
    '    };',
    '',
    "    console.log('[SW] Notification displayed (native push path)', title);",
    '    await self.registration.showNotification(title, options);',
    '  })());',
    '});',
    '',
    "self.addEventListener('pushsubscriptionchange', (event) => {",
    "  console.log('[SW] pushsubscriptionchange', SW_VERSION, event);",
    '});',
    '',
  ].join('\n');
}

function firebaseMessagingSwPlugin() {
  const serveSw = (req, res, next) => {
    const url = req.url?.split('?')[0];
    if (url !== '/firebase-messaging-sw.js') {
      next();
      return;
    }

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.end(buildFirebaseMessagingSw());
  };

  return {
    name: 'firebase-messaging-sw',
    configureServer(server) {
      server.middlewares.use(serveSw);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveSw);
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'firebase-messaging-sw.js',
        source: buildFirebaseMessagingSw(),
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), firebaseMessagingSwPlugin()],
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      allowedHosts: [
         'push.kartify.info',
      ],
      proxy: {
        '/api': {
          target: 'https://backend.kartify.info',
          changeOrigin: true,
        },
      },
    },
    preview: {
      host: true,
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'https://backend.kartify.info',
          changeOrigin: true,
        },
      },
    },
  };
});
