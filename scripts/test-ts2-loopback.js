'use strict';

// Real local TCP/UDP only, on an ephemeral port. Verify that this OS preserves
// distinct loopback destinations with automatic or explicit loopback sources.
// Explicitly LAN-bound clients are not assumed to support loopback on Windows;
// Altitude's real socket binding still needs live validation.
// No IVAO traffic, audio, credentials, privileged ports, or interface changes.
const assert = require('assert/strict');
const net = require('net');
const dgram = require('dgram');
const { once } = require('events');
let stage = 'initialization';

(async () => {
  const sockets = [];
  const servers = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const event = (emitter, name) => once(emitter, name, { signal: controller.signal });
  try {
    const addresses = ['127.77.0.1', '127.77.0.2'];
    let port = 0;
    for (const address of addresses) {
      stage = `binding ${address}`;
      const udp = dgram.createSocket('udp4'); sockets.push(udp);
      const bound = event(udp, 'listening'); udp.bind(port, address); await bound;
      port = udp.address().port;
      udp.on('message', (bytes, sender) => udp.send(bytes, sender.port, sender.address));
      const tcp = net.createServer(client => { sockets.push(client); client.pipe(client); }); servers.push(tcp);
      const listening = event(tcp, 'listening'); tcp.listen(port, address); await listening;
    }
    for (const source of ['127.0.0.1', '0.0.0.0']) {
      const client = dgram.createSocket('udp4'); sockets.push(client);
      const bound = event(client, 'listening'); client.bind(0, source); await bound;
      for (const address of addresses) {
        stage = `UDP ${source} -> ${address}`;
        const payload = Buffer.from(`loopback:${address}`);
        const reply = event(client, 'message'); client.send(payload, port, address);
        const [bytes, from] = await reply;
        assert.deepEqual(bytes, payload); assert.equal(from.address, address);
        stage = `TCP ${source} -> ${address}`;
        const tcp = net.createConnection({ host: address, port, localAddress: source }); sockets.push(tcp);
        await event(tcp, 'connect');
        const received = event(tcp, 'data'); tcp.write(payload);
        assert.deepEqual((await received)[0], payload); tcp.destroy();
      }
    }
    console.log('[OK] real TCP/UDP endpoints keep distinct loopback identities with automatic and loopback sources');
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) {
      try { if (socket.destroy) socket.destroy(); else socket.close(); } catch (_) {}
    }
    for (const server of servers) { try { server.close(); } catch (_) {} }
  }
})().catch(error => { console.error(`[FAIL] ${stage}: ${error.message}`); process.exitCode = 1; });
