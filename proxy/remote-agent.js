'use strict';

const WebSocket = require('ws');
const {
  MESSAGE_TYPES,
  compareVersions,
  createRemoteMessage,
  parseRemoteJson,
} = require('../packages/protocol');

const RX_PCM_CHUNK_BYTES = 32 * 1024;
const TX_MAX_MS = 120 * 1000;

function createRemoteAgent(options) {
  // Remote mode is deliberately outbound-only: the local proxy connects to the
  // relay, but no local IVAO/PilotCore/TS2 port is exposed to the internet.
  const config = options.config || {};
  const logger = options.logger || console;
  const enabled = config.remoteAgentEnabled === true;
  const relayWsUrl = buildRemoteRelayWsUrl(config, logger);
  const relayToken = String(config.remoteRelayToken || '').trim();
  const deviceId = normalizeRemoteDeviceId(config.remoteDeviceId)
    || normalizeRemoteDeviceId(`voxhf-${options.hostname || 'local'}`);
  const deviceName = config.remoteDeviceName || `${options.hostname || 'Local'} VoxHF`;
  const appVersion = options.appVersion || '0.0.0';
  const reconnectMs = Number(config.remoteReconnectMs) || 5000;
  const diagnostics = config.voiceDiagnostics === true;
  const commandWindows = new Map();
  const commandRateLimits = makeCommandRateLimits();

  let ws = null;
  let reconnectTimer = null;
  let pairing = null;
  let txTimer = null;
  let remoteTxStats = null;
  let remoteTxRejectedWithoutSessionLogged = false;
  let updateRequired = false;

  const remoteTxSocket = {
    readyState: options.wsOpen,
    send(data) {
      handleRemoteTxSocketSend(data);
    },
  };

  function start() {
    if (!enabled) return;
    if (!relayWsUrl) {
      logger.warn('[REMOTE] Remote agent disabled because relay configuration is incomplete.');
      return;
    }
    connect();
  }

  function connect() {
    clearTimeout(reconnectTimer);
    logger.log(`[REMOTE] Connecting agent to ${redactedRemoteUrl(relayWsUrl)}`);

    // Node can authenticate the HTTP upgrade without exposing the long-lived
    // agent token in URLs, reverse-proxy logs, or error messages.
    const next = new WebSocket(relayWsUrl, {
      perMessageDeflate: false,
      headers: { authorization: `Bearer ${relayToken}` },
    });
    ws = next;

    next.on('open', () => {
      logger.log(`[REMOTE] Agent connected as ${deviceName}`);
      send(MESSAGE_TYPES.AGENT_HELLO, { deviceId, deviceName, agentVersion: appVersion }, 'agent-hello');
      send(MESSAGE_TYPES.PAIRING_BEGIN, { deviceName, agentVersion: appVersion }, 'pairing-begin');
      sendStatus();
      sendRadioState();
      sendStationsState();
      sendWeatherState();
    });

    next.on('message', (raw, isBinary) => {
      if (isBinary) {
        writeRemoteTxPcm(Buffer.from(raw));
        return;
      }
      handleRelayMessage(String(raw));
    });

    next.on('close', () => {
      if (ws === next) ws = null;
      stopRemoteWebTx('remote relay closed');
      scheduleReconnect();
    });

    next.on('error', (err) => {
      logger.warn(`[REMOTE] ${err.message}`);
    });
  }

  function scheduleReconnect() {
    if (!enabled || updateRequired || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectMs);
  }

  function handleRelayMessage(raw) {
    // The relay validates protocol messages, but the local agent validates them
    // again before touching PilotCore/FSD/TS2.
    const result = parseRemoteJson(raw);
    if (!result.ok) {
      logger.warn(`[REMOTE] Invalid relay message: ${result.error}`);
      return;
    }

    const message = result.message;
    if (message.type === MESSAGE_TYPES.PING) {
      send(MESSAGE_TYPES.PONG, {}, `pong-${message.id}`);
      return;
    }

    if (message.type === MESSAGE_TYPES.RELAY_IDENTITY) {
      const name = message.payload.userName || message.payload.userId;
      logger.log(`[REMOTE] Relay user: ${name}`);
      options.broadcast({
        kind: 'update_policy',
        latestVersion: message.payload.recommendedAgentVersion || message.payload.relayVersion || '',
        recommendedLocalVersion: message.payload.recommendedAgentVersion || message.payload.relayVersion || '',
        minimumLocalVersion: message.payload.minimumAgentVersion || '',
        downloadUrl: message.payload.downloadUrl || '',
      });
      if (
        message.payload.minimumAgentVersion
        && compareVersions(appVersion, message.payload.minimumAgentVersion) < 0
      ) {
        updateRequired = true;
        logger.error(
          `[REMOTE] Update required: relay requires VoxHF ${message.payload.minimumAgentVersion} or newer; current ${appVersion}.`
        );
        nextCloseForUpdate();
      }
      return;
    }

    if (message.type === MESSAGE_TYPES.PONG || message.type === MESSAGE_TYPES.DEVICE_STATE) return;

    if (message.type === MESSAGE_TYPES.PAIRING_CODE) {
      pairing = {
        code: message.payload.code,
        expiresAt: message.payload.expiresAt,
      };
      logger.log(`[REMOTE] Browser pairing code: ${pairing.code} (expires ${pairing.expiresAt})`);
      options.broadcast({
        kind: 'remote_pairing',
        code: pairing.code,
        expiresAt: pairing.expiresAt,
      });
      return;
    }

    if (message.type === MESSAGE_TYPES.RELAY_ERROR) {
      logger.warn(`[REMOTE] ${message.payload.code}: ${message.payload.message}`);
      return;
    }

    handleRemoteCommand(message);
  }

  function nextCloseForUpdate() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.close(1000, 'agent update required');
  }

  function handleRemoteCommand(message) {
    if (!allowCommand(message.type)) {
      logger.warn(`[REMOTE] Rate limited ${message.type}`);
      return;
    }

    const commands = options.commands;
    switch (message.type) {
      case MESSAGE_TYPES.RADIO_SET:
        commands.setCom(message.payload.com, message.payload.freq, message.payload.station || '');
        return;
      case MESSAGE_TYPES.CHAT_SEND:
        commands.sendChatCommand(message.payload, (text) => logger.warn(`[REMOTE] ${text}`));
        return;
      case MESSAGE_TYPES.WEATHER_REQUEST:
        commands.sendWeatherRequest(message.payload.kind, message.payload.icao, (text) => logger.warn(`[REMOTE] ${text}`), {
          source: message.payload.source,
          role: message.payload.role,
        });
        return;
      case MESSAGE_TYPES.ATIS_REQUEST:
        commands.sendAtisRequest(message.payload.callsign, (text) => logger.warn(`[REMOTE] ${text}`));
        return;
      case MESSAGE_TYPES.XPDR_SET_SQUAWK:
        commands.setSquawk(message.payload.code);
        return;
      case MESSAGE_TYPES.XPDR_SET_MODE:
        commands.toggleXpdr(message.payload.mode);
        return;
      case MESSAGE_TYPES.XPDR_IDENT:
        commands.sendIdent();
        return;
      case MESSAGE_TYPES.TX_START:
        startRemoteWebTx(message.payload.com);
        return;
      case MESSAGE_TYPES.TX_STOP:
        stopRemoteWebTx('remote tx stopped');
        return;
      case MESSAGE_TYPES.MONITOR_START:
      case MESSAGE_TYPES.MONITOR_STOP:
        logger.warn(`[REMOTE] ${message.type} received, but Remote TX monitor is not implemented yet.`);
        return;
      default:
        logger.warn(`[REMOTE] Ignored unsupported command ${message.type}`);
    }
  }

  function allowCommand(type) {
    // The relay does authorization, but the agent still protects its local
    // Altitude/FSD control surface from command floods after pairing.
    const rule = commandRateLimits.get(type);
    if (!rule) return true;

    const now = Date.now();
    const windowStart = now - rule.windowMs;
    const recent = (commandWindows.get(type) || []).filter((time) => time >= windowStart);
    if (recent.length >= rule.max) {
      commandWindows.set(type, recent);
      return false;
    }

    recent.push(now);
    commandWindows.set(type, recent);
    return true;
  }

  function publishFromLocal(data) {
    // Local state remains the source of truth. Remote updates are derived from
    // the same events already sent to the local webapp.
    if (!isOpen()) return;

    if (
      data.kind === 'status'
      || data.kind === 'login'
      || data.kind === 'xpdr_update'
    ) {
      sendStatus();
      return;
    }

    if (data.kind === 'flight_plan_status' || data.kind === 'weather_update') {
      sendStatus();
      sendWeatherState();
      return;
    }

    if (data.kind === 'freq_update') {
      sendRadioState();
      return;
    }

    if (data.kind === 'atc_detected' || data.kind === 'atc_voice_info' || data.kind === 'own_position') {
      sendStationsState();
      return;
    }

    if (data.kind === 'message') {
      sendChatMessage(data);
    }
  }

  function sendStatus() {
    const status = options.state.getStatus();
    const payload = {
      connected: Boolean(status.connected),
      webTxEnabled: Boolean(status.webTxEnabled),
      txReady: Boolean(status.txReady),
      txSampleRate: status.txSampleRate,
      agentVersion: appVersion,
    };
    if (status.callsign) payload.callsign = status.callsign;
    if (status.flightPlanStatus === 'filed' || status.flightPlanStatus === 'missing') {
      payload.flightPlanStatus = status.flightPlanStatus;
    }
    if (status.squawk) payload.squawk = status.squawk;
    if (status.xpdrMode === 'stby' || status.xpdrMode === 'alt') {
      payload.xpdrMode = status.xpdrMode;
    }
    send(MESSAGE_TYPES.AGENT_STATUS, payload);
  }

  function sendRadioState() {
    const radio = options.state.getRadioState();
    const com1 = formatRemoteComFrequency(radio.com1);
    const com2 = formatRemoteComFrequency(radio.com2);
    if (!com1 || !com2) return;
    send(MESSAGE_TYPES.RADIO_STATE, {
      com1,
      com2,
      station1: radio.station1 || '',
      station2: radio.station2 || '',
    });
  }

  function formatRemoteComFrequency(freq) {
    const raw = String(freq || '').trim();
    if (!raw) return '';
    const formatted = options.formatComFrequency(raw);
    return /^1[0-9]{2}\.[0-9]{3}$/.test(formatted) ? formatted : '';
  }

  function sendStationsState() {
    const snapshot = options.state.getStationsState();
    const stations = snapshot.stations
      .filter((station) => station.callsign && !station.callsign.endsWith('_OBS'))
      .map((station) => {
        const item = {
          callsign: station.callsign,
          freq: formatRemoteComFrequency(station.freq) || '',
        };
        if (Number.isFinite(Number(station.lat))) item.lat = Number(station.lat);
        if (Number.isFinite(Number(station.lon))) item.lon = Number(station.lon);
        if (station.voice) item.voice = String(station.voice).slice(0, 256);
        return item;
      });

    const payload = { stations };
    const ownPosition = snapshot.ownPosition;
    if (ownPosition && Number.isFinite(Number(ownPosition.lat)) && Number.isFinite(Number(ownPosition.lon))) {
      payload.ownPosition = {
        lat: Number(ownPosition.lat),
        lon: Number(ownPosition.lon),
      };
    }
    send(MESSAGE_TYPES.STATIONS_STATE, payload);
  }

  function sendWeatherState() {
    const status = options.state.getStatus();
    send(MESSAGE_TYPES.WEATHER_STATE, {
      flightPlanStatus: status.flightPlanStatus || 'missing',
      flightPlan: status.flightPlan || { departure: '', destination: '', alternate: '' },
      weatherState: options.state.getWeatherState?.() || {
        departure: { icao: '', metar: null, taf: null },
        destination: { icao: '', metar: null, taf: null },
      },
    });
  }

  function sendChatMessage(data) {
    const text = String(data.text || '').trim();
    if (!text) return;
    send(MESSAGE_TYPES.CHAT_MESSAGE, {
      sender: String(data.sender || 'LOCAL'),
      recipient: String(data.recipient || options.state.getCallsign() || 'LOCAL'),
      text,
      timestamp: data.timestamp || options.timestamp(),
      direction: data.direction === 'outgoing' ? 'outgoing' : 'incoming',
    });
  }

  function renewPairingCode(report = () => {}) {
    // Pairing codes are owned by the relay. The local agent can ask for a fresh
    // short-lived code at any time without restarting the proxy.
    if (!enabled) {
      report('Remote agent mode is disabled in config.json.');
      return false;
    }
    if (!isOpen()) {
      report('Remote relay is not connected yet.');
      return false;
    }
    const ok = send(MESSAGE_TYPES.PAIRING_BEGIN, { deviceName, agentVersion: appVersion }, `pairing-renew-${Date.now().toString(36)}`);
    report(ok ? 'Requested a new remote pairing code.' : 'Remote pairing code request failed.');
    return ok;
  }

  function send(type, payload = {}, id = '') {
    if (!isOpen()) return false;
    ws.send(JSON.stringify(createRemoteMessage(type, payload, id)));
    return true;
  }

  function sendSystemMessage(text) {
    // Remote browsers do not have the local WebSocket error channel. Send
    // concise agent-side feedback through typed chat-message updates.
    return send(MESSAGE_TYPES.CHAT_MESSAGE, {
      sender: 'LOCAL',
      recipient: options.state.getCallsign() || 'REMOTE',
      text,
      timestamp: options.timestamp(),
      direction: 'incoming',
    });
  }

  function sendBinary(buffer) {
    // Remote RX audio is forwarded as live PCM. The relay forwards it only to
    // paired browsers watching this agent and keeps only a frame-size guard.
    if (!isOpen() || !Buffer.isBuffer(buffer) || !buffer.length) return false;
    for (let offset = 0; offset < buffer.length; offset += RX_PCM_CHUNK_BYTES) {
      ws.send(buffer.slice(offset, offset + RX_PCM_CHUNK_BYTES), { binary: true });
    }
    return true;
  }

  function isOpen() {
    return Boolean(ws && ws.readyState === WebSocket.OPEN);
  }

  function handleRemoteTxSocketSend(data) {
    // startWebTx reports local errors through ws.send(). The virtual remote TX
    // socket converts only actionable errors into typed remote UI messages.
    if (Buffer.isBuffer(data)) return;
    try {
      const message = JSON.parse(String(data));
      if (message.kind === 'error' && message.text) sendSystemMessage(message.text);
    } catch (_) {}
  }

  function startRemoteWebTx(com) {
    const ok = options.tx.start(remoteTxSocket, com, { monitor: false });
    if (!ok) {
      if (diagnostics) logger.warn(`[REMOTE TX] rejected COM${com}`);
      return false;
    }

    remoteTxStats = {
      com: com === 2 ? 2 : 1,
      frames: 0,
      bytes: 0,
      rejected: 0,
      startedAt: Date.now(),
    };
    remoteTxRejectedWithoutSessionLogged = false;
    if (diagnostics) logger.log(`[REMOTE TX] start COM${remoteTxStats.com}`);
    clearTimeout(txTimer);
    txTimer = setTimeout(() => {
      stopRemoteWebTx('remote tx timed out');
      sendSystemMessage('Remote TX timed out.');
    }, TX_MAX_MS);
    return true;
  }

  function stopRemoteWebTx(reason = 'remote tx stopped') {
    if (remoteTxStats && diagnostics) {
      const durationMs = Math.max(0, Date.now() - remoteTxStats.startedAt);
      logger.log(
        `[REMOTE TX] stop COM${remoteTxStats.com} frames=${remoteTxStats.frames} `
        + `bytes=${remoteTxStats.bytes} rejected=${remoteTxStats.rejected} duration=${durationMs}ms reason="${reason}"`
      );
    }
    remoteTxStats = null;
    clearTimeout(txTimer);
    txTimer = null;
    options.tx.stop(remoteTxSocket, reason);
  }

  function writeRemoteTxPcm(pcm) {
    // Relay browser->agent binary frames are raw PCM after the relay strips
    // CTX1. They feed the same encoder and TS2 packet shaper used locally.
    const ok = options.tx.writePcm(remoteTxSocket, pcm);
    if (remoteTxStats) {
      remoteTxStats.frames += 1;
      remoteTxStats.bytes += pcm.length;
      if (!ok) remoteTxStats.rejected += 1;
    } else if (!ok && !remoteTxRejectedWithoutSessionLogged) {
      remoteTxRejectedWithoutSessionLogged = true;
      if (diagnostics) logger.warn(`[REMOTE TX] pcm rejected before active Web TX session bytes=${pcm.length}`);
    }
    return ok;
  }

  return {
    start,
    publishFromLocal,
    sendBinary,
    sendStatus,
    renewPairingCode,
    getPairing: () => pairing,
  };
}

