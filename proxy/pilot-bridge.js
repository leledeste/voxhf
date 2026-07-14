'use strict';

const net = require('net');
const { writeIfOpen, destroyIfOpen } = require('./socket-utils');
const {
  makeCoreFrame,
  loopbackSameLength,
  extractCoreTextPayloads,
  parseComToken,
  normalizeComCandidate,
} = require('./pilot-core');

function createPilotBridge(options) {
  // The 4827 bridge sits between PilotUI and PilotCore. It forwards the binary
  // protocol unchanged except for the login-time FSD server address, which is
  // rewritten to the local proxy so VoxHF can observe IVAO traffic.
  const pilotCoreHost = options.pilotCoreHost;
  const port = options.port;
  const fsdPort = options.fsdPort || 6809;
  const logger = options.logger || console;

  let pilotUiSocket = null;
  let pilotCoreControlSocket = null;

  function learnCallsignFromText(text) {
    // PilotUI login payloads contain "CALLSIGN|VID|...". We only report the
    // callsign; ownership of the current callsign remains in proxy.js.
    const match = String(text || '').match(/([A-Z0-9-]{2,10})\|\d{4,7}\|/);
    if (match) options.onCallsign?.(match[1]);
  }

  function learnComFrequency(data) {
    // PilotUI sends COM changes as binary packets on 4827. Reading them keeps
    // the webapp labels in sync even when the frequency changed outside
    // VoxHF.
    for (let i = 0; i + 10 < data.length; i++) {
      if (data[i] !== 0x07 || data[i + 4] !== 0x20 || data[i + 5] !== 0x20) continue;
      const com = data[i + 6];
      if (com !== 1 && com !== 2) continue;
      const khz = data.readUIntLE(i + 7, 3);
      if (khz < 118000 || khz > 137000) continue;
      options.onComFrequency?.(com, khz / 1000);
    }

    // Startup state can also arrive as framed text payloads. Parse only
    // payloads that explicitly pair a COM index with a VHF frequency.
    for (const payload of extractCoreTextPayloads(data)) {
      learnComFrequencyFromText(payload);
    }
  }

  function learnComFrequencyFromText(text) {
    const value = String(text || '').trim();
    if (!value) return;

    const freqPattern = '(1[1-3]\\d(?:[.,]\\d{1,3}|\\d{3})|\\d{5})';
    const named = new RegExp(`\\b(?:COM|COMM|RADIO)\\s*([12])\\b[^0-9]{0,24}${freqPattern}`, 'i').exec(value);
    if (named) {
      options.onComFrequency?.(Number(named[1]), normalizeComCandidate(named[2]));
      return;
    }

    const reversed = new RegExp(`${freqPattern}[^A-Z0-9]{0,24}\\b(?:COM|COMM|RADIO)\\s*([12])\\b`, 'i').exec(value);
    if (reversed) {
      options.onComFrequency?.(Number(reversed[2]), normalizeComCandidate(reversed[1]));
      return;
    }

    const tokens = value.split(/[|;,=\s]+/).filter(Boolean);
    for (let i = 0; i + 1 < tokens.length; i++) {
      const com = parseComToken(tokens[i]);
      if (!com) continue;
      const freq = normalizeComCandidate(tokens[i + 1]);
      if (freq) options.onComFrequency?.(com, freq);
    }
  }

  function rewriteFsdHost(data) {
    // PilotCore receives a remote FSD server during login. Replace it with a
    // 127.x.x.x address of the same length to avoid changing the packet size.
    const text = data.toString('latin1');
    const pattern = new RegExp(`(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})\\|${fsdPort}`, 'g');
    const modified = text.replace(pattern, (match, ip) => {
      if (ip.startsWith('127.')) return match;
      options.onFsdHost?.(ip);
      learnCallsignFromText(text);
      logger.log(`[4827] FSD ${ip} -> 127.0.0.1`);
      return `${loopbackSameLength(ip.length)}|${fsdPort}`;
    });

    return modified === text ? data : Buffer.from(modified, 'latin1');
  }

  const server = net.createServer((uiSocket) => {
    // Each PilotUI connection gets one paired PilotCore connection. Closing one
    // side destroys the other, which keeps Altitude from waiting on stale TCP
    // sessions after reconnects.
    pilotUiSocket = uiSocket;
    logger.log(`[4827] PilotUI connected from ${uiSocket.remoteAddress}`);

    const coreSocket = net.createConnection({ host: pilotCoreHost, port }, () => {
      pilotCoreControlSocket = coreSocket;
      logger.log(`[4827] Connected to PilotCore ${pilotCoreHost}:${port}`);
    });

    uiSocket.on('data', (data) => {
      learnComFrequency(data);
      writeIfOpen(coreSocket, rewriteFsdHost(data));
    });

    coreSocket.on('data', (data) => {
      learnComFrequency(data);
      writeIfOpen(uiSocket, data);
    });

    uiSocket.on('close', () => {
      destroyIfOpen(coreSocket);
      if (pilotUiSocket === uiSocket) pilotUiSocket = null;
    });
    coreSocket.on('close', () => {
      destroyIfOpen(uiSocket);
      if (pilotCoreControlSocket === coreSocket) pilotCoreControlSocket = null;
    });
    uiSocket.on('error', (err) => logger.error('[4827] UI:', err.message));
    coreSocket.on('error', (err) => {
      logger.error('[4827] PilotCore:', err.message);
      destroyIfOpen(uiSocket);
    });
  });

  function sendToCore(buf) {
    // Webapp commands reuse the live PilotCore socket learned by the bridge.
    return writeIfOpen(pilotCoreControlSocket, buf);
  }

  function setTxLamp(com, active) {
    // Web TX sends audio directly through TS2, so PilotUI needs synthetic
    // feedback to light its TX indicator just like a real PTT press.
    const radio = com === 2 ? 2 : 1;
    return writeIfOpen(pilotUiSocket, makeCoreFrame(0xdde53000, `${radio}|${active ? 1 : 0}|0|0`));
  }

  return {
    server,
    sendToCore,
    setTxLamp,
  };
}

module.exports = {
  createPilotBridge,
};
