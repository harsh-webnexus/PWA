import { getMessaging } from 'firebase-admin/messaging';
import { listTokens, removeTokens } from './tokenStore.js';

/**
 * Send a Web Push (via FCM) to one token or every stored device token.
 *
 * Sends both data + webpush.notification so Android can surface the toast
 * after Chrome is killed from RAM (native SW push listener + notification payload).
 */
export async function sendPushNotification({
  token,
  title,
  body,
  link = '/',
  data = {},
} = {}) {
  const safeTitle = String(title || 'New notification');
  const safeBody = String(body || '');
  const safeLink = String(link || '/');

  const payloadBase = {
    data: {
      title: safeTitle,
      body: safeBody,
      url: safeLink,
      ...Object.fromEntries(
        Object.entries(data).map(([key, value]) => [key, String(value ?? '')])
      ),
    },
    webpush: {
      notification: {
        title: safeTitle,
        body: safeBody,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
      },
      fcmOptions: { link: safeLink },
      headers: {
        Urgency: 'high',
        TTL: '86400',
      },
    },
  };

  const targets = token
    ? [{ token }]
    : listTokens().map((row) => ({ token: row.token }));

  console.log('[push] Push subscriptions/tokens found:', targets.length);

  if (!targets.length) {
    throw new Error('No FCM tokens available. Enable notifications in the PWA first.');
  }

  const results = await Promise.allSettled(
    targets.map(async ({ token: deviceToken }) => {
      try {
        const messageId = await getMessaging().send({
          token: deviceToken,
          ...payloadBase,
        });
        console.log('[push] Push sent successfully', messageId);
        return { token: `${deviceToken.slice(0, 12)}…`, messageId, ok: true };
      } catch (error) {
        const code = error?.code || '';
        const status = String(error?.errorInfo?.code || code);
        console.error('[push] Push failed', status || error.message);

        if (
          status.includes('registration-token-not-registered') ||
          status.includes('invalid-registration-token') ||
          status.includes('messaging/invalid-argument')
        ) {
          removeTokens([deviceToken]);
          console.log('[push] Expired/invalid subscription removed');
        }

        throw error;
      }
    })
  );

  const sent = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const failed = results
    .filter((r) => r.status === 'rejected')
    .map((r) => r.reason?.message || String(r.reason));

  return {
    mode: 'webpush-notification-and-data',
    sent,
    failed,
    total: targets.length,
    delivered: sent.length,
  };
}
