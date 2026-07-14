'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const { createStaticWebHandler } = require('./static-web');
const { createWebCommandHandler } = require('./websocket-commands');
const { isWsOpen } = require('./socket-utils');

const DEFAULT_MAX_JSON_BYTES = 16 * 1024;
const DEFAULT_RATE_WINDOW_MS = 10_000;
const DEFAULT_MAX_MESSAGES_PER_WINDOW = 240;

function createLocalWebServer(options) {
  // The local web server owns the browser-facing surface: static files, /ws
  // upgrade, local origin checks, JSON command dispatch, microphone PCM frames,
  // and browser RX fan-out.
  const webDir = options.webDir;
  const host = options.host || '127.0.0.1';
  const port = options.port || 3000;
  const lanIp = options.lanIp;
  const logger = options.logger || console;
  const timestamp = options.timestamp;
  const maxJsonBytes = options.maxJsonBytes || DEFAULT_MAX_JSON_BYTES;
  const rateWindowMs = options.rateWindowMs || DEFAULT_RATE_WINDOW_MS;
  const maxMessagesPerWindow = options.maxMessagesPerWindow || DEFAULT_MAX_MESSAGES_PER_WINDOW;
  const wsClients = new Set();

  const handleWebCommand = createWebCommandHandler({
    getPongState: options.getPongState,
    sendSystem,
    sendTestTone,
    startWebTx: options.startWebTx,
    stopWebTx: options.stopWebTx,
    remoteAgent: options.remoteAgent,
    setCom: options.setCom,
    setSquawk: options.setSquawk,
    toggleXpdr: options.toggleXpdr,
    sendIdent: options.sendIdent,
    sendWeatherRequest: options.sendWeatherRequest,
    sendAtisRequest: options.sendAtisRequest,
    sendChatCommand: options.sendChatCommand,
  });

  const httpServer = http.createServer(createStaticWebHandler(webDir));
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxJsonBytes + 4 });

  httpServer.on('upgrade', (req, socket, head) => {
    // Only /ws is upgraded. Everything else remains a normal static HTTP
    // request. Origin checks protect localhost from random web pages.
    if (req.url !== '/ws') { socket.destroy(); return; }
    if (!isAllowedLocalWebOrigin(req.headers.origin || '')) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    // A new browser gets a compact snapshot of current state plus recent
    // messages. Live updates then arrive through sendJson() or binary PCM.
    wsClients.add(ws);
    ws.send(JSON.stringify(options.makeInitPayload()));
    ws.rate = { windowStartMs: Date.now(), messages: 0 };

    ws.on('message', (raw) => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (buf.slice(0, 4).toString('ascii') === 'CTX1') {
        options.writeWebTxPcm(ws, buf.slice(4));
        return;
      }
      if (buf.length > maxJsonBytes || !allowLocalWsMessage(ws)) {
        ws.send(JSON.stringify({ kind: 'error', text: 'Too many webapp messages. Slow down and try again.' }));
        return;
      }

      try {
        handleWebCommand(ws, JSON.parse(buf.toString('utf8')));
      } catch (err) {
        logger.error('[WS]', err.message);
      }
    });

    ws.on('close', () => {
      options.stopWebTx(ws, 'webapp closed');
      wsClients.delete(ws);
    });
  });

  function isAllowedLocalWebOrigin(origin) {
    // A malicious website can try to open ws://localhost:3000/ws from the
    // user's browser. Only pages served by this local webapp are allowed to
    // control the proxy.
    if (!origin) return false;
    const allowed = new Set([
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      `http://${lanIp}:${port}`,
    ]);
    return allowed.has(origin);
  }

  function allowLocalWsMessage(ws) {
    // Local UI rate limiting is intentionally generous. It protects the proxy
    // from accidental loops without affecting microphone PCM frames.
    const now = Date.now();
    if (!ws.rate || now - ws.rate.windowStartMs > rateWindowMs) {
      ws.rate = { windowStartMs: now, messages: 0 };
    }
    ws.rate.messages += 1;
    return ws.rate.messages <= maxMessagesPerWindow;
  }

  function sendSystem(ws, text) {
    // Local system messages use the same shape as real FSD messages, so the UI
    // can display warnings and command results through one renderer.
    if (!isWsOpen(ws)) return;
    ws.send(JSON.stringify({
      kind: 'message',
      type: 'system',
      sender: 'LOCAL',
      text,
      direction: 'incoming',
      timestamp: timestamp(),
    }));
  }

  function sendTestTone() {
    // A deterministic tone verifies the browser RX audio path without requiring
    // live radio traffic.
    const sampleRate = 16000;
    const samples = sampleRate;
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 12000), i * 2);
    }
    sendBinary(pcm);
  }

  function sendJson(data) {
    const json = JSON.stringify(data);
    for (const ws of wsClients) {
      if (isWsOpen(ws)) ws.send(json);
    }
  }

  function sendBinary(buffer) {
    for (const ws of wsClients) {
      if (isWsOpen(ws)) ws.send(buffer);
    }
  }

  return {
    httpServer,
    sendJson,
    sendBinary,
    listen(callback) {
      httpServer.listen(port, host, callback);
    },
  };
}

module.exports = {
  createLocalWebServer,
};
