import { initializeApp } from 'firebase/app';
import { getMessaging, getToken, onMessage, isSupported } from 'firebase/messaging';

const REQUIRED_ENV = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
  'VITE_FIREBASE_VAPID_KEY',
];

const FCM_UI_CHANNEL = 'fcm-ui';

let firebaseApp;
let unsubscribeOnMessage;

export function getMissingEnvVars() {
  return REQUIRED_ENV.filter((key) => !String(import.meta.env[key] || '').trim());
}

export function getFirebaseConfig() {
  return {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  };
}

export function getNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function isStandaloneDisplay() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

export function isLanIpHost() {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(window.location.hostname);
}

export function normalizeFcmPayload(payload = {}) {
  return {
    title: payload.notification?.title || payload.data?.title || payload.title || 'New notification',
    body: payload.notification?.body || payload.data?.body || payload.body || '',
    receivedAt: new Date().toLocaleTimeString(),
    raw: payload,
  };
}

/** Publish to every open app tab (Postman + in-app button share this UI path). */
export function publishFcmToUi(payload) {
  const message = normalizeFcmPayload(payload);
  try {
    const channel = new BroadcastChannel(FCM_UI_CHANNEL);
    channel.postMessage(message);
    channel.close();
  } catch (error) {
    console.warn('[FCM] BroadcastChannel publish failed', error);
  }
  return message;
}

/** Subscribe Last message UI to FCM from page listener and service worker. */
export function subscribeFcmUi(onMessageUi) {
  const channel = new BroadcastChannel(FCM_UI_CHANNEL);
  const onChannel = (event) => {
    if (event?.data) onMessageUi(event.data);
  };
  channel.addEventListener('message', onChannel);

  const onSwMessage = (event) => {
    if (event.data?.type !== 'FCM_MESSAGE') return;
    onMessageUi(normalizeFcmPayload(event.data.payload || {}));
  };
  navigator.serviceWorker?.addEventListener('message', onSwMessage);

  return () => {
    channel.removeEventListener('message', onChannel);
    channel.close();
    navigator.serviceWorker?.removeEventListener('message', onSwMessage);
  };
}

export async function getSupportState() {
  const missingEnv = getMissingEnvVars();
  const hasServiceWorker = 'serviceWorker' in navigator;
  const hasNotificationApi = 'Notification' in window;
  let messagingSupported = false;

  if (hasServiceWorker && hasNotificationApi) {
    try {
      messagingSupported = await isSupported();
    } catch {
      messagingSupported = false;
    }
  }

  return {
    missingEnv,
    hasServiceWorker,
    hasNotificationApi,
    messagingSupported,
    iosNeedsInstall: isIosDevice() && !isStandaloneDisplay(),
  };
}

export async function registerMessagingServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service workers are not supported in this browser.');
  }

  try {
    // Drop stale SW copies from earlier ?v= experiments so push always hits v4.
    const existing = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      existing.map(async (reg) => {
        const script = reg.active?.scriptURL || reg.installing?.scriptURL || reg.waiting?.scriptURL || '';
        if (script.includes('firebase-messaging-sw.js') && !script.includes('v=4')) {
          console.log('[FCM] Unregistering stale SW', script);
          await reg.unregister();
        }
      })
    );

    const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js?v=4', {
      scope: '/',
      updateViaCache: 'none',
    });
    if (registration.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
    await registration.update().catch(() => undefined);

    // Wait until the controlling SW is the active one (needed for closed-app push).
    if (navigator.serviceWorker.controller) {
      await navigator.serviceWorker.ready;
    } else {
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
        }),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }

    console.log('[FCM] Service worker ready', registration.active?.scriptURL);
    return registration;
  } catch (error) {
    const message = String(error?.message || error);
    if (!window.isSecureContext || /SSL|certificate|secure/i.test(message)) {
      throw new Error(
        `Service workers need a secure context. Use http://localhost:5173 on this PC. For http://${window.location.hostname}:5173, enable Chrome flag "Insecure origins treated as secure" for that origin, then relaunch Chrome.`
      );
    }
    throw error;
  }
}

async function getMessagingInstance() {
  const missing = getMissingEnvVars();
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }

  const supported = await isSupported();
  if (!supported) {
    throw new Error('This browser does not support Firebase Cloud Messaging.');
  }

  if (!firebaseApp) {
    firebaseApp = initializeApp(getFirebaseConfig());
  }

  return getMessaging(firebaseApp);
}

async function createDeviceToken() {
  const messaging = await getMessagingInstance();
  const registration = await registerMessagingServiceWorker();
  const token = await getToken(messaging, {
    vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY,
    serviceWorkerRegistration: registration,
  });

  if (!token) {
    throw new Error('No FCM token was returned. Grant permission and try again.');
  }

  return token;
}

