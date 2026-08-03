'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORE_VERSION = 1;
const MAX_SUBSCRIPTIONS = 32;
const RECENT_MESSAGE_TTL_MS = 30_000;
const WATCHDOG_TICKET_LIFETIME_MS = 15 * 60 * 1000;
const VAPID_SUBJECT = 'https://github.com/leledeste/voxhf';

function createPushNotifications(options = {}) {
  // Web Push credentials and device subscriptions belong to the local proxy.
  // The optional offline watchdog gives the relay only a short-lived request
  // that is already encrypted and signed; the relay never receives these keys.
  const webPush = options.webPush || require('web-push');
  const logger = options.logger || console;
  const now = options.now || Date.now;
  const storageFile = options.storageFile || path.join(process.cwd(), '.voxhf-local', 'notifications.json');
  const recentMessages = new Map();
  let store = loadStore(storageFile, logger);

  if (!validVapid(store.vapid)) {
    store.vapid = webPush.generateVAPIDKeys();
    persistStore(storageFile, store);
  }
  webPush.setVapidDetails(VAPID_SUBJECT, store.vapid.publicKey, store.vapid.privateKey);

  function getPublicState() {
    return {
      kind: 'notification_state',
      available: true,
      vapidPublicKey: store.vapid.publicKey,
      subscriptionCount: store.subscriptions.length,
    };
  }

  function addSubscription(value) {
    const subscription = normalizeSubscription(value);
    if (!subscription) return { ok: false, error: 'Invalid push subscription' };

    // A browser installation owns one current endpoint. Re-subscribing the
    // same device replaces stale endpoints while preserving other devices.
    store.subscriptions = store.subscriptions.filter((item) => (
      item.endpoint !== subscription.endpoint
      && (!subscription.deviceId || item.deviceId !== subscription.deviceId)
    ));
    store.subscriptions.push({
      ...subscription,
      createdAt: new Date(now()).toISOString(),
    });
    if (store.subscriptions.length > MAX_SUBSCRIPTIONS) {
      store.subscriptions = store.subscriptions.slice(-MAX_SUBSCRIPTIONS);
    }
    persistStore(storageFile, store);
    return { ok: true, subscriptionCount: store.subscriptions.length };
  }

  function removeSubscription(endpoint) {
    const value = String(endpoint || '').trim();
    const before = store.subscriptions.length;
    store.subscriptions = store.subscriptions.filter((item) => item.endpoint !== value);
    if (store.subscriptions.length !== before) persistStore(storageFile, store);
    return { ok: true, removed: before - store.subscriptions.length, subscriptionCount: store.subscriptions.length };
  }

  async function notifyForMessage(message, callsign, deliveryOptions = {}) {
    const trigger = notificationTrigger(message, callsign);
    if (!trigger || !store.subscriptions.length) return { matched: Boolean(trigger), sent: 0 };
    if (deliveryOptions.suppressStartupServer === true && isIvaoServerMessage(message)) {
      return { matched: true, sent: 0, suppressed: 'ivao-startup-server' };
    }

    cleanupRecentMessages(recentMessages, now());
    const signature = messageSignature(trigger, message, callsign);
    if (recentMessages.has(signature)) return { matched: true, sent: 0, duplicate: true };
    recentMessages.set(signature, now());

    const delivery = await deliverNotifications(
      subscription => notificationPayload(trigger, message, callsign, subscription.appUrl),
      300,
    );
    return { matched: true, ...delivery };
  }

  async function notifyIvaoDisconnected(callsign) {
    return deliverNotifications(
      subscription => ivaoDisconnectPayload(callsign, subscription.appUrl),
      30 * 60,
    );
  }

  async function notifyIvaoConnected(callsign) {
    return deliverNotifications(
      subscription => ivaoConnectedPayload(callsign, subscription.appUrl),
      300,
      subscription => subscription.notifyIvaoConnected === true,
    );
  }

  async function notifyUnicomTimerExpired(callsign) {
    return deliverNotifications(
      subscription => unicomTimerPayload(callsign, subscription.appUrl),
      300,
    );
  }

  function createAgentOfflineWatchdogTickets(callsign) {
    const expiresAtMs = Number(now()) + WATCHDOG_TICKET_LIFETIME_MS;
    const expiresAt = new Date(expiresAtMs).toISOString();
    return store.subscriptions
      .filter(subscription => subscription.notifyAgentOffline === true)
      .map((subscription) => {
        try {
          const details = webPush.generateRequestDetails(
            pushSubscription(subscription),
            JSON.stringify(agentOfflinePayload(callsign, subscription.appUrl)),
            { TTL: 300, urgency: 'high' },
          );
          const body = Buffer.isBuffer(details.body) ? details.body : Buffer.from(details.body || '');
          const contentEncoding = String(details.headers?.['Content-Encoding'] || '').toLowerCase();
          const vapidHeaders = webPush.getVapidHeaders(
            new URL(details.endpoint).origin,
            VAPID_SUBJECT,
            store.vapid.publicKey,
            store.vapid.privateKey,
            contentEncoding,
            Math.floor(expiresAtMs / 1000),
          );
          const authorization = String(vapidHeaders.Authorization || '');
          if (!body.length || !authorization || contentEncoding !== 'aes128gcm') return null;
          return {
            deviceId: subscription.deviceId,
            endpoint: details.endpoint,
            expiresAt,
            authorization,
            contentEncoding,
            body: body.toString('base64url'),
          };
        } catch (_) {
          logger.warn('[WATCHDOG] Could not prepare an offline alert ticket for one subscribed device.');
          return null;
        }
      })
      .filter(Boolean);
  }

  async function deliverNotifications(makePayload, ttlSeconds, includeSubscription = () => true) {
    if (!store.subscriptions.length) {
      return { sent: 0, failed: 0, expired: 0, subscriptionCount: 0, targetCount: 0 };
    }

    const targets = store.subscriptions.filter(includeSubscription);
    if (!targets.length) {
      return {
        sent: 0,
        failed: 0,
        expired: 0,
        subscriptionCount: store.subscriptions.length,
        targetCount: 0,
      };
    }

    const expired = new Set();
    let sent = 0;
    let failed = 0;
    await Promise.all(targets.map(async (subscription) => {
      const payload = JSON.stringify(makePayload(subscription));
      try {
        await webPush.sendNotification(pushSubscription(subscription), payload, {
          TTL: ttlSeconds,
          urgency: 'high',
        });
        sent += 1;
      } catch (err) {
        const status = Number(err?.statusCode) || 0;
        if (status === 404 || status === 410) {
          expired.add(subscription.endpoint);
          return;
        }
        failed += 1;
        logger.warn(`[PUSH] Delivery failed${status ? ` (HTTP ${status})` : ''}.`);
      }
    }));

    if (expired.size) {
      store.subscriptions = store.subscriptions.filter((item) => !expired.has(item.endpoint));
      persistStore(storageFile, store);
    }
    if (sent) logger.log(`[PUSH] Notification delivered to ${sent} device${sent === 1 ? '' : 's'}.`);
    return {
      sent,
      failed,
      expired: expired.size,
      subscriptionCount: store.subscriptions.length,
      targetCount: targets.length,
    };
  }

  return {
    addSubscription,
    createAgentOfflineWatchdogTickets,
    getPublicState,
    notifyIvaoConnected,
    notifyIvaoDisconnected,
    notifyForMessage,
    notifyUnicomTimerExpired,
    removeSubscription,
  };
}

