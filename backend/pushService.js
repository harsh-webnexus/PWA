import { getMessaging } from 'firebase-admin/messaging';
import { listTokens, removeTokens } from './tokenStore.js';

/**
 * Send a Web Push (via FCM) to one token or every stored device token.
 *
 * IMPORTANT: use a DATA-only message for web closed-app delivery.
 * If a top-level `notification` is present, browsers often only surface it when
 * a client becomes visible again. Data-only always goes to the service worker
 * `onBackgroundMessage` handler, which calls showNotification().
 */
export async function sendPushNotification({
  token,
  title,
  body,
  link = '/',
  data = {},
} = {}) {
  const payloadBase = {
    data: {
      title: String(title || 'New notification'),
      body: String(body || ''),
      url: String(link || '/'),
      ...Object.fromEntries(
        Object.entries(data).map(([key, value]) => [key, String(value ?? '')])
      ),
    },
    webpush: {
      fcmOptions: { link: String(link || '/') },
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
    mode: 'data-only-webpush',
    sent,
    failed,
    total: targets.length,
    delivered: sent.length,
  };
}
