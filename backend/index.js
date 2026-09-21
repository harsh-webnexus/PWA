import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { listTokens, upsertToken, removeToken } from './tokenStore.js';
import { sendPushNotification } from './pushService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const PORT = Number(process.env.FCM_SERVER_PORT || 3001);
const sseClients = new Set();
const isProd = process.env.NODE_ENV === 'production';

function resolveServiceAccountPath() {
  const configured = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(__dirname, configured);
  }
  return path.resolve(__dirname, 'service-account.json');
}

function loadServiceAccount() {
  const jsonInline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (jsonInline) {
    return JSON.parse(jsonInline);
  }

  const accountPath = resolveServiceAccountPath();
  if (!fs.existsSync(accountPath)) {
    throw new Error(
      `Missing Firebase service account. Download it from Firebase Console → Project settings → Service accounts → Generate new private key, save as backend/service-account.json. Expected: ${accountPath}`
    );
  }

  return JSON.parse(fs.readFileSync(accountPath, 'utf8'));
}

function initAdmin() {
  if (getApps().length) return getApps()[0];

  const serviceAccount = loadServiceAccount();
  return initializeApp({
    credential: cert(serviceAccount),
    projectId: serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID,
  });
}

function broadcastNotificationSent(payload) {
  const data = `event: notification-sent\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));

app.get('/api/health', (_req, res) => {
  try {
    initAdmin();
    res.json({
      ok: true,
      messaging: true,
      part: 'backend',
      sseClients: sseClients.size,
      storedTokens: listTokens().length,
      push: 'fcm-web-push',
    });
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message });
  }
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  res.write(': connected\n\n');
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

/**
 * Store an FCM registration token for this browser/PWA install.
 * (FCM is the Web Push transport; no separate web-push VAPID stack.)
 * This demo has no auth — tokens are device-scoped. Add auth before production multi-user use.
 */
app.post('/api/push/subscribe', (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      res.status(400).json({ ok: false, error: 'Missing FCM token.' });
      return;
    }

    const row = upsertToken({
      token,
      userAgent: String(req.body?.userAgent || req.get('user-agent') || ''),
      label: String(req.body?.label || ''),
    });

    res.json({ ok: true, id: row.id, tokenCount: listTokens().length });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.delete('/api/push/unsubscribe', (req, res) => {
  try {
    const token = String(req.body?.token || req.query?.token || '').trim();
    if (!token) {
      res.status(400).json({ ok: false, error: 'Missing FCM token.' });
      return;
    }
    const result = removeToken(token);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/push/subscriptions', (_req, res) => {
  if (isProd) {
    res.status(403).json({ ok: false, error: 'Disabled in production.' });
    return;
  }
  const rows = listTokens().map(({ id, createdAt, updatedAt, label, userAgent }) => ({
    id,
    createdAt,
    updatedAt,
    label,
    userAgent,
  }));
  res.json({ ok: true, count: rows.length, subscriptions: rows });
});

/**
 * Existing notification API used from Postman / the PWA.
 * Sends a real FCM Web Push that wakes the service worker even when the PWA is closed.
 *
 * Body:
 * - token (optional): specific device. If omitted, sends to all stored tokens.
 * - title, body, link
 */
app.post('/api/send-notification', async (req, res) => {
  try {
    initAdmin();

    const token = String(req.body?.token || '').trim();
    const title =
      String(req.body?.title || process.env.FCM_TEST_TITLE || 'Hello from FCM').trim() ||
      'Hello from FCM';
    const body =
      String(req.body?.body || process.env.FCM_TEST_BODY || 'This is a test notification').trim() ||
      'This is a test notification';
    const link = String(req.body?.link || process.env.FCM_TEST_LINK || '/').trim() || '/';

    const pushResult = await sendPushNotification({
      token: token || undefined,
      title,
      body,
      link,
    });

    const result = {
      ok: true,
      title,
      body,
      link,
      receivedAt: new Date().toLocaleTimeString(),
      source: 'api',
      push: pushResult,
      messageId: pushResult.sent[0]?.messageId || null,
      hint:
        'OS toast is delivered by the service worker even when the PWA is closed. Last message only updates if a page is open (SSE).',
    };

    // SSE only updates open UIs — it is NOT the closed-app delivery path.
    broadcastNotificationSent(result);

    res.json(result);
  } catch (error) {
    console.error('[send-notification]', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'Failed to send notification.',
      code: error.code || undefined,
    });
  }
});

/** Dev-only convenience: send to all registered devices without a body token. */
app.post('/api/push/test', async (req, res) => {
  if (isProd) {
    res.status(403).json({ ok: false, error: 'Disabled in production.' });
    return;
  }

  try {
    initAdmin();
    const title = String(req.body?.title || 'Closed-PWA test').trim();
    const body = String(req.body?.body || 'This should appear with the app fully closed.').trim();
    const link = String(req.body?.link || '/').trim() || '/';

    const pushResult = await sendPushNotification({ title, body, link });
    const result = {
      ok: true,
      title,
      body,
      link,
      receivedAt: new Date().toLocaleTimeString(),
      source: 'push-test',
      push: pushResult,
    };
    broadcastNotificationSent(result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

try {
  initAdmin();
  console.log('[backend] Firebase Admin initialized (FCM Web Push)');
  console.log('[backend] Stored FCM tokens:', listTokens().length);
} catch (error) {
  console.warn('[backend] Admin not ready yet:', error.message);
}

app.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`);
});
