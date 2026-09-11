'use strict';

// Deterministic local WebSocket lifecycle tests. No IVAO connection, real
// microphone, or ffmpeg process is needed to exercise disconnect isolation.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');

function harness() {
  let wss;
  const stopped = [];
  const commands = [];
  const pcm = [];
  const logs = [];
  const filename = path.resolve(__dirname, '../proxy/local-web-server.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer,
    require(name) {
      if (name === 'http') return { createServer: () => new EventEmitter() };
      if (name === 'ws') return { WebSocketServer: class extends EventEmitter {
        constructor() { super(); wss = this; }
      } };
      if (name === './static-web') return { createStaticWebHandler: () => () => {} };
      if (name === './websocket-commands') return {
        createWebCommandHandler: () => (ws, cmd) => commands.push({ ws, cmd }),
      };
      return localRequire(name);
    },
  }, { filename });
  const server = module.exports.createLocalWebServer({
    webDir: '.', makeInitPayload: () => ({ kind: 'init' }),
    logger: { error: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    stopWebTx: (ws, reason) => stopped.push({ ws, reason }),
    writeWebTxPcm: (ws, bytes) => pcm.push({ ws, bytes }),
  });
  function client(onSend) {
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.sent = [];
    ws.terminated = 0;
    ws.send = data => { ws.sent.push(data); onSend?.(ws); };
    // Delay close deliberately: queued messages must be ignored immediately
    // after error, not only when the closing handshake eventually completes.
    ws.terminate = () => { ws.terminated++; };
    wss.emit('connection', ws);
    return ws;
  }
  return { server, stopped, commands, pcm, logs, client };
}

{
  const h = harness();
  const bad = h.client();
  const healthy = h.client();
  bad.emit('message', Buffer.from('{"kind":"ping"}'));
  bad.emit('message', Buffer.from('CTX1synthetic'));
  assert.equal(h.commands.length, 1);
  assert.equal(h.pcm.length, 1);
  assert.doesNotThrow(() => bad.emit('error', new Error('PRIVATE_PAYLOAD_MUST_NOT_BE_LOGGED')));
  assert.equal(bad.terminated, 1);
  assert.equal(h.stopped.length, 1);
  assert.equal(h.stopped[0].ws, bad);
  assert.equal(h.stopped[0].reason, 'webapp connection error');
  bad.emit('message', Buffer.from('{"kind":"voice_tx","active":true}'));
  bad.emit('message', Buffer.from('CTX1late'));
  assert.equal(h.commands.length, 1, 'an errored client cannot restart TX with queued commands');
  assert.equal(h.pcm.length, 1, 'an errored client cannot deliver more microphone data');
  const badSent = bad.sent.length;
  h.server.sendJson({ kind: 'status' });
  h.server.sendBinary(Buffer.from('synthetic RX'));
  assert.equal(bad.sent.length, badSent, 'failed client must be removed from fan-out');
  assert.equal(healthy.sent.length, 3);
  healthy.emit('message', Buffer.from('{"kind":"ping"}'));
  healthy.emit('message', Buffer.from('CTX1healthy'));
  assert.equal(h.commands.length, 2);
  assert.equal(h.pcm.length, 2);
  bad.emit('close'); bad.emit('error', new Error('late error')); bad.emit('close');
  assert.equal(h.stopped.length, 1, 'cleanup is idempotent across repeated close/error');
  assert.equal(bad.terminated, 1);
  assert.equal(h.logs.length, 1);
  assert.ok(!JSON.stringify(h.logs).includes('PRIVATE_PAYLOAD'));
  healthy.emit('close');
  healthy.emit('error', new Error('after normal close'));
  assert.equal(h.stopped.length, 2);
  assert.equal(h.stopped[1].reason, 'webapp closed');
  assert.equal(healthy.terminated, 0);
  healthy.emit('message', Buffer.from('{"kind":"ping"}'));
  assert.equal(h.commands.length, 2);
  const reconnect = h.client();
  reconnect.emit('message', Buffer.from('{"kind":"ping"}'));
  assert.equal(h.commands.at(-1).ws, reconnect);
}

{
  // Error listeners must exist before the initial snapshot is sent.
  const h = harness();
  let firstSend = true;
  let ws;
  assert.doesNotThrow(() => {
    ws = h.client(client => {
      if (!firstSend) return;
      firstSend = false;
      client.emit('error', new Error('initial send failed'));
    });
  });
  assert.equal(ws.terminated, 1);
  assert.equal(h.stopped.length, 1);
  ws.emit('close');
  assert.equal(h.stopped.length, 1);
}

console.log('[OK] local WebSocket errors stop only the affected TX, clean up once and block stale commands/PCM');
console.log('[OK] initial-send errors, healthy browsers, reconnects and log privacy');

// Exercise an actual ws receiver error (oversized frame), not just a manually
// emitted event. The HTTP server uses an ephemeral loopback port; all payloads
// are synthetic and TX is represented by the cleanup callback only.
async function realReceiverError() {
  const { once } = require('events');
  const WebSocket = require('ws');
  const { createLocalWebServer } = require('../proxy/local-web-server');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const event = (emitter, name) => once(emitter, name, { signal: controller.signal });
  const stopped = [];
  const warnings = [];
  const stopEvents = new EventEmitter();
  const server = createLocalWebServer({
    webDir: path.resolve(__dirname, '../webapp'), maxJsonBytes: 64,
    makeInitPayload: () => ({ kind: 'init' }),
    stopWebTx: (ws, reason) => { stopped.push({ ws, reason }); stopEvents.emit('stopped'); },
    logger: { warn: text => warnings.push(text), error() {} },
  });
  const clients = [];
  try {
    const listening = event(server.httpServer, 'listening');
    server.httpServer.listen(0, '127.0.0.1'); await listening;
    const url = `ws://127.0.0.1:${server.httpServer.address().port}/ws`;
    for (let i = 0; i < 2; i++) {
      const ws = new WebSocket(url, { origin: 'http://localhost:3000' });
      clients.push(ws);
      ws.on('error', () => {});
      const [bytes] = await event(ws, 'message');
      assert.equal(JSON.parse(bytes.toString()).kind, 'init');
    }
    const [bad, healthy] = clients;
    const closed = event(bad, 'close');
    bad.send(Buffer.alloc(256, 0x41));
    await closed;
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].reason, 'webapp connection error');
    assert.equal(warnings.length, 1);
    const update = event(healthy, 'message');
    server.sendJson({ kind: 'still-connected' });
    assert.equal(JSON.parse((await update)[0].toString()).kind, 'still-connected');
    const healthyClosed = event(healthy, 'close');
    const healthyCleaned = event(stopEvents, 'stopped');
    healthy.close(); await Promise.all([healthyClosed, healthyCleaned]);
    assert.equal(stopped.length, 2);
    assert.equal(stopped[1].reason, 'webapp closed');
    console.log('[OK] real local oversized WebSocket frame isolates the failed client and preserves its healthy peer');
  } finally {
    clearTimeout(timer);
    for (const ws of clients) ws.terminate();
    await new Promise(resolve => server.httpServer.close(resolve));
  }
}

realReceiverError().catch(error => { console.error(error); process.exitCode = 1; });
