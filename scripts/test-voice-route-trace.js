'use strict';

// Compare tracing on/off against the same fixed-endpoint FSD/TS2/Web TX
// sequence. End-to-end routing isolation is tested in test-ts2-routing.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const { createVoiceRouteTrace } = require('../proxy/voice-route-trace');
const { createWebTx } = require('../proxy/web-tx');

const SOUTH = 'ts-1.sa-east-1.ivao.aero';
const EUROPE = 'ts-1.eu-west-2.ivao.aero';

class Socket extends EventEmitter {
  constructor() { super(); this.sent = []; this.destroyed = false; }
  write(data) { this.sent.push(Buffer.from(data)); return true; }
  send(data, port, host) { this.sent.push({ bytes: Buffer.from(data).toString('hex'), port, host }); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
  close() { this.destroy(); }
}

function network() {
  const connections = [];
  let accept;
  return {
    createServer(callback) { accept = callback; return {}; },
    createConnection(target, connected) {
      const socket = new Socket();
      connections.push({ socket, connected, target });
      return socket;
    },
    connect() {
      const client = new Socket();
      accept(client);
      const remote = connections.at(-1);
      remote.connected?.();
      return { client, remote: remote.socket };
    },
  };
}

function load(relative, mocks) {
  const filename = path.resolve(__dirname, '..', relative);
  const module = { exports: {} };
  const localRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer, setTimeout, clearTimeout,
    require: name => mocks[name] || localRequire(name),
  }, { filename });
  return module.exports;
}

function reproduce(enabled) {
  const logs = [];
  const logger = { log: line => logs.push(line), warn() {}, error() {} };
  const trace = createVoiceRouteTrace({ enabled, logger });
  const udp = [];
  const tsNet = network();
  let webTx;
  const voice = load('proxy/ts2-voice-proxy.js', {
    net: tsNet,
    dns: { resolve4(host, done) { done(null, [host === SOUTH ? '192.0.2.1' : '192.0.2.2']); } },
    dgram: { createSocket() { const socket = new Socket(); udp.push(socket); return socket; } },
    child_process: { spawn() { throw new Error('No ffmpeg in routing tests'); } },
  }).createTs2VoiceProxy({
    initialServer: SOUTH, port: 8767, config: { voiceDecode: false }, logger,
    routeTrace: trace,
    onClientPacket: (packet, key, socket) => webTx.cacheTxSession(packet, key, socket),
    onClientClose: key => webTx.invalidateTxSession('closed', key),
  });
  let ready = 0;
  let resets = 0;
  webTx = createWebTx({
    config: { webTxEnabled: true }, logger, getTs2Target: voice.getTarget,
    onReady: () => { ready += 1; }, onNotReady: () => { resets += 1; },
  });
  const fsdNet = network();
  load('proxy/fsd-proxy.js', { net: fsdNet }).createFsdProxy({
    logger, routeTrace: trace, getHost: () => 'fsd.example',
    state: { getConnected: () => true, setConnected() {}, getCallsign: () => 'TEST123', rememberFsdState() {}, broadcast() {} },
    getVoiceEndpoint: host => host === SOUTH ? '127.77.0.1' : '127.77.0.2',
  });
  const fsd = fsdNet.connect();
  const setup = Buffer.alloc(16, 0x77);
  setup.writeUInt16LE(0xBEF0, 0);
  setup.writeUInt16LE(5, 2);
  const send = () => voice.udpSocket.emit('message', setup, { address: '192.0.2.10', port: 62187 });
  send();
  const destinations = [];
  for (const [station, host] of [
    ['SBAZ_CTR', SOUTH], ['SBWR_APP', SOUTH], ['SBXN_APP', SOUTH],
    ['SBBR_TWR', EUROPE], ['SBAZ_CTR', SOUTH],
  ]) {
    fsd.client.emit('data', Buffer.from(`$CQTEST123:SERVER:VOICE:${station}\r\n`));
    fsd.remote.emit('data', Buffer.from(`$CRSERVER:TEST123:VOICE:${station}:${host}/${station}\r\n`));
    send();
    destinations.push(voice.getTarget().host);
  }
  const ts = tsNet.connect();
  const packet = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('secret-password SBAZ_CTR')]);
  ts.client.emit('data', packet);
  ts.remote.emit('data', packet);
  assert.deepStrictEqual(ts.remote.sent, [packet]);
  assert.deepStrictEqual(ts.client.sent, [packet]);
  const pilotNet = network();
  load('proxy/pilot-bridge.js', { net: pilotNet }).createPilotBridge({
    routeTrace: trace, port: 4827, fsdPort: 6809, pilotCoreHost: '127.0.0.2', logger,
  });
  const pilot = pilotNet.connect();
  pilot.client.emit('data', packet);
  pilot.remote.emit('data', packet);
  assert.deepStrictEqual(pilot.remote.sent, [packet]);
  assert.deepStrictEqual(pilot.client.sent, [packet]);
  ts.client.destroy();
  pilot.client.destroy();
  voice.resetUdpClients();
  return { logs, result: { destinations, ready, resets, forwarded: fsd.client.sent.map(bytes => bytes.toString()), udp: udp.map(socket => socket.sent) } };
}

