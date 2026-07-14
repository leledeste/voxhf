/**
 * VoxHF
 * --------
 * Local proxy for IVAO Altitude.
 *
 * General flow:
 * 1. PilotUI connects to this program on port 4827.
 * 2. This program forwards data to PilotCore, but replaces the IVAO FSD IP
 *    with 127.0.0.1 so PilotCore goes through the local FSD proxy.
 * 3. The local FSD proxy reads chat, commands, weather, and VOICE messages.
 * 4. When IVAO announces the TS2 voice server, we replace it with the proxy
 *    local network IP so TS2 traffic also passes through this program.
 * 5. The TS2 voice proxy forwards everything to the real server and decodes RX voice
 *    only for the webapp.
 *
 * Note: web TX is still experimental. It is isolated in its own section and
 * can be disabled from config.json with "webTxEnabled": false.
 */

process.on('uncaughtException', (err) => {
  console.error('[FATAL]', err.message);
  if (err.stack) console.error(err.stack);
});

const os = require('os');
const path = require('path');
const { readConfig, listLocalNetworkIps, detectLanIp } = require('./proxy/config');
const { failListen } = require('./proxy/port-diagnostics');
const { createRemoteAgent } = require('./proxy/remote-agent');
const { createWebTx } = require('./proxy/web-tx');
const { createTs2VoiceProxy } = require('./proxy/ts2-voice-proxy');
const { createPilotBridge } = require('./proxy/pilot-bridge');
const { createFsdProxy } = require('./proxy/fsd-proxy');
const { createAppState } = require('./proxy/app-state');
const { createLocalWebServer } = require('./proxy/local-web-server');
const { WS_OPEN } = require('./proxy/socket-utils');
const { normalizeSquawkCode } = require('./proxy/fsd-parser');
const {
  makeFreqPacket,
  makeSquawkPacket,
  formatComFrequency,
  normalizePilotComFrequency,
} = require('./proxy/pilot-core');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(__dirname, 'config.json');
const CONFIG = readConfig(CONFIG_PATH);
const APP_VERSION = require('./package.json').version;

const INTERNAL_PORT = 4827;              // PilotUI -> VoxHF -> PilotCore
const PILOTCORE_HOST = '127.0.0.2';      // Local PilotCore endpoint used by Altitude
const FSD_PORT = 6809;                   // FSD IVAO
const TS2_PORT = 8767;                   // TeamSpeak 2 voice
const WEB_PORT = 3000;
const WEB_HOST = '127.0.0.1';

const LOCAL_IPS = listLocalNetworkIps();
const LAN_IP = detectLanIp(CONFIG.lanIp, LOCAL_IPS);
let IVAO_FSD_HOST = 'ws-1.eu-west-2.ivao.aero';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let remoteAgent = null;
let webTx = null;
let localWeb = null;
const appState = createAppState({
  timestamp,
  publish: publishToClients,
});

const pilotBridge = createPilotBridge({
  port: INTERNAL_PORT,
  pilotCoreHost: PILOTCORE_HOST,
  fsdPort: FSD_PORT,
  logger: console,
  onFsdHost: (ip) => { IVAO_FSD_HOST = ip; },
  onCallsign: appState.setCallsign,
  onComFrequency: appState.updateComFrequency,
});

const ts2Voice = createTs2VoiceProxy({
  config: CONFIG,
  port: TS2_PORT,
  logger: console,
  onPcm: deliverRxPcm,
  onClientPacket: (msg, key, remote) => webTx?.cacheTxSession(msg, key, remote),
  onClientClose: (key, reason) => webTx?.invalidateTxSession(reason || 'TS2 UDP client closed', key),
});

const fsdProxy = createFsdProxy({
  port: FSD_PORT,
  state: appState,
  logger: console,
  timestamp,
  getHost: () => IVAO_FSD_HOST,
  getLanIp: () => LAN_IP,
  onVoiceServer: updateVoiceServer,
  onClose: () => {
    ts2Voice.stopVoiceDecoder();
    ts2Voice.resetUdpClients('FSD disconnected');
    clearWebTxReadiness('FSD disconnected');
  },
});

