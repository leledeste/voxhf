'use strict';

const net = require('net');
const { writeIfOpen, destroyIfOpen } = require('./socket-utils');
const {
  makeCoreFrame,
  makeFreqPacket,
  makeSquawkPacket,
  makeV114FreqPacket,
  makeV114SquawkPacket,
  makeV114XpdrTogglePacket,
  makeV114IdentPacket,
  makeV114RadioVolumePacket,
  makeV114CoreEventFrame,
  createMessagePackFrameReader,
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
  let pilotProtocol = 'legacy';
  let loggedMessagePackVersion = '';

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

  function observeMessagePack(message, direction) {
    if (!Array.isArray(message) || message.length !== 2 || !Number.isInteger(message[0])) return;
    const [type, payload] = message;
    pilotProtocol = 'messagepack';

    if (options.tracePilotCommands && direction === 'ui-to-core'
      && (type === 0x1601 || type === 0x1602)) {
      logger.log(`[XPDR TRACE] PilotUI -> PilotCore type=0x${type.toString(16)} payload=${JSON.stringify(payload)}`);
    }

    // Altitude 1.14 transports VHF volume changes through the generic core
    // event envelope. Trace only the validated "radio|volume" value: dumping
    // arbitrary bridge payloads could expose credentials, chat or flight data.
    if (options.tracePilotAudio && type === 0x3000 && Array.isArray(payload)
      && payload[0] === 0xdde6 && typeof payload[1] === 'string') {
      const match = payload[1].match(/^([12])\|(\d{1,3})$/);
      if (match && Number(match[2]) <= 100) {
        logger.log(`[AUDIO TRACE] ${direction} VHF${match[1]} volume=${Number(match[2])}`);
      }
    }

    if (direction === 'core-to-ui' && type === 0x2000 && Array.isArray(payload)) {
      const version = typeof payload[2] === 'string' ? payload[2] : '1.14+';
      if (version !== loggedMessagePackVersion) {
        loggedMessagePackVersion = version;
        logger.log(`[4827] Altitude MessagePack protocol detected (${version}).`);
      }
    }

    if (direction === 'ui-to-core' && type === 0x1800 && Array.isArray(payload)) {
      const com = Number(payload[0]);
      const khz = Number(payload[1]);
      if ((com === 1 || com === 2) && Number.isInteger(khz) && khz >= 118000 && khz <= 137000) {
        options.onComFrequency?.(com, khz / 1000);
      }
    }

    if (type === 0x3000 && Array.isArray(payload) && typeof payload[1] === 'string') {
      learnComFrequencyFromText(payload[1]);
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
    const trace = options.routeTrace;
    trace?.event('tcp-open', { transport: 'pilot', stream: trace.id(uiSocket) });
    // Each PilotUI connection gets one paired PilotCore connection. Closing one
    // side destroys the other, which keeps Altitude from waiting on stale TCP
    // sessions after reconnects.
    pilotUiSocket = uiSocket;
    pilotProtocol = 'legacy';
    loggedMessagePackVersion = '';
    logger.log(`[4827] PilotUI connected from ${uiSocket.remoteAddress}`);

    const readUiMessages = createMessagePackFrameReader(message => {
      observeMessagePack(message, 'ui-to-core');
    });
    const readCoreMessages = createMessagePackFrameReader(message => {
      observeMessagePack(message, 'core-to-ui');
    });

    const coreSocket = net.createConnection({ host: pilotCoreHost, port }, () => {
      pilotCoreControlSocket = coreSocket;
      logger.log(`[4827] Connected to PilotCore ${pilotCoreHost}:${port}`);
    });

    uiSocket.on('data', (data) => {
      trace?.packet('pilot', 'out', uiSocket, data);
      readUiMessages(data);
      learnComFrequency(data);
      writeIfOpen(coreSocket, rewriteFsdHost(data));
    });

    coreSocket.on('data', (data) => {
      trace?.packet('pilot', 'in', uiSocket, data);
      readCoreMessages(data);
      learnComFrequency(data);
      writeIfOpen(uiSocket, data);
    });

    uiSocket.on('close', () => {
      trace?.event('tcp-close', { transport: 'pilot', stream: trace.id(uiSocket) });
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

  function setCom(com, freq) {
    const packet = pilotProtocol === 'messagepack'
      ? makeV114FreqPacket(com, freq)
      : makeFreqPacket(com, freq);
    return sendToCore(packet);
  }

  function setSquawk(code) {
    const packet = pilotProtocol === 'messagepack'
      ? makeV114SquawkPacket(code)
      : makeSquawkPacket(code);
    return sendToCore(packet);
  }

  function toggleXpdr() {
    const packet = pilotProtocol === 'messagepack'
      ? makeV114XpdrTogglePacket()
      : Buffer.from([0x03, 0, 0, 0, 0x01, 0x20, 0]);
    const sent = sendToCore(packet);
    if (options.tracePilotCommands) logger.log(`[XPDR TRACE] VoxHF -> PilotCore action=toggle sent=${sent}`);
    return sent;
  }

  function sendIdent() {
    const packet = pilotProtocol === 'messagepack'
      ? makeV114IdentPacket()
      : Buffer.from([0x03, 0, 0, 0, 0x02, 0x20, 0]);
    const sent = sendToCore(packet);
    if (options.tracePilotCommands) logger.log(`[XPDR TRACE] VoxHF -> PilotCore action=ident sent=${sent}`);
    return sent;
  }

  function setRadioVolume(com, volume) {
    // The Connector path is currently observed only on the MessagePack-based
    // Altitude 1.14 bridge. Update PilotCore and mirror the event to PilotUI so
    // its slider reflects the same value. This is a one-shot initialization;
    // later user adjustments remain untouched.
    if (pilotProtocol !== 'messagepack') return false;
    let packet;
    try {
      packet = makeV114RadioVolumePacket(com, volume);
    } catch {
      return false;
    }
    const sent = sendToCore(packet);
    if (sent) writeIfOpen(pilotUiSocket, packet);
    return sent;
  }

  function setTxLamp(com, active) {
    // Web TX sends audio directly through TS2, so PilotUI needs synthetic
    // feedback to light its TX indicator just like a real PTT press.
    const radio = com === 2 ? 2 : 1;
    const payload = `${radio}|${active ? 1 : 0}|0|0`;
    const packet = pilotProtocol === 'messagepack'
      ? makeV114CoreEventFrame(0xdde5, payload)
      : makeCoreFrame(0xdde53000, payload);
    return writeIfOpen(pilotUiSocket, packet);
  }

  return {
    server,
    sendToCore,
    setCom,
    setSquawk,
    toggleXpdr,
    sendIdent,
    setRadioVolume,
    setTxLamp,
    getProtocol: () => pilotProtocol,
  };
}

module.exports = {
  createPilotBridge,
};
