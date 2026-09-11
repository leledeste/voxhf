'use strict';

// Drive real routing code with delayed DNS callbacks. No network connection,
// voice capture, or ffmpeg process is needed to reproduce callback reordering.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const filename = path.resolve(__dirname, '../proxy/ts2-voice-proxy.js');
const source = fs.readFileSync(filename, 'utf8');
const localRequire = createRequire(filename);
const SERVER_A = 'voice-a.example';
const SERVER_B = 'voice-b.example';
const IP_A = '192.0.2.1';
const IP_B = '192.0.2.2';
const IP_NEW = '192.0.2.3';

function harness() {
  const queries = [];
  const udp = [];
  const tcp = [];
  let accept;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Buffer, setTimeout, clearTimeout,
    require(name) {
      if (name === 'dns') return {
        resolve4(host, done) { queries.push({ host, done }); },
      };
      if (name === 'net') return {
        createServer(callback) { accept = callback; return {}; },
        createConnection(target) { tcp.push(target); return new EventEmitter(); },
      };
      if (name === 'dgram') return {
        createSocket() {
          const socket = new EventEmitter();
          socket.send = (data, port, host) => udp.push({ data, port, host });
          socket.close = () => socket.emit('close');
          return socket;
        },
      };
      if (name === 'child_process') return {
        spawn() { throw new Error('DNS tests must not start ffmpeg'); },
      };
      return localRequire(name);
    },
  }, { filename });
  const proxy = module.exports.createTs2VoiceProxy({
    initialServer: SERVER_A, port: 8767, config: { voiceDecode: false },
    logger: { log() {}, warn() {}, error() {} },
  });
  return {
    proxy, queries, udp, tcp,
    answer(index, addresses, error = null) { queries[index].done(error, addresses); },
    connectTcp() { accept(new EventEmitter()); },
    sendUdp() { proxy.udpSocket.emit('message', Buffer.from([0, 0]), { address: '127.0.0.1', port: 40000 }); },
    expectTarget(host) {
      assert.strictEqual(proxy.getTarget().host, host);
      assert.strictEqual(proxy.getTarget().port, 8767);
    },
  };
}

let count = 0;
function test(name, run) {
  run();
  count += 1;
  console.log(`[OK] ${name}`);
}

test('late old-server result cannot replace a resolved new server', () => {
  const h = harness();
  h.proxy.setServer(SERVER_B);
  h.answer(1, [IP_B]);
  h.answer(0, [IP_A]);
  h.expectTarget(IP_B);
  assert.strictEqual(h.proxy.getServer(), SERVER_B);
  h.connectTcp();
  h.sendUdp();
  h.sendUdp();
  assert.strictEqual(h.tcp[0].host, IP_B);
  assert.ok(h.udp.every(packet => packet.host === IP_B && packet.port === 8767));
  assert.strictEqual(h.udp.length, 2);
});

test('old result cannot replace hostname fallback while new DNS is pending', () => {
  const h = harness();
  h.proxy.setServer(SERVER_B);
  h.answer(0, [IP_A]);
  h.expectTarget(SERVER_B);
  h.sendUdp();
  assert.strictEqual(h.udp[0].host, SERVER_B);
  h.answer(1, [IP_B]);
  h.expectTarget(IP_B);
  h.sendUdp();
  assert.strictEqual(h.udp[1].host, SERVER_B, 'existing UDP route keeps its original destination');
});

test('A -> B -> A rejects the first A lookup even though the hostname matches', () => {
  const h = harness();
  h.proxy.setServer(SERVER_B);
  h.proxy.setServer(SERVER_A);
  h.answer(0, [IP_A]);
  h.expectTarget(SERVER_A);
  h.answer(2, [IP_NEW]);
  h.answer(1, [IP_B]);
  h.expectTarget(IP_NEW);
});

test('repeated same-server refresh keeps only the latest requested result', () => {
  const h = harness();
  h.answer(0, [IP_A]);
  h.proxy.setServer(SERVER_A);
  h.expectTarget(IP_A);
  h.proxy.setServer(SERVER_A);
  h.answer(2, [IP_NEW, IP_B]);
  h.answer(1, [IP_B]);
  h.expectTarget(IP_NEW);
});

test('new-server lookup failure does not resurrect an old server address', () => {
  const h = harness();
  h.proxy.setServer(SERVER_B);
  h.answer(1, undefined, new Error('DNS failed'));
  h.answer(0, [IP_A]);
  h.expectTarget(SERVER_B);
});

test('failed same-server refresh preserves its previously accepted address', () => {
  const h = harness();
  h.answer(0, [IP_A]);
  h.proxy.setServer(SERVER_A);
  h.proxy.setServer(SERVER_A);
  h.answer(2, undefined, new Error('DNS failed'));
  h.answer(1, [IP_NEW]);
  h.expectTarget(IP_A);
});

test('empty result preserves hostname fallback and ignores obsolete success', () => {
  const h = harness();
  h.proxy.setServer(SERVER_B);
  h.answer(1, []);
  h.answer(0, [IP_A]);
  h.expectTarget(SERVER_B);
});

test('blank selections do not invalidate a valid pending lookup', () => {
  const h = harness();
  assert.strictEqual(h.proxy.setServer('  '), SERVER_A);
  assert.strictEqual(h.queries.length, 1);
  h.answer(0, [IP_A]);
  h.expectTarget(IP_A);
});

test('DNS request ordering is independent for each proxy instance', () => {
  const first = harness();
  const second = harness();
  first.proxy.setServer(SERVER_B);
  second.answer(0, [IP_A]);
  first.answer(1, [IP_B]);
  first.answer(0, [IP_NEW]);
  first.expectTarget(IP_B);
  second.expectTarget(IP_A);
});

console.log(`[OK] ${count} TS2 DNS ordering and routing regressions`);
