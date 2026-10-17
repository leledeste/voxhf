'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const {
  makeMessagePackFrame,
  makeV114FreqPacket,
  makeV114SquawkPacket,
  makeV114XpdrTogglePacket,
  makeV114IdentPacket,
  makeV114RadioVolumePacket,
  makeV114CoreEventFrame,
  decodeMessagePack,
  createMessagePackFrameReader,
} = require('../proxy/pilot-core');

assert.strictEqual(
  makeV114FreqPacket(1, '122.800').toString('hex'),
  '0b00000092cd18009201ce0001dfb0',
  'COM tuning must match a captured Altitude 1.14 frame',
);
// These command ids come from the PilotUI 1.14 Qt slots themselves. Keeping
// both assertions explicit prevents a visually successful IDENT click from
// masking a swapped toggle/IDENT mapping.
assert.strictEqual(makeV114XpdrTogglePacket().toString('hex'), '0500000092cd160190');
assert.strictEqual(makeV114IdentPacket().toString('hex'), '0500000092cd160290');
assert.deepStrictEqual(
  decodeMessagePack(makeV114RadioVolumePacket(2, 50).subarray(4)),
  [0x3000, [0xdde6, '2|50']],
);
assert.throws(() => makeV114RadioVolumePacket(1, 101), /between 0 and 100/);
assert.deepStrictEqual(
  decodeMessagePack(makeV114SquawkPacket('1200').subarray(4)),
  [0x3000, [0x0100, '1200']],
);
assert.deepStrictEqual(
  decodeMessagePack(makeV114SquawkPacket('0421').subarray(4)),
  [0x3000, [0x0100, '0421']],
);
assert.deepStrictEqual(
  decodeMessagePack(makeV114CoreEventFrame(0xdde5, '2|1|0|0').subarray(4)),
  [0x3000, [0xdde5, '2|1|0|0']],
);

const messages = [];
const read = createMessagePackFrameReader(message => messages.push(message));
const capturedHandshake = Buffer.from(
  '0d00000092cd300092cddde6a4317c3530'
  + '0d00000092cd300092cddde6a4327c3530'
  + '0a00000092cd100091a46976616f',
  'hex',
);
for (const byte of capturedHandshake) read(Buffer.from([byte]));
assert.deepStrictEqual(messages, [
  [0x3000, [0xdde6, '1|50']],
  [0x3000, [0xdde6, '2|50']],
  [0x1000, ['ivao']],
]);

const coalesced = [];
const readCoalesced = createMessagePackFrameReader(message => coalesced.push(message));
readCoalesced(Buffer.concat([
  makeMessagePackFrame(0x2000, [true, true, '1.14.0.24b']),
  makeV114FreqPacket(2, '128.350'),
]));
assert.deepStrictEqual(coalesced, [
  [0x2000, [true, true, '1.14.0.24b']],
  [0x1800, [2, 128350]],
]);

assert.throws(() => decodeMessagePack(Buffer.from([0x92, 0xcd])), /Truncated/);

class Socket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.destroyed = false;
  }

  write(data) {
    this.sent.push(Buffer.from(data));
    return true;
  }

  destroy() {
    this.destroyed = true;
  }
}

function loadPilotBridge(net) {
  const filename = path.resolve(__dirname, '../proxy/pilot-bridge.js');
  const module = { exports: {} };
  const localRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    exports: module.exports,
    Buffer,
    require: name => (name === 'net' ? net : localRequire(name)),
  }, { filename });
  return module.exports.createPilotBridge;
}

function createNetwork() {
  let accept;
  let remote;
  let onRemoteConnected;
  return {
    api: {
      createServer(callback) {
        accept = callback;
        return {};
      },
      createConnection(_target, connected) {
        remote = new Socket();
        onRemoteConnected = connected;
        return remote;
      },
    },
    connect() {
      const client = new Socket();
      accept(client);
      onRemoteConnected?.();
      return { client, remote };
    },
  };
}

const network = createNetwork();
const comUpdates = [];
const logs = [];
const bridge = loadPilotBridge(network.api)({
  pilotCoreHost: '127.0.0.2',
  port: 4827,
  tracePilotAudio: true,
  logger: { log: line => logs.push(line), error() {} },
  onComFrequency: (com, freq) => comUpdates.push({ com, freq }),
});
const connection = network.connect();
assert.strictEqual(bridge.getProtocol(), 'legacy');
assert.strictEqual(bridge.setRadioVolume(1, 50), false);
assert.strictEqual(bridge.setCom(1, '122.800'), true);
assert.strictEqual(connection.remote.sent.at(-1).toString('hex'), '07000000202001b0df0100');

const auth = makeMessagePackFrame(0x1000, ['ivao']);
connection.client.emit('data', auth.subarray(0, 3));
connection.client.emit('data', auth.subarray(3));
assert.strictEqual(bridge.getProtocol(), 'messagepack');
assert.strictEqual(bridge.setCom(2, '128.350'), true);
assert.strictEqual(connection.remote.sent.at(-1).toString('hex'), makeV114FreqPacket(2, '128.350').toString('hex'));

connection.client.emit('data', makeV114FreqPacket(1, '123.450'));
assert.deepStrictEqual(comUpdates.at(-1), { com: 1, freq: 123.45 });
connection.remote.emit('data', makeMessagePackFrame(0x2000, [true, true, '1.14.0.24b']));
assert.ok(logs.some(line => line.includes('MessagePack protocol detected (1.14.0.24b)')));

connection.client.emit('data', makeV114CoreEventFrame(0xdde6, '1|17'));
connection.remote.emit('data', makeV114CoreEventFrame(0xdde6, '2|63'));
assert.ok(logs.includes('[AUDIO TRACE] ui-to-core VHF1 volume=17'));
assert.ok(logs.includes('[AUDIO TRACE] core-to-ui VHF2 volume=63'));
connection.client.emit('data', makeV114CoreEventFrame(0xdde6, '1|50|private-message'));
assert.ok(!logs.some(line => line.includes('private-message')));

bridge.setSquawk('1200');
assert.deepStrictEqual(decodeMessagePack(connection.remote.sent.at(-1).subarray(4)), [0x3000, [0x0100, '1200']]);
bridge.toggleXpdr();
assert.strictEqual(connection.remote.sent.at(-1).toString('hex'), makeV114XpdrTogglePacket().toString('hex'));
bridge.sendIdent();
assert.strictEqual(connection.remote.sent.at(-1).toString('hex'), makeV114IdentPacket().toString('hex'));
assert.strictEqual(bridge.setRadioVolume(1, 50), true);
assert.deepStrictEqual(
  decodeMessagePack(connection.remote.sent.at(-1).subarray(4)),
  [0x3000, [0xdde6, '1|50']],
);
assert.deepStrictEqual(
  decodeMessagePack(connection.client.sent.at(-1).subarray(4)),
  [0x3000, [0xdde6, '1|50']],
);
bridge.setTxLamp(2, true);
assert.deepStrictEqual(decodeMessagePack(connection.client.sent.at(-1).subarray(4)), [0x3000, [0xdde5, '2|1|0|0']]);

console.log('[OK] Altitude 1.14 MessagePack framing, commands and streaming parser');
console.log('[OK] Pilot bridge switches automatically between Altitude 1.13 and 1.14 commands');
