'use strict';

// Exercise the real router, FSD rewriter, UDP/TCP forwarding and Web TX seed
// ownership without contacting IVAO, capturing a microphone, or running ffmpeg.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const { createWebTx } = require('../proxy/web-tx');
const { createVoiceRouteTrace } = require('../proxy/voice-route-trace');

const SOUTH = 'ts-1.sa-east-1.ivao.aero';
const EUROPE = 'ts-1.eu-west-2.ivao.aero';
const quiet = { log() {}, warn() {}, error() {} };
const local = { address: '192.0.2.10', port: 53304 };
const tick = () => new Promise(resolve => setImmediate(resolve));

function load(file, mocks) {
  const filename = path.resolve(__dirname, '..', file);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer, setTimeout, clearTimeout,
    require: name => mocks[name] || localRequire(name),
  }, { filename });
  return module.exports;
}

class Socket extends EventEmitter {
  constructor() { super(); this.sent = []; this.destroyed = false; this.remoteAddress = local.address; }
  write(data) { this.sent.push(Buffer.from(data)); return true; }
  send(data, port, host) { this.sent.push({ data: Buffer.from(data), port, host }); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
  close() { this.destroy(); }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
}

function harness(traceEnabled = false) {
  const binds = [];
  const tcpListeners = [];
  const udpSockets = [];
  const tcpConnections = [];
  const processes = [];
  const net = {
    createServer(accept) {
      const server = new Socket();
      server.accept = accept;
      server.listen = (port, host, done) => { server.host = host; binds.push({ socket: server, done }); };
      tcpListeners.push(server);
      return server;
    },
    createConnection(target) { const socket = new Socket(); tcpConnections.push({ socket, target }); return socket; },
  };
  const child = load('proxy/ts2-voice-proxy.js', {
    net,
    dns: { resolve4(host, done) { done(null, [host === SOUTH ? '192.0.2.1' : '192.0.2.2']); } },
    dgram: { createSocket() {
      const socket = new Socket();
      socket.bind = (port, host, done) => { socket.host = host; binds.push({ socket, done }); };
      udpSockets.push(socket);
      return socket;
    } },
    child_process: { spawn() {
      const process = new Socket();
      process.stdin = new Socket(); process.stdin.end = () => {};
      process.stdout = new Socket(); process.stderr = new Socket();
      processes.push(process); return process;
    } },
  });
  const { createTs2VoiceRouter } = load('proxy/ts2-voice-router.js', { './ts2-voice-proxy': child });
  const logs = [];
  const logger = { ...quiet, log: text => logs.push(text) };
  let resets = 0;
  let ready = 0;
  let cached = 0;
  let webTx;
  const pcm = [];
  const router = createTs2VoiceRouter({
    port: 8767, config: { voiceDecode: true }, localAddresses: [local.address], logger,
    routeTrace: createVoiceRouteTrace({ enabled: traceEnabled, logger }),
    onSessionReset: reason => webTx.invalidateTxSession(reason),
    onClientPacket(...args) { cached++; webTx.cacheTxSession(...args); },
    onClientClose: (key, reason) => webTx.invalidateTxSession(reason, key),
    onPcm: bytes => pcm.push(bytes),
  });
  webTx = createWebTx({ config: { webTxEnabled: true }, logger,
    getTs2Target: router.getTarget, onReady() { ready++; }, onNotReady() { resets++; } });
  return {
    router, binds, tcpListeners, udpSockets, tcpConnections, processes, pcm,
    stats: () => ({ resets, ready, cached }),
    listen() { for (const bind of binds.splice(0)) if (!bind.socket.destroyed) bind.done(); },
    async endpoint(host) { const result = router.getEndpoint(host); this.listen(); return result; },
    udp(address) { return udpSockets.find(socket => socket.host === address); },
  };
}

function packet(cls, subtype, length = 20) {
  const data = Buffer.alloc(length, 0x77);
  data.writeUInt16LE(cls, 0); data.writeUInt16LE(subtype, 2); return data;
}
const login = packet(0xBEF4, 3, 180);
const setup = packet(0xBEF0, 5, 120);
const ping = packet(0xBEF4, 1);
const join = packet(0xBEF0, 0x012f, 58);
const voice = packet(0xBEF3, 0x0c00, 40);

async function routing(trace) {
  const h = harness(trace);
  try {
    const a = await h.endpoint(SOUTH);
    const b = await h.endpoint(EUROPE);
    assert.notEqual(a, b);
    assert.equal(await h.router.getEndpoint(SOUTH), a);
    assert.equal(h.router.getServer(), '', 'discovery cannot select a voice server');
    const send = (address, bytes) => h.udp(address).emit('message', bytes, local);
    send(a, login); send(a, setup);
    const aRemote = h.udpSockets.at(-1);
    assert.equal(h.router.getServer(), SOUTH);
    assert.equal(h.stats().ready, 1);
    for (let i = 0; i < 5; i++) {
      await h.router.getEndpoint(EUROPE); await h.router.getEndpoint(SOUTH); send(a, ping);
    }
    assert.equal(h.stats().resets, 0);
    assert.ok(aRemote.sent.every(item => item.host === '192.0.2.1'));
    send(a, join); // A channel change on the same host keeps the session.
    assert.equal(h.stats().resets, 0);
    aRemote.emit('message', voice);
    const oldDecoder = h.processes.at(-1);
    oldDecoder.stdout.emit('data', Buffer.from('first'));
    assert.equal(h.pcm.length, 1);
    send(b, login);
    const bRemote = h.udpSockets.at(-1);
    assert.equal(h.router.getServer(), EUROPE);
    assert.equal(h.stats().resets, 1);
    send(b, ping);
    assert.equal(h.stats().ready, 1, 'old keepalive cannot seed a fresh login');
    send(b, setup);
    const beforeOldPackets = h.stats();
    send(a, ping); send(a, setup); aRemote.emit('message', voice);
    assert.deepEqual(h.stats(), beforeOldPackets, 'inactive route cannot steal Web TX');
    assert.equal(h.router.getTarget().host, '192.0.2.2');
    assert.ok(bRemote.sent.every(item => item.host === '192.0.2.2'));
    send(a, login); send(a, setup);
    assert.equal(h.router.getServer(), SOUTH);
    aRemote.emit('message', voice);
    const newDecoder = h.processes.at(-1);
    assert.notEqual(newDecoder, oldDecoder);
    oldDecoder.stdout.emit('data', Buffer.from('stale'));
    oldDecoder.emit('exit', 0);
    newDecoder.stdout.emit('data', Buffer.from('new'));
    assert.deepEqual(h.pcm.map(bytes => bytes.toString()), ['first', 'new']);
    const beforeClose = h.stats();
    bRemote.close();
    assert.deepEqual(h.stats(), beforeClose, 'late close from previous route must not clear active TX');
    const beforeReconnect = h.stats().resets;
    send(a, login);
    assert.equal(h.stats().resets, beforeReconnect + 1, 'same-route reconnect invalidates old seed');
    send(a, setup);
    // Native traffic can legitimately move to another source port within the
    // same authenticated session; a late close of the old flow is harmless.
    const alternate = { ...local, port: local.port + 1 };
    const native = packet(0xBEF2, 0x0c00, 40);
    const beforeAlternate = h.stats().cached;
    h.udp(a).emit('message', native, alternate);
    assert.equal(h.stats().cached, beforeAlternate + 1);
    const alternateRemote = h.udpSockets.at(-1);
    const wrongSession = Buffer.from(native); wrongSession[4] = 0x55;
    h.udp(a).emit('message', wrongSession, local);
    assert.equal(h.stats().cached, beforeAlternate + 1);
    const beforeOldClose = h.stats().resets;
    aRemote.close();
    assert.equal(h.stats().resets, beforeOldClose);
    assert.equal(h.router.getServer(), SOUTH);
    alternateRemote.emit('message', voice);
    const tcp = h.tcpListeners.find(server => server.host === a);
    const client = new Socket(); tcp.accept(client);
    const tcpRemote = h.tcpConnections.at(-1);
    const body = Buffer.from('synthetic passthrough');
    client.emit('data', body); tcpRemote.socket.emit('data', body);
    assert.deepEqual(client.sent, [body]); assert.deepEqual(tcpRemote.socket.sent, [body]);
    assert.equal(tcpRemote.target.host, '192.0.2.1');
    const count = h.udpSockets.length;
    h.udp(a).emit('message', login, { address: '203.0.113.9', port: 1234 });
    assert.equal(h.udpSockets.length, count, 'reject nonlocal clients');
    const foreign = new Socket(); foreign.remoteAddress = '203.0.113.9'; tcp.accept(foreign);
    assert.equal(foreign.destroyed, true);
    h.router.resetUdpClients('FSD closed');
    assert.equal(h.router.getServer(), '');
    const afterReset = h.stats();
    aRemote.emit('message', voice);
    assert.deepEqual(h.stats(), afterReset);
    send(a, ping);
    assert.equal(h.router.getServer(), '', 'stray keepalive after disconnect must not reactivate');
    send(a, login); send(a, setup);
    return { stats: h.stats(), a, b };
  } finally { h.router.close(); }
}

async function endpoints() {
  const h = harness();
  try {
    let done = false;
    const promise = h.router.getEndpoint(SOUTH).then(value => { done = true; return value; });
    h.binds.shift().done(); await tick(); assert.equal(done, false);
    h.listen(); const first = await promise;
    assert.match(first, /^127\./);
    const reversed = harness();
    try {
      await reversed.endpoint(EUROPE);
      assert.equal(await reversed.endpoint(SOUTH), first, 'endpoint identity survives reversed discovery order');
    } finally { reversed.router.close(); }
    const failure = h.router.getEndpoint(EUROPE);
    const check = assert.rejects(failure, /EADDRINUSE/);
    h.binds[0].socket.emit('error', { code: 'EADDRINUSE' });
    await check;
    await assert.rejects(h.router.getEndpoint(EUROPE), /EADDRINUSE/);
    await assert.rejects(h.router.getEndpoint('127.0.0.1'), /Unsupported/);
    await assert.rejects(h.router.getEndpoint('ts-1.eu.ivao.aero.evil.test'), /Unsupported/);
    await assert.rejects(h.router.getEndpoint('ts-1.eu.ivao.aero:22'), /Unsupported/);
    for (let i = 2; i < 32; i++) await h.endpoint(`ts-${i}.test.ivao.aero`);
    await assert.rejects(h.router.getEndpoint('ts-99.test.ivao.aero'), /limit/);
  } finally { h.router.close(); }
}

async function fsdOrdering() {
  const h = harness();
  let accept;
  let remote;
  const { createFsdProxy } = load('proxy/fsd-proxy.js', { net: {
    createServer(callback) { accept = callback; return {}; },
    createConnection() { remote = new Socket(); return remote; },
  } });
  const errors = [];
  createFsdProxy({ getHost: () => 'fsd.test', logger: { ...quiet, error: text => errors.push(text) },
    getVoiceEndpoint: h.router.getEndpoint,
    state: { getConnected: () => true, setConnected() {}, getCallsign: () => 'TEST1', rememberFsdState() {}, broadcast() {} },
  });
  const core = new Socket(); accept(core);
  const line = host => Buffer.from(`$CRSERVER:TEST1:VOICE:TEST_TWR:${host}/TEST_TWR\r\n`);
  const chat = Buffer.from('#TMOTHER:TEST1:hello\r\n');
  try {
    remote.emit('data', Buffer.concat([line(SOUTH), chat, line(EUROPE)]));
    assert.equal(core.sent.length, 0);
    assert.equal(remote.paused, true);
    h.listen(); await tick();
    assert.equal(core.sent.length, 2);
    assert.ok(core.sent[0].includes(Buffer.from(`${await h.router.getEndpoint(SOUTH)}/TEST_TWR`)));
    assert.deepEqual(core.sent[1], chat);
    h.listen(); await tick();
    assert.ok(core.sent[2].includes(Buffer.from(`${await h.router.getEndpoint(EUROPE)}/TEST_TWR`)));
    assert.equal(remote.paused, false);
    remote.emit('data', Buffer.concat([line('evil.test'), chat]));
    await tick();
    assert.equal(errors.length, 1);
    assert.deepEqual(core.sent.at(-1), chat, 'binding/validation failure must not disconnect the flight');
    assert.equal(core.destroyed, false);
    const old = core;
    remote.emit('data', line('ts-3.test.ivao.aero'));
    old.destroy();
    const fresh = new Socket(); accept(fresh);
    h.listen(); await tick();
    assert.equal(old.sent.length, 4, 'late endpoint completion must not write to a closed FSD session');
    assert.equal(fresh.sent.length, 0);
    remote.emit('data', line('ts-4.test.ivao.aero'));
    remote.emit('data', Buffer.alloc(1024 * 1024 + 1, 0x20));
    assert.equal(fresh.destroyed, true, 'input queued during binding remains bounded');
    h.listen(); await tick();
    assert.equal(fresh.sent.length, 0);
    assert.ok(errors.at(-1).includes('1 MiB'));
  } finally { h.router.close(); }
}

(async () => {
  assert.deepEqual(await routing(false), await routing(true));
  console.log('[OK] distinct endpoints, discovery isolation, A/B/A, same-server joins, reconnects and TX/RX ownership');
  await endpoints();
  console.log('[OK] endpoint readiness, bind failure, destination validation, local-only clients and allocation bounds');
  await fsdOrdering();
  console.log('[OK] async FSD ordering, bind-before-advertise, failure isolation and stale-session completion');
})().catch(error => { console.error(error); process.exitCode = 1; });
