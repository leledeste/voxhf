'use strict';

// Focused regression coverage for Web TX readiness. Altitude may use multiple
// UDP source ports at once, but only a validated TS2 setup or native TX packet
// may replace the active transmit seed.
const assert = require('assert');
const { createWebTx } = require('../proxy/web-tx');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const { OggSpeexWriter } = require('../proxy/ogg-speex');

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

// Run the real encoder lifecycle with controlled children/timers. A kill
// request deliberately does NOT emit exit immediately: that is the race being
// tested. Synthetic Ogg packets exercise parsing/queueing without live audio.
function lifecycleHarness() {
  const children = [];
  const timers = new Map();
  const datagrams = [];
  const lamps = [];
  const filename = path.resolve(__dirname, '../proxy/web-tx.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  function stream() {
    const result = new EventEmitter();
    result.writes = [];
    result.write = bytes => { result.writes.push(Buffer.from(bytes)); return true; };
    result.end = () => { result.ended = true; };
    return result;
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer,
    setTimeout(callback) { const id = {}; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(name) {
      if (name !== 'child_process') return localRequire(name);
      return { spawn() {
        const child = new EventEmitter();
        child.stdin = stream(); child.stdout = stream(); child.stderr = stream();
        child.kills = 0; child.kill = () => { child.kills++; };
        children.push(child);
        return child;
      } };
    },
  }, { filename });
  const tx = module.exports.createWebTx({
    config: { webTxEnabled: true }, logger: { log() {}, warn() {} },
    setTxLamp: (com, active) => lamps.push({ com, active }),
    getTs2Target: () => ({ host: '192.0.2.1', port: 8767 }),
  });
  const udp = { send: data => datagrams.push(Buffer.from(data)) };
  tx.cacheTxSession(setupPacket(0x44), 'test-flow', udp);
  return { tx, children, timers, datagrams, lamps, udp,
    browser() { return { readyState: 1, messages: [], send(data) { this.messages.push(data); } }; },
    runTimers() {
      while (timers.size) {
        const [id, callback] = timers.entries().next().value;
        timers.delete(id); callback();
      }
    },
  };
}

function encodedAudio() {
  const writer = new OggSpeexWriter(32000, 3);
  return Buffer.concat([writer.headers(), writer.frame(Buffer.from([1, 2, 3, 4]))]);
}

for (const mode of [{}, { monitor: true }, { monitorOnly: true }]) {
  for (const transition of ['restart', 'stop', 'invalidate']) {
    const h = lifecycleHarness();
    const ws = h.browser();
    h.tx.start(ws, 1, mode);
    const oldEncoder = h.children.at(-1);
    const oldMonitor = mode.monitor || mode.monitorOnly ? h.children.at(-2) : null;
    oldEncoder.stdout.emit('data', encodedAudio());
    const oldTimerCallbacks = Array.from(h.timers.values());
    if (transition === 'stop') h.tx.stop(ws, 'PTT released');
    if (transition === 'invalidate') {
      // Invalidating the TS2 seed stops network TX, not a local-only monitor.
      h.tx.invalidateTxSession('voice connection changed');
      h.tx.cacheTxSession(setupPacket(0x55), 'new-flow', h.udp);
    }
    h.tx.start(ws, 2, mode);
    const freshEncoder = h.children.at(-1);
    const freshMonitor = mode.monitor || mode.monitorOnly ? h.children.at(-2) : null;
    const messages = ws.messages.length;
    const lamps = h.lamps.length;
    oldEncoder.emit('exit', 0, null);
    assert.strictEqual(h.tx.writePcm(ws, Buffer.from([0, 0])), true,
      `late encoder exit stopped replacement (${transition}, ${JSON.stringify(mode)})`);
    assert.strictEqual(freshEncoder.kills, 0);
    assert.strictEqual(ws.messages.length, messages, 'old exit must not publish TX inactive');
    assert.strictEqual(h.lamps.length, lamps, 'old exit must not turn off the new COM lamp');
    const oldMonitorWrites = oldMonitor?.stdin.writes.length;
    oldEncoder.stdout.emit('data', encodedAudio());
    if (oldMonitor) {
      oldMonitor.stdout.emit('data', Buffer.from('stale monitor PCM'));
      assert.strictEqual(oldMonitor.stdin.writes.length, oldMonitorWrites);
    }
    for (const callback of oldTimerCallbacks) callback();
    assert.strictEqual(h.timers.size, 0, 'old stdout must not queue more audio');
    assert.strictEqual(ws.messages.length, messages, 'closed monitor must not leak PCM');
    assert.strictEqual(h.datagrams.length, 0, 'old session must not transmit queued audio');

    freshEncoder.stdout.emit('data', encodedAudio());
    h.runTimers();
    assert.strictEqual(h.datagrams.length, mode.monitorOnly ? 0 : 1);
    if (freshMonitor) {
      const pcm = Buffer.from('current monitor PCM');
      freshMonitor.stdout.emit('data', pcm);
      assert.deepStrictEqual(ws.messages.at(-1), pcm);
    }
    freshEncoder.emit('exit', 1, null);
    assert.strictEqual(h.tx.writePcm(ws, Buffer.from([0, 0])), false,
      'the active encoder exit must still stop its own session');
    const stopped = JSON.parse(ws.messages.at(-1));
    assert.strictEqual(stopped.active, false);
    assert.strictEqual(stopped.text, 'encoder closed');
    const afterStop = ws.messages.length;
    freshEncoder.emit('exit', 1, null);
    freshEncoder.stdout.emit('data', encodedAudio());
    freshMonitor?.stdout.emit('data', Buffer.from('after stop'));
    assert.strictEqual(ws.messages.length, afterStop);
    assert.strictEqual(h.timers.size, 0);
  }
}

{
  const h = lifecycleHarness();
  const first = h.browser(); const second = h.browser();
  h.tx.start(first, 1); const encoder = h.children.at(-1);
  h.tx.start(second, 2);
  encoder.emit('exit', 1, null);
  assert.strictEqual(h.tx.writePcm(first, Buffer.from([0, 0])), false);
  assert.strictEqual(h.tx.writePcm(second, Buffer.from([0, 0])), true);
  h.tx.stop(second, 'test cleanup');
}
console.log('[OK] delayed TX encoder exits/output, monitor PCM, queued timers and independent browser lifecycles');

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
