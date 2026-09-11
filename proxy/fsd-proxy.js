'use strict';

const net = require('net');
const { writeIfOpen, destroyIfOpen, isSocketOpen } = require('./socket-utils');
const {
  parseFsdLine,
  parseLines,
  publicFsdEvent,
  normalizeFsdRecipient,
  normalizeFsdText,
} = require('./fsd-parser');

const WEATHER_PENDING_TTL_MS = 2 * 60 * 1000;
// FSD messages are small, newline-delimited records. Bound the pending record
// rather than letting a missing delimiter grow memory for the whole session.
const MAX_REMOTE_LINE_BYTES = 64 * 1024;
const MAX_PENDING_BYTES = 1024 * 1024;

function createFsdProxy(options) {
  // PilotCore thinks this is the IVAO FSD server. The proxy forwards to the
  // real server, parses useful text lines, and rewrites VOICE replies so TS2
  // traffic also passes through VoxHF.
  const port = options.port || 6809;
  const logger = options.logger || console;
  const state = options.state;

  let ivaoSocket = null;
  let fsdCoreSocket = null;
  let activeSessionId = 0;
  let confirmedIvaoSessionId = 0;
  const pendingWeatherRequests = new Map();

  const server = net.createServer((coreSocket) => {
    const sessionId = ++activeSessionId;
    fsdCoreSocket = coreSocket;
    state.resetFlightTelemetry?.();
    state.setConnected(true);

    const host = options.getHost();
    logger.log(`[6809] PilotCore -> ${host}:${port}`);

    const remote = net.createConnection({ host, port }, () => {
      if (sessionId !== activeSessionId) return destroyIfOpen(remote);
      ivaoSocket = remote;
      confirmedIvaoSessionId = sessionId;
      logger.log('[6809] Connected to IVAO');
      options.onConnected?.();
    });

    const coreBuf = { text: '' };
    let remotePending = Buffer.alloc(0);
    let waitingForEndpoint = false;

    coreSocket.on('data', (data) => {
      parseLines(coreBuf, data, (line) => handleFsdLine(line, 'outgoing'));
      writeIfOpen(remote, data);
    });

    remote.on('data', (data) => {
      // TCP data events can split anywhere, including inside a VOICE hostname.
      // Parse and rewrite the same complete record before forwarding any of it.
      // Keep bytes intact: unrelated traffic and CRLF/LF delimiters must not be
      // changed by decoding and re-encoding the stream.
      remotePending = remotePending.length ? Buffer.concat([remotePending, data]) : data;
      // pause() normally stops more chunks while an endpoint binds. Also cap
      // already queued input and nonstandard socket implementations.
      if (waitingForEndpoint) {
        if (remotePending.length > MAX_PENDING_BYTES) rejectOversizedLine('pending FSD input exceeds the 1 MiB limit');
        return;
      }
      drainRecords();
    });

    function drainRecords() {
      if (sessionId !== activeSessionId || coreSocket.destroyed || remote.destroyed) return;
      const received = remotePending;
      let start = 0;
      let end;
      while ((end = received.indexOf(0x0a, start)) !== -1) {
        if (end - start > MAX_REMOTE_LINE_BYTES) return rejectOversizedLine();
        const record = received.subarray(start, end + 1);
        const line = record.subarray(0, record.length - 1).toString('utf8');
        if (line.trim()) handleFsdLine(line, 'incoming');
        let rewritten;
        try { rewritten = rewriteVoiceServer(record); }
        catch (err) { logger.error(`[TS2] VOICE reply withheld: ${err.message}`); }
        start = end + 1;
        if (rewritten && typeof rewritten.then === 'function') {
          remotePending = Buffer.from(received.subarray(start));
          if (remotePending.length > MAX_PENDING_BYTES) {
            // Consume a possible rejected preparation promise before closing.
            rewritten.catch(() => {});
            return rejectOversizedLine('pending FSD input exceeds the 1 MiB limit');
          }
          waitingForEndpoint = true;
          remote.pause?.();
          rewritten.then(bytes => {
            if (sessionId === activeSessionId && bytes) writeIfOpen(coreSocket, bytes);
          }).catch(err => {
            // A failed local listener must not bypass VoxHF or disconnect the
            // flight. Drop only this VOICE reply and keep chat/FSD working.
            logger.error(`[TS2] VOICE reply withheld: ${err.message}`);
          }).finally(() => {
            waitingForEndpoint = false;
            drainRecords();
            if (!waitingForEndpoint && sessionId === activeSessionId) remote.resume?.();
          });
          return;
        }
        if (rewritten) writeIfOpen(coreSocket, rewritten);
      }
      if (received.length - start > MAX_REMOTE_LINE_BYTES) return rejectOversizedLine();
      // Copy only the unfinished tail; do not retain the complete TCP buffer.
      remotePending = Buffer.from(received.subarray(start));
    }

    function rejectOversizedLine(reason = 'FSD line exceeds the 64 KiB limit') {
      remotePending = Buffer.alloc(0);
      logger.error(`[6809] IVAO: ${reason}; closing connection.`);
      close(sessionId, coreSocket, remote);
    }

    coreSocket.on('close', () => close(sessionId, coreSocket, remote));
    remote.on('close', () => close(sessionId, coreSocket, remote));
    coreSocket.on('error', (err) => logger.error('[6809] Core:', err.message));
    remote.on('error', (err) => logger.error('[6809] IVAO:', err.message));
  });

  function handleFsdLine(line, direction) {
    // Every parsed FSD event is broadcast to the browser. Some events also
    // update backend state, for example the real TS2 host announced by a VOICE
    // reply.
    if (!state.getConnected()) {
      // If FSD data is flowing, Altitude is effectively connected. This protects
      // the UI from stale close events emitted by an older TCP pair.
      state.setConnected(true);
    }

    const msg = parseFsdLine(line, direction);
    if (!msg) return;
    msg.direction = direction;

    if (direction === 'outgoing' && msg.kind === 'atc_detected' && line.startsWith('$CQ')) {
      options.routeTrace?.event('fsd-query', { station: msg.callsign });
    }

    const callsign = state.getCallsign();
    if (msg.kind === 'login' && (!callsign || msg.callsign === callsign)) {
      state.setCallsign(msg.callsign, false);
    }

    if (msg.kind === 'flight_plan_status') {
      state.updateFlightPlanStatus(msg.status, msg.flightPlan);
      return;
    }

    state.rememberFsdState(msg);

    if (msg.kind === 'message' && handleWeatherReply(msg)) return;

    if (msg.kind === 'atc_voice_info') {
      options.routeTrace?.event('fsd-reply', { station: msg.atc, host: msg.ts2Server });
      logger.log(`[TS2] ${msg.atc} -> ${msg.ts2Server}/${msg.channelName}`);
    }

    if (msg.kind === 'login' && msg.callsign === state.getCallsign()) {
      state.setConnected(true);
    }

    const publicMsg = publicFsdEvent(msg);
    state.broadcast(publicMsg);
    if (msg.kind === 'message') logFsdMessageSummary(publicMsg, direction);
  }

  function logFsdMessageSummary(msg, direction) {
    // Keep console output useful without logging chat contents or raw protocol
    // lines. Full message text remains visible only in the browser UI.
    const label = direction === 'outgoing' ? 'OUT' : 'IN ';
    const type = msg.type || 'message';
    const sender = msg.sender || 'SERVER';
    const recipient = msg.recipient ? ` -> ${msg.recipient}` : '';
    logger.log(`[${label}] ${type} ${sender}${recipient}`);
  }

  function rewriteVoiceServer(data) {
    // Preserve distinct servers through distinct local endpoints. A VOICE
    // discovery reply must never select or reset the active voice session.
    // Match ASCII protocol fields with a reversible byte-to-string mapping so
    // replacing a host never corrupts non-ASCII bytes elsewhere in the record.
    const text = data.toString('latin1');
    if (!text.includes(':VOICE:')) return data;

    const match = /^(\$CR[^:]+:[^:]+:VOICE:[^:]+:)([^/\r\n]+)(\/[^\r\n]*)/.exec(text);
    if (!match) return data;
    const endpoint = options.getVoiceEndpoint(match[2]);
    const replace = address => Buffer.from(match[1] + address + match[3] + text.slice(match[0].length), 'latin1');
    return endpoint && typeof endpoint.then === 'function' ? endpoint.then(replace) : replace(endpoint);
  }

  function close(sessionId, coreSocket, remoteSocket) {
    // FSD close is the clean boundary for an IVAO session. Voice decoding is
    // tied to that session, so the caller can stop it here as well.
    destroyIfOpen(coreSocket);
    destroyIfOpen(remoteSocket);

    // Old TCP pairs can close after PilotCore has already opened a replacement
    // FSD connection. Do not let that stale close mark the current session as
    // disconnected.
    if (sessionId !== activeSessionId) return;

    const wasConnected = confirmedIvaoSessionId === sessionId;
    activeSessionId = 0;
    confirmedIvaoSessionId = 0;
    fsdCoreSocket = null;
    ivaoSocket = null;
    state.setConnected(false);
    options.onClose?.({ wasConnected });
  }

  function sendChatCommand(cmd, reportError = () => {}) {
    // Remote and local chat share one implementation. The caller only decides
    // how errors are reported: local UI message or remote-agent console warning.
    if (!isSocketOpen(ivaoSocket)) {
      reportError('Not connected to IVAO');
      return false;
    }

    const cs = state.getCallsign() || cmd.callsign;
    if (!cs) {
      reportError('No callsign detected');
      return false;
    }

    const recipient = normalizeFsdRecipient(cmd.recipient || '@22800');
    const text = normalizeFsdText(cmd.text);
    if (!recipient) {
      reportError('Invalid message recipient');
      return false;
    }
    if (!text) return false;

    const line = `#TM${cs}:${recipient}:${text}\n`;
    ivaoSocket.write(line);
    writeIfOpen(fsdCoreSocket, line);

    state.broadcast({
      kind: 'message',
      type: recipient === '*' ? 'broadcast' : recipient.startsWith('@') ? 'frequency' : 'private',
      sender: cs,
      recipient,
      text,
      direction: 'outgoing',
      timestamp: options.timestamp(),
    });
    return true;
  }

  function sendWeatherRequest(kind, icao, reportError = () => {}, meta = {}) {
    // Weather requests stay typed in remote mode and are translated to the IVAO
    // FSD &D form only inside the local agent.
    const cs = state.getCallsign();
    if (!cs) {
      reportError('No callsign detected');
      return false;
    }
    const code = String(icao || '').trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) {
      reportError('Invalid ICAO code');
      return false;
    }
    const type = kind === 'taf' ? 1 : 0;
    const ok = writeFsdLine(`&D${cs}:SERVER:${type}:${code}`, reportError);
    if (ok) rememberPendingWeatherRequest(type === 1 ? 'taf' : 'metar', code, meta);
    return ok;
  }

  function sendAtisRequest(callsign, reportError = () => {}) {
    // ATIS is also a typed remote request. The raw $CQ line is generated only
    // at the agent boundary where the IVAO connection exists.
    const cs = state.getCallsign();
    if (!cs) {
      reportError('No callsign detected');
      return false;
    }
    const station = String(callsign || '').trim().toUpperCase();
    if (!/^[A-Z0-9_]{2,32}$/.test(station)) {
      reportError('Invalid ATIS callsign');
      return false;
    }
    return writeFsdLine(`$CQ${cs}:${station}:ATIS`, reportError);
  }

  function writeFsdLine(line, reportError = () => {}) {
    if (/[\r\n]/.test(String(line))) {
      reportError('Invalid FSD command');
      return false;
    }
    if (!isSocketOpen(ivaoSocket)) {
      reportError('Not connected to IVAO');
      return false;
    }
    ivaoSocket.write(`${line}\n`);
    return true;
  }

  function rememberPendingWeatherRequest(kind, icao, meta = {}) {
    cleanupPendingWeatherRequests();
    const key = weatherKey(kind, icao);
    const list = pendingWeatherRequests.get(key) || [];
    list.push({
      source: normalizeWeatherRequestSource(meta.source),
      role: meta.role === 'destination' ? 'destination' : meta.role === 'departure' ? 'departure' : '',
      requestedAt: Date.now(),
    });
    pendingWeatherRequests.set(key, list.slice(-8));
  }

  function handleWeatherReply(msg) {
    const parsed = parseWeatherReply(msg);
    if (!parsed) return false;
    cleanupPendingWeatherRequests();

    const key = weatherKey(parsed.kind, parsed.icao);
    const list = pendingWeatherRequests.get(key) || [];
    const manualIndex = list.findIndex((item) => item.source === 'manual');
    const panelIndex = list.findIndex((item) => item.source !== 'manual');

    if (manualIndex >= 0) {
      list.splice(manualIndex, 1);
      const nextPanelIndex = list.findIndex((item) => item.source !== 'manual');
      if (nextPanelIndex >= 0) updateWeatherPanel(parsed, list.splice(nextPanelIndex, 1)[0]);
      savePendingWeatherList(key, list);
      return false;
    }

    if (panelIndex >= 0) {
      const request = list.splice(panelIndex, 1)[0];
      savePendingWeatherList(key, list);
      updateWeatherPanel(parsed, request);
      return true;
    }

    return false;
  }

  function updateWeatherPanel(parsed, request = {}) {
    const role = request.role || state.roleForWeatherIcao?.(parsed.icao) || '';
    if (!role) return false;
    return state.updateWeather(role, parsed.kind, parsed.icao, parsed.text);
  }

  function parseWeatherReply(msg) {
    const sender = String(msg.sender || '').toUpperCase();
    const kind = sender === 'TAF' ? 'taf' : sender === 'METAR' ? 'metar' : '';
    if (!kind) return null;
    const icao = readWeatherIcao(kind, msg.text);
    if (!icao) return null;
    return { kind, icao, text: String(msg.text || '').trim() };
  }

  function readWeatherIcao(kind, text) {
    const tokens = String(text || '').replace(/=$/, '').trim().split(/\s+/);
    let index = 0;
    if (kind === 'metar' && /^(METAR|SPECI)$/i.test(tokens[index] || '')) index += 1;
    if (kind === 'metar' && /^COR$/i.test(tokens[index] || '')) index += 1;
    if (kind === 'taf' && /^TAF$/i.test(tokens[index] || '')) index += 1;
    if (kind === 'taf' && /^(AMD|COR)$/i.test(tokens[index] || '')) index += 1;
    const candidate = String(tokens[index] || '').toUpperCase();
    return /^[A-Z]{4}$/.test(candidate) ? candidate : '';
  }

  function cleanupPendingWeatherRequests() {
    const cutoff = Date.now() - WEATHER_PENDING_TTL_MS;
    for (const [key, list] of pendingWeatherRequests.entries()) {
      savePendingWeatherList(key, list.filter((item) => item.requestedAt >= cutoff));
    }
  }

  function savePendingWeatherList(key, list) {
    if (list.length) pendingWeatherRequests.set(key, list);
    else pendingWeatherRequests.delete(key);
  }

  function normalizeWeatherRequestSource(value) {
    return value === 'panel' || value === 'auto' ? value : 'manual';
  }

  function weatherKey(kind, icao) {
    return `${kind === 'taf' ? 'taf' : 'metar'}:${String(icao || '').toUpperCase()}`;
  }

  return {
    server,
    sendChatCommand,
    sendWeatherRequest,
    sendAtisRequest,
    writeFsdLine,
    isConnected: () => isSocketOpen(ivaoSocket),
  };
}

module.exports = {
  createFsdProxy,
};