export async function enableNotifications() {
  if (!('Notification' in window)) {
    throw new Error('Notifications are not supported in this browser.');
  }

  console.log('[FCM] Requesting notification permission…');
  const permission = await Notification.requestPermission();
  console.log('[FCM] Notification permission:', permission);

  if (permission !== 'granted') {
    const error = new Error(
      permission === 'denied'
        ? 'Notifications are blocked. Enable them in your browser site settings, then try again.'
        : 'Notification permission was not granted.'
    );
    error.permission = permission;
    throw error;
  }

  console.log('[FCM] Service worker registering…');
  const token = await createDeviceToken();
  console.log('[FCM] New/existing FCM registration token ready');

  try {
    const response = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        userAgent: navigator.userAgent,
        label: window.matchMedia('(display-mode: standalone)').matches ? 'pwa' : 'browser',
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'Failed to save subscription to backend.');
    }
    console.log('[FCM] Subscription saved to backend. Devices:', payload.tokenCount);
  } catch (error) {
    console.warn('[FCM] Could not persist token to backend:', error.message);
  }

  return { token, permission };
}

export async function disableNotifications(token) {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await subscription.unsubscribe();
    console.log('[FCM] Browser push subscription unsubscribed');
  }

  if (token) {
    await fetch('/api/push/unsubscribe', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }).catch(() => undefined);
    console.log('[FCM] Token removed from backend (if present)');
  }

  return true;
}

export async function getExistingToken() {
  if (getNotificationPermission() !== 'granted') return '';
  const token = await createDeviceToken();
  // Keep backend device registry in sync when the page reloads.
  fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      userAgent: navigator.userAgent,
      label: window.matchMedia('(display-mode: standalone)').matches ? 'pwa' : 'browser',
    }),
  }).catch(() => undefined);
  return token;
}

export async function getPushSubscriptionState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { supported: false, subscription: null };
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  console.log(
    subscription ? '[FCM] Existing push subscription found' : '[FCM] No existing push subscription'
  );
  return { supported: true, subscription };
}

async function showBrowserNotification(payload) {
  const message = normalizeFcmPayload(payload);
  const options = {
    body: message.body,
    icon: payload.notification?.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: {
      url: payload.fcmOptions?.link || payload.data?.url || '/',
      ...(payload.data || {}),
    },
  };

  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(message.title, options);
  } catch (error) {
    console.warn('[FCM] showNotification via SW failed, falling back', error);
    if (Notification.permission === 'granted') {
      new Notification(message.title, options);
    }
  }
}

export async function listenForForegroundMessages(onPayload) {
  if (unsubscribeOnMessage) {
    unsubscribeOnMessage();
    unsubscribeOnMessage = undefined;
  }

  await registerMessagingServiceWorker();
  const messaging = await getMessagingInstance();

  unsubscribeOnMessage = onMessage(messaging, async (payload) => {
    console.log('[FCM] foreground message', payload);
    const uiMessage = publishFcmToUi(payload);
    onPayload?.(uiMessage);
    await showBrowserNotification(payload);
  });

  return unsubscribeOnMessage;
}

export async function sendTestNotification(token, overrides = {}) {
  if (getNotificationPermission() !== 'granted') {
    throw new Error('Enable notifications before sending a test.');
  }

  if (!token) {
    throw new Error('No FCM token available. Click Enable Notifications first.');
  }

  const title = overrides.title || 'Hello from FCM';
  const body = overrides.body || 'This is a test notification';

  const response = await fetch('/api/send-notification', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      title,
      body,
      link: '/',
    }),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok || !payload.ok) {
    throw new Error(
      payload.error ||
        `Backend send failed (${response.status}). Put service-account.json in backend/ and run npm run dev.`
    );
  }

  return payload;
}

/**
 * Subscribe to backend SSE so Postman (and any API client) updates Last message
 * as soon as /api/send-notification succeeds.
 */
export function subscribeBackendSentEvents(onSent) {
  const url = import.meta.env.DEV ? 'http://localhost:3001/api/events' : '/api/events';
  const source = new EventSource(url);

  const handleSent = (event) => {
    try {
      const data = JSON.parse(event.data);
      onSent?.({
        title: data.title || 'New notification',
        body: data.body || '',
        receivedAt: data.receivedAt || new Date().toLocaleTimeString(),
        source: data.source || 'api',
      });
    } catch (error) {
      console.warn('[FCM] bad SSE payload', error);
    }
  };

  source.addEventListener('notification-sent', handleSent);
  source.onerror = () => {
    // Browser will retry EventSource automatically.
  };

  return () => {
    source.removeEventListener('notification-sent', handleSent);
    source.close();
  };
}