function notificationTrigger(message, callsign) {
  if (!message || message.kind !== 'message') return '';
  const own = normalizeCallsign(callsign);
  if (!own) return '';

  const direction = message.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const type = String(message.type || '').toLowerCase();
  const sender = normalizeCallsign(message.sender);
  const recipient = normalizeCallsign(message.recipient);

  if (type === 'private') {
    if (direction === 'incoming') return 'private';
    // This narrow exception makes the real Altitude self-message flow usable
    // as an end-to-end notification test without notifying normal sent chat.
    if (sender === own && recipient === own) return 'private';
    return '';
  }

  if (direction !== 'incoming' || !['frequency', 'broadcast'].includes(type)) return '';
  return textAddressesCallsign(message.text, own) ? 'addressed' : '';
}

function textAddressesCallsign(text, callsign) {
  const value = String(text || '').trimStart().toUpperCase();
  if (!value.startsWith(callsign)) return false;
  const boundary = value.slice(callsign.length, callsign.length + 1);
  return boundary === '' || /[\s,:;]/.test(boundary);
}

function notificationPayload(trigger, message, callsign, appUrl) {
  const own = normalizeCallsign(callsign);
  const sender = String(message.sender || 'IVAO').trim().slice(0, 64);
  const text = String(message.text || '').trim().replace(/\s+/g, ' ').slice(0, 240);
  const navigate = normalizeAppUrl(appUrl) || 'https://app.voxhf.com/';
  const digest = crypto.createHash('sha256')
    .update(`${trigger}|${sender}|${text}`)
    .digest('base64url')
    .slice(0, 24);
  return {
    web_push: 8030,
    notification: {
      title: trigger === 'private' ? `Private message for ${own}` : `Message for ${own}`,
      body: `${sender}: ${text}`,
      navigate,
      silent: false,
      tag: `voxhf-${digest}`,
    },
  };
}

function ivaoDisconnectPayload(callsign, appUrl) {
  const own = normalizeCallsign(callsign);
  const navigate = normalizeAppUrl(appUrl) || 'https://app.voxhf.com/';
  return {
    web_push: 8030,
    notification: {
      title: own ? `IVAO disconnected - ${own}` : 'IVAO disconnected',
      body: 'VoxHF lost the IVAO connection. Reconnect Altitude as soon as possible.',
      navigate,
      silent: false,
      tag: 'voxhf-ivao-disconnected',
    },
  };
}