const plain = reproduce(false);
const traced = reproduce(true);
assert.deepStrictEqual(traced.result, plain.result, 'tracing must not change routing, readiness or bytes');
assert.deepStrictEqual(traced.result.destinations, Array(5).fill('192.0.2.1'));
// Only explicit cleanup resets readiness; discovery never changes the route.
assert.strictEqual(traced.result.resets, 1);
assert.strictEqual(traced.result.ready, 1);
assert.ok(!plain.logs.some(line => line.startsWith('[ROUTE]')));
for (const event of ['fsd-query', 'fsd-reply', 'tcp-open', 'tcp-close', 'udp-open', 'udp-close', 'packet']) {
  assert.ok(traced.logs.some(line => line.startsWith('[ROUTE]') && line.includes(` ${event} `)), event);
}
assert.ok(traced.logs.some(line => line.includes('hints=SBAZ_CTR')));
assert.ok(!traced.logs.join('\n').includes('secret-password'));
assert.ok(!traced.logs.join('\n').includes('7777777777777777'));
console.log('[OK] discovery does not retarget the fixed voice endpoint');
console.log('[OK] optional routing trace preserves FSD, PilotCore, TS2 bytes and readiness behavior');

const privacy = [];
let time = 0;
const trace = createVoiceRouteTrace({ enabled: true, logger: { log: line => privacy.push(line) }, now: () => time });
const socket = {};
trace.event('fsd-reply', { station: 'SBAZ_CTR', host: SOUTH, token: 'secret-token', raw: 'private chat' });
trace.event('fsd-reply', { station: 'SBAZ_CTR\nFORGED', host: 'host\nFORGED' });
const framed = Buffer.alloc(32);
framed.writeUInt32LE(28, 0);
framed.writeUInt32LE(0xdde53000, 4);
framed.writeUInt32LE(20, 8);
framed.write('secret-token', 12);
trace.packet('pilot', 'out', {}, framed);
assert.ok(privacy.at(-1).includes('frame=dde53000'));
const repeated = privacy.length;
const repeatSocket = {};
trace.packet('ts2-tcp', 'out', repeatSocket, Buffer.alloc(8));
trace.packet('ts2-tcp', 'out', repeatSocket, Buffer.alloc(8));
assert.strictEqual(privacy.length, repeated + 1, 'repeated shapes should be suppressed');
for (const cls of [0xBEF2, 0xBEF0, 0xBEF3]) {
  const audio = Buffer.alloc(40);
  audio.writeUInt16LE(cls, 0);
  audio.writeUInt16LE(0x0C00, 2);
  audio.write('secret-audio SBAZ_CTR', 4);
  const before = privacy.length;
  trace.packet('ts2-udp', 'in', socket, audio);
  assert.strictEqual(privacy.length, before, 'known voice packets must not be traced');
}
const beforeShapes = privacy.length;
for (let i = 0; i < 40; i++) trace.packet('pilot', 'in', socket, Buffer.alloc(100 + i));
assert.strictEqual(privacy.length, beforeShapes + 24);
assert.ok(!privacy.join('\n').match(/secret|private chat|FORGED/));
time = 600001;
trace.event('com', { com: 1, freq: '123.450' });
const stopped = privacy.length;
trace.event('com', { com: 2, freq: '123.450' });
assert.strictEqual(privacy.length, stopped);
const capped = [];
const cappedTrace = createVoiceRouteTrace({ enabled: true, logger: { log: line => capped.push(line) } });
for (let i = 0; i < 1300; i++) cappedTrace.event('com', { com: 1, freq: '123.450' });
assert.strictEqual(capped.length, 1201);
assert.strictEqual(createVoiceRouteTrace(), null);
console.log('[OK] trace privacy, disabled mode, packet-shape, duration and line limits');
