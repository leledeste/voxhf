'use strict';

// Focused regression coverage for Web TX readiness. Altitude may use multiple
// UDP source ports at once, but only a validated TS2 setup or native TX packet
// may replace the active transmit seed.
const assert = require('assert');
const { createWebTx } = require('../proxy/web-tx');

const CLASS_SESSION = 0xBEF0;
const CLASS_TXVOICE = 0xBEF2;

let readyEvents = 0;
let notReadyEvents = 0;
const transitionLogs = [];
const webTx = createWebTx({
  config: { webTxEnabled: true },
  logger: {
    log: message => transitionLogs.push(String(message)),
    warn: message => transitionLogs.push(String(message)),
  },
  setTxLamp() {},
  getTs2Target: () => ({ host: '127.0.0.1', port: 8767 }),
  onReady: () => { readyEvents += 1; },
  onNotReady: () => { notReadyEvents += 1; },
});

const socketA = { send() {} };
const socketB = { send() {} };

webTx.cacheTxSession(setupPacket(0x11), '127.0.0.1:41001', socketA);
assert.strictEqual(webTx.isReady(), true);
assert.strictEqual(readyEvents, 1);
assert.strictEqual(notReadyEvents, 0);

// An unrelated packet from another source port must not clear a valid seed.
webTx.cacheTxSession(unrelatedPacket(), '127.0.0.1:41002', socketB);
assert.strictEqual(webTx.isReady(), true);
assert.strictEqual(readyEvents, 1);
assert.strictEqual(notReadyEvents, 0);

// A validated setup packet may replace the seed without a false not-ready edge.
webTx.cacheTxSession(setupPacket(0x22), '127.0.0.1:41002', socketB);
assert.strictEqual(webTx.isReady(), true);
assert.strictEqual(readyEvents, 1);
assert.strictEqual(notReadyEvents, 0);

// Closing the superseded client must not invalidate the current session.
webTx.invalidateTxSession('old UDP client closed', '127.0.0.1:41001');
assert.strictEqual(webTx.isReady(), true);
assert.strictEqual(notReadyEvents, 0);

// A native Altitude PTT seed can also move between UDP flows atomically.
webTx.cacheTxSession(nativeTxPacket(0x22, 7), '127.0.0.1:41002', socketB);
webTx.cacheTxSession(nativeTxPacket(0x33, 9), '127.0.0.1:41001', socketA);
assert.strictEqual(webTx.isReady(), true);
assert.strictEqual(readyEvents, 1);
assert.strictEqual(notReadyEvents, 0);

webTx.invalidateTxSession('current UDP client closed', '127.0.0.1:41001');
assert.strictEqual(webTx.isReady(), false);
assert.strictEqual(notReadyEvents, 1);
assert(transitionLogs.some(line => line.includes('[WEBTX] Ready: derived TS2 session acquired.')));
assert(transitionLogs.some(line => line.includes('[WEBTX] Not ready: current UDP client closed.')));

console.log('[OK] Web TX readiness stays stable across alternating TS2 UDP flows');

function setupPacket(seedByte) {
  const packet = Buffer.alloc(16);
  packet.writeUInt16LE(CLASS_SESSION, 0);
  packet.writeUInt16LE(0x0005, 2);
  packet.fill(seedByte, 4, 12);
  return packet;
}

function nativeTxPacket(seedByte, sequence) {
  const packet = Buffer.alloc(16);
  packet.writeUInt16LE(CLASS_TXVOICE, 0);
  packet.writeUInt16LE(0x0C00, 2);
  packet.fill(seedByte, 4, 12);
  packet.writeUInt32LE(sequence, 12);
  return packet;
}

function unrelatedPacket() {
  const packet = Buffer.alloc(16);
  packet.writeUInt16LE(0xBEEF, 0);
  packet.writeUInt16LE(0x0002, 2);
  return packet;
}
