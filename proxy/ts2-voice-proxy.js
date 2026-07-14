'use strict';

const net = require('net');
const dns = require('dns');
const dgram = require('dgram');
const { spawn } = require('child_process');
const { OggSpeexWriter } = require('./ogg-speex');
const { writeIfOpen, destroyIfOpen, safeEnd } = require('./socket-utils');

const CLASS_SVOICE = 0xBEF0;
const CLASS_TXVOICE = 0xBEF2;
const CLASS_RXVOICE = 0xBEF3;
const SUBTYPE_VOICE = 0x0C00;
const RX_HEADER_BYTES = 22;
const RX_LOG_IDLE_MS = 900;
const DIAG_HEAD_BYTES = 96;
const DIAG_TCP_PACKETS_PER_DIRECTION = 32;
const DIAG_UDP_SETUP_PACKETS_PER_DIRECTION = 80;
const DIAG_UDP_VOICE_PACKETS_PER_DIRECTION = 12;

function createTs2VoiceProxy(options) {
  // This module owns the TS2 side of VoxHF: TCP pass-through, UDP
  // forwarding, RX Speex decoding, and the side tap used by the browser.
  const config = options.config || {};
  const port = options.port;
  const logger = options.logger || console;
  const sampleRate = Number(config.voiceSampleRate) || 32000;
  const stripBytes = Number(config.voiceStripBytes) || 1;
  const framesPerPacket = Number(config.voiceFramesPerPacket) || 12;
  const diagnostics = config.voiceDiagnostics === true;
  const udpClients = new Map();
  const udpDiagStates = new Map();

  let realServer = options.initialServer || 'ts-1.eu-west-2.ivao.aero';
  let realIp = null;
  let voiceWriter = null;
  let voiceFfmpeg = null;
  let rxLogTimer = null;
  let rxStats = emptyRxStats();
  let tcpDiagId = 0;

  function emptyRxStats() {
    return {
      packets: 0,
      speexBytes: 0,
      pcmChunks: 0,
      pcmBytes: 0,
    };
  }

  function scheduleRxLog() {
    clearTimeout(rxLogTimer);
    rxLogTimer = setTimeout(flushRxStats, RX_LOG_IDLE_MS);
  }

  function flushRxStats() {
    clearTimeout(rxLogTimer);
    rxLogTimer = null;
    if (!diagnostics) {
      rxStats = emptyRxStats();
      return;
    }
    if (!rxStats.packets && !rxStats.pcmChunks) return;
    logger.log(
      `[VOICE RX] packets=${rxStats.packets} speex=${rxStats.speexBytes} `
      + `pcmChunks=${rxStats.pcmChunks} pcm=${rxStats.pcmBytes} decoder=${voiceFfmpeg ? 'active' : 'stopped'}`
    );
    rxStats = emptyRxStats();
  }

  function resolveServer() {
    // UDP forwarding can use the hostname directly, but resolving once keeps
    // logs clearer and avoids repeated DNS work while voice packets are flowing.
    dns.resolve4(realServer, (err, addrs) => {
      if (!err && addrs[0]) realIp = addrs[0];
    });
  }

  function setServer(server) {
    const next = String(server || '').trim();
    if (!next) return realServer;
    if (next !== realServer) {
      realServer = next;
      realIp = null;
    }
    resolveServer();
    return realServer;
  }

  function getServer() {
    return realServer;
  }

  function getTarget() {
    return {
      host: realIp || realServer,
      port,
    };
  }

  function startVoiceDecoder() {
    // RX decoding is lazy. The ffmpeg process starts only when the first voice
    // packet arrives and stays alive until FSD disconnects.
    if (!config.voiceDecode || voiceFfmpeg) return;

    voiceWriter = new OggSpeexWriter(sampleRate, framesPerPacket);
    voiceFfmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'ogg', '-i', 'pipe:0',
      '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1',
    ]);

    voiceFfmpeg.stdin.on('error', () => {});
    voiceFfmpeg.stdout.on('data', (pcm) => {
      rxStats.pcmChunks += 1;
      rxStats.pcmBytes += pcm.length;
      scheduleRxLog();
      options.onPcm?.(pcm);
    });
    voiceFfmpeg.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (diagnostics && text) logger.warn(`[VOICE ffmpeg] ${text}`);
    });
    voiceFfmpeg.on('exit', (code, signal) => {
      flushRxStats();
      if (code !== 0 && code !== null) logger.warn(`[VOICE] RX decoder exited code=${code} signal=${signal || ''}`);
      voiceFfmpeg = null;
      voiceWriter = null;
    });
    voiceFfmpeg.stdin.write(voiceWriter.headers());
    if (diagnostics) logger.log('[VOICE] RX decoder active');
  }

  function stopVoiceDecoder() {
    // Stopping the decoder on disconnect prevents stale PCM from being
    // delivered after the simulator has already reconnected.
    flushRxStats();
    if (voiceFfmpeg) safeEnd(voiceFfmpeg.stdin);
    voiceFfmpeg = null;
    voiceWriter = null;
  }

  function decodeIncomingVoice(payload) {
    // TS2 voice packets contain a small protocol prefix before the Speex bytes.
    // voiceStripBytes is configurable because packet variants observed during
    // testing differed by a byte.
    if (!config.voiceDecode) return;
    startVoiceDecoder();
    if (!voiceFfmpeg || !voiceWriter) return;

    const speex = payload.slice(stripBytes);
    if (speex.length) {
      rxStats.packets += 1;
      rxStats.speexBytes += speex.length;
      scheduleRxLog();
      voiceFfmpeg.stdin.write(voiceWriter.frame(speex));
    }
  }

  function packetFields(buffer) {
    // TS2 packets use little-endian class/subtype fields in the UDP traffic we
    // have observed. TCP chunks may not align to packet boundaries, but logging
    // the same fields still helps locate repeated session bytes.
    const cls = buffer.length >= 2 ? buffer.readUInt16LE(0) : 0;
    const subtype = buffer.length >= 4 ? buffer.readUInt16LE(2) : 0;
    const seq = buffer.length >= 16 ? buffer.readUInt32LE(12) : null;
    const h4_11 = buffer.length >= 12 ? toHex(buffer.slice(4, 12)) : '';
    const h12_19 = buffer.length >= 20 ? toHex(buffer.slice(12, 20)) : '';
    const h16_23 = buffer.length >= 24 ? toHex(buffer.slice(16, 24)) : '';
    return { cls, subtype, seq, h4_11, h12_19, h16_23 };
  }

  function toHex(buffer) {
    return Array.from(buffer).map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
  }

  function asciiPreview(buffer) {
    return Array.from(buffer.slice(0, DIAG_HEAD_BYTES))
      .map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.'))
      .join('');
  }

  function logTs2Diagnostic(label, direction, count, buffer, extra = '') {
    if (!diagnostics) return;
    const fields = packetFields(buffer);
    const seq = fields.seq === null ? '-' : fields.seq;
    logger.log(
      `[TS2 ${label}] #${count} ${direction} len=${buffer.length} `
      + `class=0x${fields.cls.toString(16).padStart(4, '0')} `
      + `sub=0x${fields.subtype.toString(16).padStart(4, '0')} `
      + `h4_11=${fields.h4_11 || '-'} h12_19=${fields.h12_19 || '-'} `
      + `h16_23=${fields.h16_23 || '-'} seq=${seq}${extra ? ` ${extra}` : ''} `
      + `head=${toHex(buffer.slice(0, DIAG_HEAD_BYTES))} ascii="${asciiPreview(buffer)}"`
    );
  }

  function getUdpDiagState(key) {
    let state = udpDiagStates.get(key);
    if (!state) {
      state = {
        c2sSetup: 0,
        c2sVoice: 0,
        s2cSetup: 0,
        s2cVoice: 0,
      };
      udpDiagStates.set(key, state);
    }
    return state;
  }

  function isVoiceLikePacket(buffer) {
    const { cls, subtype } = packetFields(buffer);
    if (cls === CLASS_TXVOICE) return true;
    return (cls === CLASS_RXVOICE || cls === CLASS_SVOICE) && subtype === SUBTYPE_VOICE;
  }

  function logUdpDiagnostic(key, direction, buffer) {
    if (!diagnostics) return;
    const state = getUdpDiagState(key);
    const voice = isVoiceLikePacket(buffer);
    const bucket = direction === 'client->server'
      ? (voice ? 'c2sVoice' : 'c2sSetup')
      : (voice ? 's2cVoice' : 's2cSetup');
    state[bucket] += 1;

    const max = voice ? DIAG_UDP_VOICE_PACKETS_PER_DIRECTION : DIAG_UDP_SETUP_PACKETS_PER_DIRECTION;
    if (state[bucket] > max) return;

    logTs2Diagnostic('UDP', direction, state[bucket], buffer, `key=${key} kind=${voice ? 'voice' : 'setup'}`);
  }

  // TCP is normally pass-through, but voiceDiagnostics can sample the initial
  // login/join stream to find the session bytes Altitude later uses for UDP TX.
  const tcpServer = net.createServer((client) => {
    const target = getTarget();
    const tcpId = ++tcpDiagId;
    const tcpDiag = { c2s: 0, s2c: 0 };
    const remote = net.createConnection({ host: target.host, port: target.port });
    client.on('data', (d) => {
      tcpDiag.c2s += 1;
      if (tcpDiag.c2s <= DIAG_TCP_PACKETS_PER_DIRECTION) {
        logTs2Diagnostic('TCP', 'client->server', tcpDiag.c2s, d, `tcp=${tcpId}`);
      }
      writeIfOpen(remote, d);
    });
    remote.on('data', (d) => {
      tcpDiag.s2c += 1;
      if (tcpDiag.s2c <= DIAG_TCP_PACKETS_PER_DIRECTION) {
        logTs2Diagnostic('TCP', 'server->client', tcpDiag.s2c, d, `tcp=${tcpId}`);
      }
      writeIfOpen(client, d);
    });
    client.on('close', () => destroyIfOpen(remote));
    remote.on('close', () => destroyIfOpen(client));
    client.on('error', () => destroyIfOpen(remote));
    remote.on('error', () => destroyIfOpen(client));
  });

  const udpSocket = dgram.createSocket('udp4');

  function cleanupUdpClient(key, remote, reason = '') {
    // UDP sockets represent one Altitude source-port session. If one closes or
    // errors, remove it from the map so future packets create a fresh socket
    // instead of reusing a dead route. Web TX can then clear any seed tied to
    // that old session.
    if (udpClients.get(key) !== remote) return;
    udpClients.delete(key);
    udpDiagStates.delete(key);
    options.onClientClose?.(key, reason);
  }

  function resetUdpClients(reason = 'TS2 UDP reset') {
    // FSD reconnects and voice-session resets can happen without changing the
    // TS2 hostname. Closing the UDP side sockets forces the next Altitude packet
    // to establish a clean path.
    for (const [key, remote] of Array.from(udpClients.entries())) {
      cleanupUdpClient(key, remote, reason);
      try { remote.close(); } catch (_) {}
    }
  }

  udpSocket.on('message', (msg, rinfo) => {
    // Each local Altitude UDP source gets a paired UDP socket to the real TS2
    // server. This preserves source-port based session behavior on both sides.
    const key = `${rinfo.address}:${rinfo.port}`;
    let remote = udpClients.get(key);

    if (!remote) {
      remote = dgram.createSocket('udp4');
      udpClients.set(key, remote);
      const target = getTarget();
      logger.log(`[TS2 UDP] ${key} -> ${target.host}:${target.port}`);

      remote.on('message', (reply) => {
        // Server replies are always forwarded to Altitude first. RX decoding is
        // a side tap for the webapp and must never block simulator audio.
        logUdpDiagnostic(key, 'server->client', reply);
        udpSocket.send(reply, rinfo.port, rinfo.address);
        const cls = reply.length >= 2 ? reply.readUInt16LE(0) : 0;
        const subtype = reply.length >= 4 ? reply.readUInt16LE(2) : 0;
        if (cls === CLASS_RXVOICE && subtype === SUBTYPE_VOICE && reply.length > RX_HEADER_BYTES) {
          decodeIncomingVoice(reply.slice(RX_HEADER_BYTES));
        } else if (cls === CLASS_SVOICE && subtype === SUBTYPE_VOICE && reply.length > 20) {
          decodeIncomingVoice(reply.slice(20));
        }
      });

      remote.on('close', () => cleanupUdpClient(key, remote, 'TS2 UDP socket closed'));
      remote.on('error', (err) => {
        logger.error('[TS2 UDP]', err.message);
        cleanupUdpClient(key, remote, 'TS2 UDP socket error');
        try { remote.close(); } catch (_) {}
      });
    }

    logUdpDiagnostic(key, 'client->server', msg);
    options.onClientPacket?.(msg, key, remote);
    const target = getTarget();
    remote.send(msg, target.port, target.host);
  });

  resolveServer();

  return {
    tcpServer,
    udpSocket,
    setServer,
    getServer,
    getTarget,
    stopVoiceDecoder,
    resetUdpClients,
  };
}

module.exports = {
  createTs2VoiceProxy,
};