function buildRemoteRelayWsUrl(config, logger = console) {
  // The user can configure either ws(s)://host/ws or an http(s) base URL. The
  // local agent always connects as source=agent and never exposes local ports.
  if (!config.remoteAgentEnabled) return '';
  if (!config.remoteRelayUrl || !config.remoteRelayToken) {
    logger.warn('[REMOTE] remoteAgentEnabled is true, but remoteRelayUrl or remoteRelayToken is missing.');
    return '';
  }

  try {
    const url = new URL(config.remoteRelayUrl);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('URL must use ws, wss, http, or https');
    if (!url.pathname || url.pathname === '/') url.pathname = '/ws';
    url.searchParams.set('source', 'agent');
    return url.toString();
  } catch (err) {
    logger.warn(`[REMOTE] Invalid remoteRelayUrl: ${err.message}`);
    return '';
  }
}

function normalizeRemoteDeviceId(value) {
  // The shared protocol accepts compact token-like ids. This gives the PC a
  // stable default id without storing anything extra.
  const text = String(value || '').trim().replace(/[^A-Za-z0-9._:-]/g, '-').replace(/-+/g, '-');
  return /^[A-Za-z0-9._:-]{8,160}$/.test(text) ? text : '';
}

function redactedRemoteUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.searchParams.has('token')) url.searchParams.set('token', '***');
    return url.toString();
  } catch (_) {
    return '(configured relay)';
  }
}

function makeCommandRateLimits() {
  // PTT start/stop are intentionally not rate-limited here. Remote TX audio is
  // live, guarded by the relay/session path, and users often tap PTT repeatedly
  // while testing. Limiting these commands can make TX appear active while the
  // local encoder never starts.
  return new Map([
    [MESSAGE_TYPES.RADIO_SET, { max: 8, windowMs: 10_000 }],
    [MESSAGE_TYPES.CHAT_SEND, { max: 8, windowMs: 10_000 }],
    [MESSAGE_TYPES.WEATHER_REQUEST, { max: 6, windowMs: 10_000 }],
    [MESSAGE_TYPES.ATIS_REQUEST, { max: 6, windowMs: 10_000 }],
    [MESSAGE_TYPES.XPDR_SET_SQUAWK, { max: 6, windowMs: 10_000 }],
    [MESSAGE_TYPES.XPDR_SET_MODE, { max: 6, windowMs: 10_000 }],
    [MESSAGE_TYPES.XPDR_IDENT, { max: 3, windowMs: 30_000 }],
  ]);
}

module.exports = {
  createRemoteAgent,
  buildRemoteRelayWsUrl,
  normalizeRemoteDeviceId,
};