webTx = createWebTx({
  config: CONFIG,
  setTxLamp: setAltitudeTxLamp,
  getTs2Target: () => ts2Voice.getTarget(),
  onReady: () => publishWebTxReadiness(true),
  onNotReady: () => publishWebTxReadiness(false),
});

remoteAgent = createRemoteAgent({
  config: CONFIG,
  hostname: os.hostname(),
  appVersion: APP_VERSION,
  wsOpen: WS_OPEN,
  logger: console,
  timestamp,
  broadcast,
  formatComFrequency,
  state: {
    getCallsign: appState.getCallsign,
    getStatus: () => ({
      ...appState.getStatus(),
      webTxEnabled: webTx.isEnabled(),
      txReady: webTx.isReady(),
      txSampleRate: webTx.sampleRate,
    }),
    getRadioState: appState.getRadioState,
    getStationsState: appState.getStationsState,
    getWeatherState: appState.getWeatherState,
  },
  commands: {
    setCom,
    sendChatCommand: fsdProxy.sendChatCommand,
    sendWeatherRequest: fsdProxy.sendWeatherRequest,
    sendAtisRequest: fsdProxy.sendAtisRequest,
    setSquawk,
    toggleXpdr,
    sendIdent,
  },
  tx: {
    start: webTx.start,
    stop: webTx.stop,
    writePcm: webTx.writePcm,
  },
});

localWeb = createLocalWebServer({
  webDir: path.join(__dirname, 'webapp'),
  host: WEB_HOST,
  port: WEB_PORT,
  lanIp: LAN_IP,
  logger: console,
  timestamp,
  remoteAgent,
  getPongState: () => ({
    ...appState.getStatus(),
    voiceServer: ts2Voice.getServer(),
    txReady: webTx.isReady(),
  }),
  makeInitPayload: () => ({
    kind: 'init',
    ...appState.getInitState(),
    lanIp: LAN_IP,
    version: APP_VERSION,
    updateCheckUrl: CONFIG.updateCheckUrl,
    webTxEnabled: webTx.isEnabled(),
    txReady: webTx.isReady(),
    txSampleRate: webTx.sampleRate,
    voiceServer: ts2Voice.getServer(),
    remotePairing: remoteAgent.getPairing(),
  }),
  startWebTx: webTx.start,
  stopWebTx: webTx.stop,
  writeWebTxPcm: webTx.writePcm,
  setCom,
  setSquawk,
  toggleXpdr,
  sendIdent,
  sendWeatherRequest: fsdProxy.sendWeatherRequest,
  sendAtisRequest: fsdProxy.sendAtisRequest,
  sendChatCommand: fsdProxy.sendChatCommand,
});

function timestamp() {
  // Use UTC ISO timestamps so the browser can render messages consistently.
  return new Date().toISOString();
}

function publishToClients(data) {
  // This is the transport fan-out only. appState decides whether a message
  // should be stored in reconnect history before calling this publisher.
  if (localWeb) localWeb.sendJson(data);

  if (remoteAgent) remoteAgent.publishFromLocal(data);
}

function broadcast(data) {
  // Keep one public broadcast function for modules that do not need to know
  // where state is stored.
  appState.broadcast(data);
}

function publishWebTxReadiness(ready) {
  broadcast({ kind: 'voice_tx_ready', ready, enabled: webTx.isEnabled() });
  if (remoteAgent) remoteAgent.sendStatus();
}

function clearWebTxReadiness(reason) {
  if (webTx) webTx.invalidateTxSession(reason);
}

function updateVoiceServer(server) {
  const before = ts2Voice.getServer();
  const after = ts2Voice.setServer(server);
  if (after !== before) {
    ts2Voice.stopVoiceDecoder();
    ts2Voice.resetUdpClients('voice server changed');
    clearWebTxReadiness('voice server changed');
  }
  return after;
}

