'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const webPush = require('web-push');
const {
  agentOfflinePayload,
  createPushNotifications,
  ivaoConnectedPayload,
  ivaoDisconnectPayload,
  isIvaoServerMessage,
  notificationTrigger,
  textAddressesCallsign,
  unicomTimerPayload,
} = require('../proxy/push-notifications');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-push-test-'));
const realTemporary = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-push-real-test-'));
const storageFile = path.join(temporary, 'notifications.json');
const deliveries = [];
const vapidCalls = [];
const fakeWebPush = {
  generateVAPIDKeys: () => ({
    publicKey: 'PUBLIC_KEY_123456789',
    privateKey: 'PRIVATE_KEY_123456789',
  }),
  setVapidDetails: () => {},
  getVapidHeaders(audience, subject, publicKey, privateKey, contentEncoding, expiration) {
    vapidCalls.push({ audience, subject, publicKey, privateKey, contentEncoding, expiration });
    return { Authorization: 'vapid short-lived-proxy-request-123456789' };
  },
  generateRequestDetails(subscription, payload, options) {
    return {
      endpoint: subscription.endpoint,
      headers: {
        Authorization: 'vapid signed-proxy-request-123456789',
        'Content-Encoding': 'aes128gcm',
      },
      body: Buffer.from(payload),
      options,
    };
  },
  async sendNotification(subscription, payload, options) {
    if (subscription.endpoint.endsWith('/gone')) {
      const error = new Error('expired');
      error.statusCode = 410;
      throw error;
    }
    deliveries.push({ subscription, payload: JSON.parse(payload), options });
  },
};

function subscription(name, overrides = {}) {
  return {
    endpoint: `https://push.example/${name}`,
    p256dh: `P256DH_${name}_123456`,
    auth: `AUTH_${name}_123456`,
    deviceId: `device-${name}-123456`,
    deviceName: name,
    appUrl: 'https://app.example/app.html',
    ...overrides,
  };
}

function message(overrides = {}) {
  return {
    kind: 'message',
    type: 'frequency',
    sender: 'LIMC_TWR',
    recipient: '@26805',
    text: 'WZZ2807, contact EPRZ_TWR on 126.805, good day.',
    direction: 'incoming',
    ...overrides,
  };
}

