import { useEffect, useMemo, useState } from 'react';
import {
  disableNotifications,
  enableNotifications,
  getExistingToken,
  getMissingEnvVars,
  getNotificationPermission,
  getSupportState,
  isLanIpHost,
  listenForForegroundMessages,
  sendTestNotification,
  subscribeBackendSentEvents,
  subscribeFcmUi,
} from './firebase.js';
import './App.css';

function permissionLabel(permission) {
  if (permission === 'granted') return 'Granted';
  if (permission === 'denied') return 'Denied';
  if (permission === 'unsupported') return 'Unsupported';
  return 'Not requested';
}

export default function App() {
  const [permission, setPermission] = useState(getNotificationPermission);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lastMessage, setLastMessage] = useState(null);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [listenerReady, setListenerReady] = useState(false);
  const [support, setSupport] = useState({
    missingEnv: getMissingEnvVars(),
    hasServiceWorker: true,
    hasNotificationApi: true,
    messagingSupported: false,
    iosNeedsInstall: false,
    ready: false,
  });
  const onLanIp = isLanIpHost();
  const localhostUrl = `${window.location.protocol}//localhost:${window.location.port || '5173'}/`;

  useEffect(() => {
    let cancelled = false;

    getSupportState().then(async (state) => {
      if (cancelled) return;
      setSupport({ ...state, ready: true });

      if (!state.missingEnv.length && state.messagingSupported && getNotificationPermission() === 'granted') {
        try {
          const existingToken = await getExistingToken();
          if (!cancelled) setToken(existingToken);
        } catch (err) {
          if (!cancelled) setError(err.message || 'Failed to restore the FCM token.');
        }
      }
    });

    const onInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };

    // Single UI sink for Postman + in-app Send/Test (BroadcastChannel + SW messages).
    const unsubscribeUi = subscribeFcmUi((message) => {
      setLastMessage({
        title: message.title,
        body: message.body,
        receivedAt: message.receivedAt || new Date().toLocaleTimeString(),
      });
    });

    // Backend SSE: updates Last message while the app is open (NOT closed-app delivery).
    const unsubscribeSse = subscribeBackendSentEvents((message) => {
      setLastMessage({
        title: message.title,
        body: message.body,
        receivedAt: message.receivedAt || new Date().toLocaleTimeString(),
      });
    });

    window.addEventListener('beforeinstallprompt', onInstallPrompt);

    return () => {
      cancelled = true;
      unsubscribeUi();
      unsubscribeSse();
      window.removeEventListener('beforeinstallprompt', onInstallPrompt);
    };
  }, []);

  useEffect(() => {
    if (support.missingEnv.length || !support.messagingSupported) return undefined;
    if (permission !== 'granted') return undefined;

    let active = true;
    let unsubscribe = () => {};

    setListenerReady(false);

    (async () => {
      try {
        const unsub = await listenForForegroundMessages(() => {
          // UI is updated via publishFcmToUi → subscribeFcmUi.
        });
        if (!active) {
          unsub?.();
          return;
        }
        unsubscribe = typeof unsub === 'function' ? unsub : () => {};
        setListenerReady(true);
      } catch (err) {
        if (active) {
          setListenerReady(false);
          setError(err.message || 'Could not listen for foreground messages.');
        }
      }
    })();

    return () => {
      active = false;
      setListenerReady(false);
      unsubscribe();
    };
  }, [permission, support.missingEnv.length, support.messagingSupported]);

  const statusTone = useMemo(() => {
    if (!support.ready) return 'neutral';
    if (support.missingEnv.length) return 'warn';
    if (!support.messagingSupported || permission === 'denied' || permission === 'unsupported') {
      return 'danger';
    }
    if (permission === 'granted') return 'ok';
    return 'neutral';
  }, [permission, support]);

  async function handleEnable() {
    setError('');
    setBusy(true);
    try {
      const result = await enableNotifications();
      setPermission(result.permission);
      setToken(result.token);
    } catch (err) {
      if (err.permission) setPermission(err.permission);
      else setPermission(getNotificationPermission());
      setError(err.message || 'Failed to enable notifications.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    setError('');
    setBusy(true);
    try {
      await disableNotifications(token);
      setToken('');
      setLastMessage(null);
    } catch (err) {
      setError(err.message || 'Failed to disable notifications.');
    } finally {
      setBusy(false);
    }
  }

  async function handleTest() {
    setError('');
    setBusy(true);
    try {
      // Backend SSE + FCM both update Last message; no local-only shortcut needed.
      await sendTestNotification(token);
    } catch (err) {
      setError(err.message || 'Failed to send a test notification.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function handleInstall() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    setInstallPrompt(null);
  }

  const blockedByEnv = support.missingEnv.length > 0;
  const canEnable = !blockedByEnv && support.messagingSupported && permission !== 'denied';
  const canTest = permission === 'granted' && Boolean(token);

  return (
    <main className="page">
      <section className="card">
        <p className="eyebrow">Firebase Cloud Messaging</p>
        <h1>Push notifications PWA</h1>
        <p className="lede">
          Enable notifications once, then fully close the PWA and send from Postman. Delivery uses
          FCM Web Push through the service worker — not polling. After this fix, click{' '}
          <strong>Disable</strong> then <strong>Enable</strong> once so service worker v4 takes over.{' '}
          <strong>Last message</strong> only updates while this page is open (SSE); the OS toast must
          appear while the app stays closed.
        </p>

        <div className={`status status-${statusTone}`}>
          <span className="status-dot" />
          <div>
            <strong>Permission:</strong> {permissionLabel(permission)}
            {token ? <span className="status-extra">Token ready</span> : null}
            {permission === 'granted' ? (
              <span className="status-extra">{listenerReady ? 'Listening' : 'Connecting…'}</span>
            ) : null}
          </div>
        </div>

        {blockedByEnv ? (
          <div className="banner banner-warn" role="alert">
            Missing environment variables: {support.missingEnv.join(', ')}. Add them in
            {' '}<code>frontend/.env</code> (see <code>frontend/.env.example</code>) and restart.
          </div>
        ) : null}

        {support.ready && (!support.hasServiceWorker || !support.hasNotificationApi) ? (
          <div className="banner banner-danger" role="alert">
            This browser does not support service workers or the Notifications API. Use Chrome,
            Edge, or Firefox over HTTPS (or localhost).
          </div>
        ) : null}

        {support.ready && !blockedByEnv && support.hasServiceWorker && support.hasNotificationApi && !support.messagingSupported ? (
          <div className="banner banner-danger" role="alert">
            Firebase Cloud Messaging is not supported in this browser.
          </div>
        ) : null}

        {support.iosNeedsInstall ? (
          <div className="banner banner-warn">
            On iOS, install this app to the Home Screen first, then enable notifications from the
            installed PWA.
          </div>
        ) : null}

        {onLanIp ? (
          <div className="banner banner-warn" role="status">
            LAN IP ({window.location.host}) is not a secure context over HTTP, so notifications may
            fail. On this PC use <a href={localhostUrl}>{localhostUrl}</a> in a normal Chrome window
            (not Incognito). For phone/LAN testing, set Chrome flag
            chrome://flags/#unsafely-treat-insecure-origin-as-secure to this origin and relaunch.
          </div>
        ) : null}

        {permission === 'denied' ? (
          <div className="banner banner-danger" role="alert">
            Notifications are blocked for this site. Click the site controls icon left of the URL →
            Notifications → <strong>Allow</strong>, then reload. Prefer a normal window (not
            Incognito).
          </div>
        ) : null}

        {error ? (
          <div className="banner banner-danger" role="alert">
            {error}
          </div>
        ) : null}

        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={handleEnable} disabled={busy || !canEnable}>
            {busy && canEnable ? 'Working…' : permission === 'granted' && token ? 'Notifications Enabled' : 'Enable Notifications'}
          </button>
          {permission === 'granted' && token ? (
            <button type="button" className="btn btn-ghost" onClick={handleDisable} disabled={busy}>
              Disable Notifications
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary" onClick={handleTest} disabled={busy || !canTest}>
            Send/Test Notification
          </button>
          {installPrompt ? (
            <button type="button" className="btn btn-ghost" onClick={handleInstall}>
              Install app
            </button>
          ) : null}
        </div>

        <div className="token-block">
          <div className="token-header">
            <h2>FCM device token</h2>
            <button type="button" className="btn btn-tiny" onClick={handleCopy} disabled={!token}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="token">{token || 'No token yet. Click Enable Notifications.'}</pre>
        </div>

        <div className="message-block">
          <h2>Last message</h2>
          {lastMessage ? (
            <div>
              <p className="message-title">{lastMessage.title}</p>
              <p>{lastMessage.body}</p>
              <p className="message-meta">{lastMessage.receivedAt}</p>
            </div>
          ) : (
            <p className="muted">
              Real FCM deliveries appear here (Postman or Send/Test). Keep this tab open and
              Listening.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