// ---------------------------------------------------------------------------
// Commands sent to PilotCore
// ---------------------------------------------------------------------------

function sendToPilotCore(buf) {
  // All simulator-control commands share the PilotCore control socket learned
  // from the 4827 proxy.
  return pilotBridge.sendToCore(buf);
}

function setCom(com, freq, station = '') {
  // Update PilotCore first, then optimistically update the webapp display.
  // PilotCore will also echo real radio changes back through the 4827 bridge.
  const value = normalizePilotComFrequency(freq);
  if (!value) return false;
  const ok = sendToPilotCore(makeFreqPacket(com, value));
  if (ok) {
    console.log(`[4827] COM${com} -> ${value} MHz`);
    appState.updateComFrequency(com, value, station);
  }
  return ok;
}

function setSquawk(code) {
  // Squawk is a small binary packet; validation stays in the UI/command layer.
  const squawk = normalizeSquawkCode(code);
  if (!squawk) return false;
  const ok = sendToPilotCore(makeSquawkPacket(squawk));
  if (ok) appState.updateXpdrState({ squawk });
  return ok;
}

function toggleXpdr(mode = '') {
  // The Altitude protocol exposes transponder mode as a toggle packet.
  const ok = sendToPilotCore(Buffer.from([0x03, 0, 0, 0, 0x01, 0x20, 0]));
  if (ok && (mode === 'stby' || mode === 'alt')) appState.updateXpdrState({ mode });
  return ok;
}

function sendIdent() {
  // IDENT is a direct PilotCore command; no FSD line is involved.
  return sendToPilotCore(Buffer.from([0x03, 0, 0, 0, 0x02, 0x20, 0]));
}

function setAltitudeTxLamp(com, active) {
  // The web TX path sends audio directly through TS2, so PilotUI would not know
  // to light its TX indicator. This synthetic UI feedback mirrors Altitude PTT.
  pilotBridge.setTxLamp(com, active);
}

function deliverRxPcm(pcm) {
  // The browser audio renderer already consumes raw 16-bit mono PCM. Reuse that
  // exact format locally and remotely to keep Remote RX simple for the preview.
  if (localWeb) localWeb.sendBinary(pcm);
  remoteAgent.sendBinary(pcm);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

pilotBridge.server.on('error', failListen(
  '4827',
  LAN_IP,
  INTERNAL_PORT,
  'Close Altitude/PilotCore if it is already running, start VoxHF first, then reconnect Altitude.'
));

pilotBridge.server.listen(INTERNAL_PORT, LAN_IP, () => {
  console.log(`[4827] Internal proxy on ${LAN_IP}:${INTERNAL_PORT}`);
});

fsdProxy.server.listen(FSD_PORT, '127.0.0.1', () => {
  console.log(`[6809] FSD proxy on 127.0.0.1:${FSD_PORT}`);
});

ts2Voice.tcpServer.listen(TS2_PORT, '0.0.0.0', () => {
  console.log(`[TS2 TCP] Listening on 0.0.0.0:${TS2_PORT}`);
});

ts2Voice.udpSocket.bind(TS2_PORT, '0.0.0.0', () => {
  console.log(`[TS2 UDP] Listening on 0.0.0.0:${TS2_PORT}`);
});

localWeb.listen(() => {
  console.log(`[HTTP] Webapp at http://localhost:${WEB_PORT}`);
});

remoteAgent.start();

console.log('');
console.log('=======================================================');
console.log('  VoxHF');
console.log('=======================================================');
console.log('  1. Start VoxHF before connecting Altitude/PilotUI');
if (LOCAL_IPS.length > 1) console.log(`  Local IPs detected: ${LOCAL_IPS.map((candidate) => `${candidate.ip} (${candidate.name})`).join(', ')}`);
console.log(`  2. In PilotUI -> Simulator Address: ${LAN_IP}`);
console.log('  3. Start PilotCore/Altitude and connect normally');
console.log(`  4. Local webapp: http://localhost:${WEB_PORT}`);
console.log('=======================================================');
