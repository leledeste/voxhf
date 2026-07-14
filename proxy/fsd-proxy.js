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
  const pendingWeatherRequests = new Map();

  const server = net.createServer((coreSocket) => {
    const sessionId = ++activeSessionId;
    fsdCoreSocket = coreSocket;
    state.setConnected(true);

    const host = options.getHost();
    logger.log(`[6809] PilotCore -> ${host}:${port}`);

    const remote = net.createConnection({ host, port }, () => {
      if (sessionId !== activeSessionId) return destroyIfOpen(remote);
      ivaoSocket = remote;
      logger.log('[6809] Connected to IVAO');
    });

    const coreBuf = { text: '' };
    const remoteBuf = { text: '' };

    coreSocket.on('data', (data) => {
      parseLines(coreBuf, data, (line) => handleFsdLine(line, 'outgoing'));
      writeIfOpen(remote, data);
    });

    remote.on('data', (data) => {
      parseLines(remoteBuf, data, (line) => handleFsdLine(line, 'incoming'));
      writeIfOpen(coreSocket, rewriteVoiceServer(data));
    });

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
      options.onVoiceServer(msg.ts2Server);
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
    // FSD VOICE replies contain "host/channel". Replacing the host with LAN_IP
    // keeps the channel intact while steering Altitude's TS2 connection through
    // the local UDP proxy.
    const text = data.toString('utf8');
    if (!text.includes(':VOICE:')) return data;

    const changed = text.replace(/(\$CR[^:]+:[^:]+:VOICE:[^:]+:)([^/\r\n]+)(\/[^\r\n]*)/g, (match, prefix, serverHost, channel) => {
      const lanIp = options.getLanIp();
      if (serverHost === lanIp) return match;
      options.onVoiceServer(serverHost);
      logger.log(`[TS2] Voice server ${serverHost} -> ${lanIp}`);
      return prefix + lanIp + channel;
    });

    return changed === text ? data : Buffer.from(changed, 'utf8');
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

    activeSessionId = 0;
    fsdCoreSocket = null;
    ivaoSocket = null;
    state.setConnected(false);
    options.onClose?.();
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