function ivaoConnectedPayload(callsign, appUrl) {
  const own = normalizeCallsign(callsign);
  const navigate = normalizeAppUrl(appUrl) || 'https://app.voxhf.com/';
  return {
    web_push: 8030,
    notification: {
      title: own ? `IVAO online - ${own}` : 'IVAO online',
      body: 'VoxHF notifications are active on this device.',
      navigate,
      silent: false,
      tag: 'voxhf-ivao-connected',
    },
  };
}

function unicomTimerPayload(callsign, appUrl) {
  const own = normalizeCallsign(callsign);
  const navigate = normalizeAppUrl(appUrl) || 'https://app.voxhf.com/';
  return {
    web_push: 8030,
    notification: {
      title: own ? `Timer expired - ${own}` : 'Timer expired',
      body: 'You can now disconnect and report the leg.',
      navigate,
      silent: false,
      tag: 'voxhf-unicom-timer',
    },
  };
}

function agentOfflinePayload(callsign, appUrl) {
  const own = normalizeCallsign(callsign);
  const navigate = normalizeAppUrl(appUrl) || 'https://app.voxhf.com/';
  return {
    web_push: 8030,
    notification: {
      title: own ? `VoxHF agent offline - ${own}` : 'VoxHF agent offline',
      body: 'The local VoxHF proxy is no longer reachable.',
      navigate,
      silent: false,
      tag: 'voxhf-agent-offline',
    },
  };
}

function isIvaoServerMessage(message) {
  return message?.direction !== 'outgoing' && normalizeCallsign(message?.sender) === 'SERVER';
}

function normalizeSubscription(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const endpoint = String(value.endpoint || '').trim();
  const p256dh = String(value.keys?.p256dh || value.p256dh || '').trim();
  const auth = String(value.keys?.auth || value.auth || '').trim();
  const deviceId = String(value.deviceId || '').trim();
  const deviceName = String(value.deviceName || 'Browser device').trim().slice(0, 80);
  const appUrl = normalizeAppUrl(value.appUrl);
  const notifyIvaoConnected = value.notifyIvaoConnected === true;
  const notifyAgentOffline = value.notifyAgentOffline === true;
  if (!validPushEndpoint(endpoint) || !validPushKey(p256dh) || !validPushKey(auth)) return null;
  if (deviceId && !/^[A-Za-z0-9._:-]{8,160}$/.test(deviceId)) return null;
  if (!appUrl) return null;
  return {
    endpoint,
    keys: { p256dh, auth },
    deviceId: deviceId || crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 32),
    deviceName: deviceName || 'Browser device',
    appUrl,
    notifyIvaoConnected,
    notifyAgentOffline,
  };
}

function pushSubscription(value) {
  return {
    endpoint: value.endpoint,
    keys: {
      p256dh: value.keys.p256dh,
      auth: value.keys.auth,
    },
  };
}

function validPushEndpoint(value) {
  if (!value || Buffer.byteLength(value, 'utf8') > 4096) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function validPushKey(value) {
  return typeof value === 'string'
    && value.length >= 8
    && value.length <= 512
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function normalizeAppUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return '';
    if (!url.pathname) url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

function normalizeCallsign(value) {
  const text = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9-]{2,16}$/.test(text) ? text : '';
}

function messageSignature(trigger, message, callsign) {
  return crypto.createHash('sha256')
    .update([
      trigger,
      normalizeCallsign(callsign),
      normalizeCallsign(message.sender),
      normalizeCallsign(message.recipient),
      String(message.text || '').trim().toUpperCase(),
    ].join('|'))
    .digest('hex');
}

function cleanupRecentMessages(recent, currentTime) {
  for (const [key, timestamp] of recent.entries()) {
    if (currentTime - timestamp > RECENT_MESSAGE_TTL_MS) recent.delete(key);
  }
}

function loadStore(storageFile, logger) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storageFile, 'utf8').replace(/^\uFEFF/, ''));
    return {
      version: STORE_VERSION,
      vapid: parsed.vapid || null,
      subscriptions: Array.isArray(parsed.subscriptions)
        ? parsed.subscriptions.map(normalizeSubscription).filter(Boolean).slice(-MAX_SUBSCRIPTIONS)
        : [],
    };
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('[PUSH] Local notification state could not be read; creating a new store.');
    return { version: STORE_VERSION, vapid: null, subscriptions: [] };
  }
}

function persistStore(storageFile, store) {
  fs.mkdirSync(path.dirname(storageFile), { recursive: true });
  const temporary = `${storageFile}.${process.pid}.tmp`;
  const data = `${JSON.stringify({
    version: STORE_VERSION,
    vapid: store.vapid,
    subscriptions: store.subscriptions,
  }, null, 2)}\n`;
  fs.writeFileSync(temporary, data, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, storageFile);
}

function validVapid(value) {
  return Boolean(value)
    && validPushKey(value.publicKey)
    && validPushKey(value.privateKey);
}

module.exports = {
  agentOfflinePayload,
  createPushNotifications,
  ivaoConnectedPayload,
  ivaoDisconnectPayload,
  isIvaoServerMessage,
  notificationTrigger,
  textAddressesCallsign,
  unicomTimerPayload,
};