(async () => {
  try {
    const push = createPushNotifications({
      storageFile,
      webPush: fakeWebPush,
      logger: { log() {}, warn() {} },
      now: () => Date.parse('2026-07-28T12:00:00.000Z'),
    });
    assert.equal(push.addSubscription(subscription('one', {
      notifyIvaoConnected: true,
      notifyAgentOffline: true,
    })).ok, true);
    assert.equal(push.addSubscription(subscription('two')).ok, true);
    assert.equal(push.addSubscription(subscription('gone')).ok, true);
    assert.equal(push.getPublicState().subscriptionCount, 3);

    assert.equal(textAddressesCallsign('WZZ2807, climb FL120', 'WZZ2807'), true);
    assert.equal(textAddressesCallsign(' WZZ2807 switch to UNICOM', 'WZZ2807'), true);
    assert.equal(textAddressesCallsign('WZZ28070, climb FL120', 'WZZ2807'), false);
    assert.equal(notificationTrigger(message(), 'WZZ2807'), 'addressed');
    assert.equal(notificationTrigger(message({ text: 'WZZ28070, contact tower' }), 'WZZ2807'), '');

    const addressed = await push.notifyForMessage(message(), 'WZZ2807');
    assert.deepEqual({ sent: addressed.sent, expired: addressed.expired }, { sent: 2, expired: 1 });
    assert.equal(push.getPublicState().subscriptionCount, 2);
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0].payload.web_push, 8030);
    assert.equal(deliveries[0].payload.notification.navigate, 'https://app.example/app.html');

    const duplicate = await push.notifyForMessage(message(), 'WZZ2807');
    assert.equal(duplicate.duplicate, true);
    assert.equal(deliveries.length, 2);

    await push.notifyForMessage(message({ text: 'Unrelated traffic' }), 'WZZ2807');
    assert.equal(deliveries.length, 2);

    await push.notifyForMessage(message({
      type: 'private',
      sender: 'LIMC_GND',
      recipient: 'WZZ2807',
      text: 'Private incoming',
    }), 'WZZ2807');
    assert.equal(deliveries.length, 4);

    await push.notifyForMessage(message({
      type: 'private',
      sender: 'WZZ2807',
      recipient: 'LIMC_GND',
      text: 'Normal outgoing private',
      direction: 'outgoing',
    }), 'WZZ2807');
    assert.equal(deliveries.length, 4);

    await push.notifyForMessage(message({
      type: 'private',
      sender: 'WZZ2807',
      recipient: 'WZZ2807',
      text: 'Altitude self-test',
      direction: 'outgoing',
    }), 'WZZ2807');
    assert.equal(deliveries.length, 6);

    const welcome = message({
      type: 'private',
      sender: 'SERVER',
      recipient: 'WZZ2807',
      text: '#! (04)> Welcome to IVAO World Server v1.18.2.0',
    });
    assert.equal(isIvaoServerMessage(welcome), true);
    const suppressedWelcome = await push.notifyForMessage(welcome, 'WZZ2807', {
      suppressStartupServer: true,
    });
    assert.equal(suppressedWelcome.suppressed, 'ivao-startup-server');
    assert.equal(deliveries.length, 6);

    const laterServerMessage = await push.notifyForMessage(message({
      type: 'private',
      sender: 'SERVER',
      recipient: 'WZZ2807',
      text: '#! (04)> Server maintenance will begin in 15 minutes.',
    }), 'WZZ2807');
    assert.equal(laterServerMessage.sent, 2);
    assert.equal(deliveries.length, 8);
    assert.match(deliveries[6].payload.notification.body, /maintenance/i);

    const connectedPayload = ivaoConnectedPayload('WZZ2807', 'https://app.example/app.html');
    assert.equal(connectedPayload.notification.title, 'IVAO online - WZZ2807');
    assert.equal(connectedPayload.notification.tag, 'voxhf-ivao-connected');
    const connected = await push.notifyIvaoConnected('WZZ2807');
    assert.deepEqual(
      { sent: connected.sent, targetCount: connected.targetCount, subscriptionCount: connected.subscriptionCount },
      { sent: 1, targetCount: 1, subscriptionCount: 2 },
    );
    assert.equal(deliveries.length, 9);
    assert.match(deliveries[8].payload.notification.body, /notifications are active/i);
    assert.equal(deliveries[8].options.TTL, 300);

    const disconnectPayload = ivaoDisconnectPayload('WZZ2807', 'https://app.example/app.html');
    assert.equal(disconnectPayload.notification.title, 'IVAO disconnected - WZZ2807');
    assert.equal(disconnectPayload.notification.tag, 'voxhf-ivao-disconnected');

    const disconnected = await push.notifyIvaoDisconnected('WZZ2807');
    assert.deepEqual(
      { sent: disconnected.sent, failed: disconnected.failed, subscriptionCount: disconnected.subscriptionCount },
      { sent: 2, failed: 0, subscriptionCount: 2 },
    );
    assert.equal(deliveries.length, 11);
    assert.equal(deliveries[9].payload.notification.title, 'IVAO disconnected - WZZ2807');
    assert.match(deliveries[9].payload.notification.body, /Reconnect Altitude/);
    assert.equal(deliveries[9].payload.notification.navigate, 'https://app.example/app.html');
    assert.equal(deliveries[9].options.TTL, 30 * 60);
    assert.equal(deliveries[9].options.urgency, 'high');

    const timerPayload = unicomTimerPayload('WZZ2807', 'https://app.example/app.html');
    assert.equal(timerPayload.notification.title, 'Timer expired - WZZ2807');
    assert.equal(timerPayload.notification.tag, 'voxhf-unicom-timer');
    const timerExpired = await push.notifyUnicomTimerExpired('WZZ2807');
    assert.deepEqual(
      { sent: timerExpired.sent, failed: timerExpired.failed, subscriptionCount: timerExpired.subscriptionCount },
      { sent: 2, failed: 0, subscriptionCount: 2 },
    );
    assert.equal(deliveries.length, 13);
    assert.equal(deliveries[11].payload.notification.body, 'You can now disconnect and report the leg.');
    assert.equal(deliveries[11].options.TTL, 300);

    const agentOffline = agentOfflinePayload('WZZ2807', 'https://app.example/app.html');
    assert.equal(agentOffline.notification.title, 'VoxHF agent offline - WZZ2807');
    assert.equal(agentOffline.notification.body, 'The local VoxHF proxy is no longer reachable.');
    assert.equal(agentOffline.notification.tag, 'voxhf-agent-offline');
    const watchdogTickets = push.createAgentOfflineWatchdogTickets('WZZ2807');
    assert.equal(watchdogTickets.length, 1);
    assert.equal(watchdogTickets[0].deviceId, 'device-one-123456');
    assert.equal(watchdogTickets[0].endpoint, 'https://push.example/one');
    assert.equal(watchdogTickets[0].contentEncoding, 'aes128gcm');
    assert.match(watchdogTickets[0].authorization, /^vapid /);
    assert.equal(vapidCalls.length, 1);
    assert.equal(vapidCalls[0].audience, 'https://push.example');
    assert.equal(vapidCalls[0].contentEncoding, 'aes128gcm');
    assert.equal(vapidCalls[0].expiration, Date.parse(watchdogTickets[0].expiresAt) / 1000);
    const sealedPayload = JSON.parse(Buffer.from(watchdogTickets[0].body, 'base64url').toString('utf8'));
    assert.equal(sealedPayload.notification.body, 'The local VoxHF proxy is no longer reachable.');

    const subscriptionKeys = crypto.createECDH('prime256v1');
    subscriptionKeys.generateKeys();
    const realPush = createPushNotifications({
      storageFile: path.join(realTemporary, 'notifications.json'),
      webPush,
      logger: { log() {}, warn() {} },
    });
    assert.equal(realPush.addSubscription({
      endpoint: 'https://fcm.googleapis.com/wp/voxhf-test',
      p256dh: subscriptionKeys.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
      deviceId: 'browser-real-push-12345678',
      deviceName: 'Real Web Push test',
      appUrl: 'https://app.example/app.html',
      notifyAgentOffline: true,
    }).ok, true);
    const realTickets = realPush.createAgentOfflineWatchdogTickets('WZZ2807');
    assert.equal(realTickets.length, 1);
    const vapidMatch = realTickets[0].authorization.match(/^vapid t=([^,]+), k=/);
    assert.ok(vapidMatch, 'real watchdog ticket must contain a VAPID authorization');
    const vapidPayload = JSON.parse(Buffer.from(vapidMatch[1].split('.')[1], 'base64url').toString('utf8'));
    assert.equal(vapidPayload.exp, Math.floor(Date.parse(realTickets[0].expiresAt) / 1000));
    assert.ok(Buffer.from(realTickets[0].body, 'base64url').length > 16);

    const reloaded = createPushNotifications({
      storageFile,
      webPush: fakeWebPush,
      logger: { log() {}, warn() {} },
    });
    assert.equal(reloaded.getPublicState().subscriptionCount, 2);
    const reloadedConnected = await reloaded.notifyIvaoConnected('WZZ2807');
    assert.equal(reloadedConnected.sent, 1);
    reloaded.removeSubscription('https://push.example/one');
    assert.equal(reloaded.getPublicState().subscriptionCount, 1);

    console.log('Push notification checks passed.');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(realTemporary, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
