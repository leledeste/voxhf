'use strict';

const { createTs2VoiceProxy } = require('./ts2-voice-proxy');
const { createHash } = require('crypto');

const MAX_SERVERS = 32;

// Preserve server identity in the VOICE reply itself. Altitude chooses the
// endpoint, so discovery order and UI COM timing cannot select a destination.
// Loopback addresses need no hosts-file, firewall, or interface changes.
function createTs2VoiceRouter(options) {
  const routes = new Map();
  const localAddresses = new Set(options.localAddresses || []);
  const logger = options.logger || console;
  let active = null;
  let activeKey = '';
  let activeTarget = null;
  let sessionBytes = null;
  let closed = false;

  function clearActive(reason) {
    active?.proxy.stopVoiceDecoder();
    active = null;
    activeKey = '';
    activeTarget = null;
    sessionBytes = null;
    options.onSessionReset?.(reason);
  }

  function getEndpoint(value) {
    const host = String(value || '').trim().toLowerCase();
    // FSD data is not permission to proxy arbitrary destinations. Fail closed
    // for unsupported hosts rather than forwarding the original VOICE reply.
    if (!/^ts-\d+\.[a-z0-9-]+\.ivao\.aero$/.test(host)) {
      return Promise.reject(new Error('Unsupported IVAO TS2 hostname'));
    }
    if (closed) return Promise.reject(new Error('TS2 router is closed'));
    const existing = routes.get(host);
    if (existing) return existing.failure ? Promise.reject(existing.failure) : existing.ready;
    if (routes.size >= MAX_SERVERS) return Promise.reject(new Error('TS2 endpoint limit reached'));

    // Stable across proxy restarts: Altitude may cache a VOICE reply. A cached
    // address must not silently mean another server when discovery order changes.
    const hash = createHash('sha256').update(host).digest();
    const address = `127.${64 + hash[0] % 64}.${hash[1]}.${1 + hash[2] % 254}`;
    if (Array.from(routes.values()).some(route => route.address === address)) {
      return Promise.reject(new Error('TS2 local endpoint address collision'));
    }
    const route = { host, address, proxy: null, ready: null };
    routes.set(host, route);
    const isLocal = address => /^127\./.test(address) || localAddresses.has(address);
    route.proxy = createTs2VoiceProxy({
      ...options,
      initialServer: host,
      acceptClient: isLocal,
      onPcm: pcm => { if (active === route) options.onPcm?.(pcm); },
      shouldDecode: () => active === route,
      onClientPacket(packet, key, socket, target) {
        const scopedKey = `${address}/${key}`;
        // A new login is observable without inspecting credentials. Old
        // keepalives/ACKs must never steal browser TX back to the previous route.
        const login = packet.length >= 16 && packet.readUInt16LE(0) === 0xBEF4
          && packet.readUInt16LE(2) === 0x0003;
        if (login) {
          const previous = active?.host || '';
          clearActive('voice connection changed');
          active = route;
          activeKey = scopedKey;
          activeTarget = target;
          options.routeTrace?.event('route-change', { from: previous || host, to: host });
          logger.log(`[TS2] Active voice server: ${host}`);
        }
        if (active !== route || packet.length < 16) return;
        const cls = packet.readUInt16LE(0);
        const subtype = packet.readUInt16LE(2);
        const setup = cls === 0xBEF0 && subtype === 0x0005;
        // Learn a new seed only on the flow that actually started the login.
        // Alternate native flows remain supported once their session bytes
        // match; unrelated old flows cannot revive a previous session.
        if (!sessionBytes && activeKey === scopedKey && setup) {
          const bytes = packet.subarray(4, 12);
          if (!bytes.every(byte => byte === 0)) sessionBytes = Buffer.from(bytes);
        }
        const seedPacket = setup || cls === 0xBEF2 || (cls === 0xBEF1 && subtype === 0)
          || (cls === 0xBEF4 && subtype === 1);
        if (!seedPacket || !sessionBytes || !packet.subarray(4, 12).equals(sessionBytes)) return;
        activeKey = scopedKey;
        activeTarget = target;
        options.onClientPacket?.(packet, scopedKey, socket);
      },
      onClientClose(key, reason) {
        const scopedKey = `${address}/${key}`;
        if (active === route && activeKey === scopedKey) clearActive(reason);
        options.onClientClose?.(scopedKey, reason);
      },
    });
    // Never advertise a local address until BOTH transports are listening.
    // Failed addresses remain reserved: cached VOICE replies must never route
    // to a different server later in this proxy process.
    route.ready = new Promise((resolve, reject) => {
      let remaining = 2;
      let settled = false;
      const timer = setTimeout(() => fail(new Error('TS2 endpoint bind timeout')), 5000);
      function fail(err) {
        if (route.failure) return;
        route.failure = new Error(`Cannot open local TS2 endpoint ${address}: ${err.code || err.message}`);
        if (settled) {
          clearIfActive();
          route.proxy.close('voice endpoint failed');
          logger.error(`[TS2] ${route.failure.message}`);
          return;
        }
        settled = true;
        clearTimeout(timer);
        route.proxy.close('voice endpoint failed');
        reject(route.failure);
      }
      function clearIfActive() { if (active === route) clearActive('voice endpoint failed'); }
      function listening() {
        if (settled || --remaining !== 0) return;
        settled = true;
        clearTimeout(timer);
        logger.log(`[TS2] Endpoint ${host} -> ${address}:${options.port}`);
        resolve(address);
      }
      route.proxy.tcpServer.on('error', fail);
      route.proxy.udpSocket.on('error', fail);
      route.cancel = () => { if (!settled) fail(new Error('TS2 router closed')); };
      try {
        route.proxy.tcpServer.listen(options.port, address, listening);
        route.proxy.udpSocket.bind(options.port, address, listening);
      } catch (err) { fail(err); }
    });
    return route.ready;
  }

  return {
    getEndpoint,
    getServer: () => active?.host || '',
    getTarget: () => activeTarget || { host: '', port: options.port },
    stopVoiceDecoder() { for (const route of routes.values()) route.proxy.stopVoiceDecoder(); },
    resetUdpClients(reason) {
      clearActive(reason);
      for (const route of routes.values()) route.proxy.resetUdpClients(reason);
    },
    close() {
      closed = true;
      clearActive('voice router closed');
      for (const route of routes.values()) {
        route.cancel?.();
        route.proxy.close('voice router closed');
      }
    },
  };
}

module.exports = { createTs2VoiceRouter };
