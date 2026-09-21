import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIREBASE_COMPAT_VERSION = '11.10.0';
const SW_CACHE = 'fcm-pwa-v4';
const SW_VERSION = 'v4-closed-push';

function buildFirebaseMessagingSw(env) {
  const firebaseConfig = {
    apiKey: env.VITE_FIREBASE_API_KEY || '',
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || '',
    projectId: env.VITE_FIREBASE_PROJECT_ID || '',
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
    appId: env.VITE_FIREBASE_APP_ID || '',
  };

  // Build as plain string concat — nested template literals break Vite's config parse.
  return [
    '/* Generated from VITE_FIREBASE_* environment variables. Do not hardcode secrets here. */',
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
    `const firebaseConfig = ${JSON.stringify(firebaseConfig)};`,
    'const hasConfig = Object.values(firebaseConfig).every(Boolean);',
    '',
    'if (!hasConfig) {',
    "  console.error('[firebase-messaging-sw.js] Missing Firebase config. Set VITE_FIREBASE_* in .env and restart.');",
    '} else {',
    `  importScripts('https://www.gstatic.com/firebasejs/${FIREBASE_COMPAT_VERSION}/firebase-app-compat.js');`,
    `  importScripts('https://www.gstatic.com/firebasejs/${FIREBASE_COMPAT_VERSION}/firebase-messaging-compat.js');`,
    '',
    '  firebase.initializeApp(firebaseConfig);',
    '  const messaging = firebase.messaging();',
    '',
    '  // Data-only FCM always hits this handler, even with the PWA fully closed.',
    '  messaging.onBackgroundMessage((payload) => {',
    "    console.log('[SW] Push event received (FCM background)', SW_VERSION, payload);",
    '',
    "    const title = (payload.notification && payload.notification.title) || (payload.data && payload.data.title) || 'New notification';",
    "    const body = (payload.notification && payload.notification.body) || (payload.data && payload.data.body) || '';",
    "    const url = (payload.fcmOptions && payload.fcmOptions.link) || (payload.data && payload.data.url) || '/';",
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
    '    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {',
    '      for (var i = 0; i < clientList.length; i++) {',
    "        clientList[i].postMessage({ type: 'FCM_MESSAGE', payload: payload });",
    '      }',
    '    });',
    '',
    '    var options = {',
    '      body: body,',
    "      icon: '/icons/icon-192.png',",
    "      badge: '/icons/icon-192.png',",
    '      renotify: true,',
    "      tag: 'fcm-' + Date.now(),",
    '      requireInteraction: false,',
    '      data: Object.assign({ url: url }, payload.data || {}),',
    '    };',
    '',
    "    console.log('[SW] Notification displayed (closed/background path)', title);",
    '    // Returning this Promise keeps the SW alive until the OS toast is shown.',
    '    return self.registration.showNotification(title, options);',
    '  });',
    '}',
    '',
  ].join('\n');
}

function firebaseMessagingSwPlugin(env) {
  const serveSw = (req, res, next) => {
    const url = req.url?.split('?')[0];
    if (url !== '/firebase-messaging-sw.js') {
      next();
      return;
    }

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.end(buildFirebaseMessagingSw(env));
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
        source: buildFirebaseMessagingSw(env),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, 'VITE_');

  return {
    plugins: [react(), firebaseMessagingSwPlugin(env)],
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
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
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  };
});
