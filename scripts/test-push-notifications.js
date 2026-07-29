'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createPushNotifications,
  notificationTrigger,
  textAddressesCallsign,
} = require('../proxy/push-notifications');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'voxhf-push-test-'));
const storageFile = path.join(temporary, 'notifications.json');
const deliveries = [];
const fakeWebPush = {
  generateVAPIDKeys: () => ({
    publicKey: 'PUBLIC_KEY_123456789',
    privateKey: 'PRIVATE_KEY_123456789',
  }),
  setVapidDetails: () => {},
  async sendNotification(subscription, payload) {
    if (subscription.endpoint.endsWith('/gone')) {
      const error = new Error('expired');
      error.statusCode = 410;
      throw error;
    }
    deliveries.push({ subscription, payload: JSON.parse(payload) });
  },
};

function subscription(name) {
  return {
    endpoint: `https://push.example/${name}`,
    p256dh: `P256DH_${name}_123456`,
    auth: `AUTH_${name}_123456`,
    deviceId: `device-${name}-123456`,
    deviceName: name,
    appUrl: 'https://app.example/app.html',
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
    assert.equal(push.addSubscription(subscription('one')).ok, true);
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

    const reloaded = createPushNotifications({
      storageFile,
      webPush: fakeWebPush,
      logger: { log() {}, warn() {} },
    });
    assert.equal(reloaded.getPublicState().subscriptionCount, 2);
    reloaded.removeSubscription('https://push.example/one');
    assert.equal(reloaded.getPublicState().subscriptionCount, 1);

    console.log('Push notification checks passed.');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
