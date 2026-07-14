'use strict';

const { spawn } = require('child_process');
const { OggSpeexWriter, OggPacketReader } = require('./ogg-speex');
const { isWsOpen, writeIfOpen, safeEnd, safeKill } = require('./socket-utils');

const CLASS_SESSION = 0xBEF0;
const CLASS_ACK = 0xBEF1;
const CLASS_TXVOICE = 0xBEF2;
const CLASS_CONTROL = 0xBEF4;
const SUBTYPE_VOICE = 0x0C00;
const TS2_PAYLOAD_SIZE = 309;
const DERIVED_INITIAL_SEQ = 0xFFFFFFFF;

function createWebTx(options) {
  // Web TX is isolated from the rest of the proxy. It learns the native TS2 TX
  // session from Altitude, encodes browser PCM with ffmpeg/libspeex, then sends
  // TS2-shaped packets through the same UDP socket Altitude already opened.
  const config = options.config || {};
  const logger = options.logger || console;
  const enabled = config.webTxEnabled === true;
  const diagnostics = config.voiceDiagnostics === true;
  const sampleRate = Number(config.webTxSampleRate) || 32000;
  const quality = Number(config.webTxQuality) || 9;
  const abr = config.webTxAbr === true;
  const bitrate = Math.max(0, Number(config.webTxBitrate) || 0);
  const framesPerPacket = Number(config.webTxFramesPerPacket) || 3;
  const intervalMs = Math.max(20, Number(config.webTxPacketIntervalMs) || framesPerPacket * 20);
  const packetMode = config.webTxPacketMode === 'fixed' ? 'fixed' : 'variable';
  const speexLimit = TS2_PAYLOAD_SIZE - 1;
  const webTxBySocket = new Map();

  let activeTxSession = null;

  function cacheTxSession(msg, clientKey, serverSock) {
    // Web TX prefers the exact TS2 voice header learned from a real Altitude TX
    // packet. Before any native TX exists, the same session bytes can be
    // derived from TS2 login/setup packets seen during voice-channel join.
    if (activeTxSession && activeTxSession.clientKey !== clientKey) {
      invalidateTxSession('TS2 UDP client changed');
    }
    if (msg.length < 16) return;

    if (msg.readUInt16LE(0) !== CLASS_TXVOICE) {
      deriveTxSessionFromSetup(msg, clientKey, serverSock);
      return;
    }

    const wasReady = Boolean(activeTxSession);
    activeTxSession = {
      clientKey,
      serverSock,
      header: Buffer.from(msg.slice(0, 12)),
      seq: msg.readUInt32LE(12),
      source: 'native',
    };
    if (diagnostics) logger.log(`[WEBTX] TX voice seed cached key=${clientKey} seq=${activeTxSession.seq}`);
    if (!wasReady) options.onReady?.();
  }

  function deriveTxSessionFromSetup(msg, clientKey, serverSock) {
    // The setup packets contain the same eight session bytes that native TX
    // later places at header[4..11]. Deriving the seed here removes the first
    // physical-PTT requirement while still letting a real TX packet replace the
    // derived value if Altitude sends one later.
    if (!isTxSeedSetupPacket(msg)) return;

    const sessionBytes = msg.slice(4, 12);
    if (sessionBytes.every((byte) => byte === 0)) return;

    const header = Buffer.alloc(12);
    header.writeUInt16LE(CLASS_TXVOICE, 0);
    header.writeUInt16LE(SUBTYPE_VOICE, 2);
    sessionBytes.copy(header, 4);

    if (
      activeTxSession
      && activeTxSession.clientKey === clientKey
      && activeTxSession.header.equals(header)
    ) {
      return;
    }

    if (activeTxSession?.source === 'native') {
      invalidateTxSession('TS2 setup session changed', activeTxSession.clientKey);
    }

    const wasReady = Boolean(activeTxSession);
    activeTxSession = {
      clientKey,
      serverSock,
      header,
      // sendPacket increments before writing, so 0xffffffff makes the first
      // derived Web TX packet use seq=0, matching native Altitude's first TX.
      seq: DERIVED_INITIAL_SEQ,
      source: 'derived',
    };
    if (diagnostics) logger.log(`[WEBTX] TX voice seed derived key=${clientKey} session=${toHex(sessionBytes)}`);
    if (!wasReady) options.onReady?.();
  }

  function isTxSeedSetupPacket(msg) {
    const cls = msg.readUInt16LE(0);
    const subtype = msg.readUInt16LE(2);
    if (cls === CLASS_SESSION && subtype === 0x0005) return true;
    if (cls === CLASS_ACK && subtype === 0x0000) return true;
    if (cls === CLASS_CONTROL && subtype === 0x0001) return true;
    return false;
  }

  function toHex(buffer) {
    return Array.from(buffer).map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
  }

  function invalidateTxSession(reason = 'TX session reset', clientKey = '') {
    // A cached TS2 TX seed belongs to one live Altitude/TS2 UDP session. If
    // Altitude reconnects, the voice server changes, or FSD closes, keeping the
    // old seed makes Web TX look active while the server may ignore packets.
    if (clientKey && activeTxSession?.clientKey !== clientKey) return;
    const wasReady = Boolean(activeTxSession);
    activeTxSession = null;

    for (const [ws, tx] of Array.from(webTxBySocket.entries())) {
      if (!tx.monitorOnly) stop(ws, reason);
    }

    if (!wasReady) return;
    if (diagnostics) logger.log(`[WEBTX] TX voice seed cleared: ${reason}`);
    options.onNotReady?.();
  }

  function createTxStats(com, monitorOnly) {
    return {
      com,
      monitorOnly,
      startedAt: Date.now(),
      pcmChunks: 0,
      pcmBytes: 0,
      oggBytes: 0,
      speexPackets: 0,
      speexBytes: 0,
      trimmedPackets: 0,
      queuedPackets: 0,
      sentPackets: 0,
      sendFailures: 0,
      writeRejected: 0,
      ffmpegExit: '',
    };
  }

  function normalizeSpeexPacket(packet, stats = null) {
    // TS2 compatibility matters more than preserving every byte from an
    // experimental encoder setting. Normal profiles fit without trimming.
    if (packet.length <= speexLimit) return packet;
    if (stats) stats.trimmedPackets += 1;
    return packet.slice(0, speexLimit);
  }

  function speexEncoderArgs() {
    // Browser PCM is encoded by ffmpeg/libspeex. These flags are the small,
    // documented surface for tuning TX quality without touching packet plumbing.
    const args = [
      '-c:a', 'libspeex',
      '-ar', String(sampleRate),
      '-ac', '1',
      '-frames_per_packet', String(framesPerPacket),
    ];

    if (abr && bitrate > 0) {
      // ABR lets libspeex target the TS2-sized payload without destructive
      // trimming.
      args.push('-abr', '1', '-b:a', String(bitrate));
    } else {
      args.push('-cbr_quality', String(quality));
    }

    return args;
  }

  function sendPacket(speexPacket, txState) {
    // Convert one raw Speex packet into the fixed TS2 voice datagram shape seen
    // from native Altitude TX. The working voice profile relies on this shape.
    if (!activeTxSession || !activeTxSession.serverSock) return false;
    const normalized = normalizeSpeexPacket(speexPacket, txState?.stats);
    if (normalized.length > speexLimit) return false;

    const target = options.getTs2Target();
    const payloadSize = packetMode === 'fixed' ? TS2_PAYLOAD_SIZE : 1 + normalized.length;
    const packet = Buffer.alloc(16 + payloadSize, packetMode === 'fixed' ? 0xff : 0x00);
    activeTxSession.header.copy(packet, 0);
    activeTxSession.seq = (activeTxSession.seq + 1) >>> 0;
    packet.writeUInt32LE(activeTxSession.seq, 12);
    packet[16] = 0x05;
    normalized.copy(packet, 17);

    // Sending through the same UDP socket learned from Altitude preserves the
    // server-side client/session association.
    try {
      activeTxSession.serverSock.send(packet, target.port, target.host, (err) => {
        if (err) {
          if (txState?.stats) txState.stats.sendFailures += 1;
          logger.warn(`[WEBTX] UDP send failed: ${err.message}`);
        }
      });
    } catch (err) {
      if (txState?.stats) txState.stats.sendFailures += 1;
      logger.warn(`[WEBTX] UDP send failed: ${err.message}`);
      return false;
    }
    if (txState?.stats) txState.stats.sentPackets += 1;
    return true;
  }

  function queuePacket(ws, txState, speexPacket) {
    // Encoding is bursty but TS2 expects paced packets. Keep a bounded queue so
    // late audio is dropped instead of building seconds of lag.
    txState.queue.push(speexPacket);
    txState.stats.queuedPackets += 1;
    if (txState.queue.length > 24) txState.queue.splice(0, txState.queue.length - 24);
    pumpQueue(ws, txState);
  }

  function pumpQueue(ws, txState) {
    // One timer at a time gives the proxy a simple packet clock.
    if (txState.sendTimer || txState.monitorOnly) return;

    txState.sendTimer = setTimeout(() => {
      txState.sendTimer = null;
      if (webTxBySocket.get(ws) !== txState) return;

      const packet = txState.queue.shift();
      if (packet && !sendPacket(packet, txState)) {
        txState.stats.sendFailures += 1;
        ws.send(JSON.stringify({ kind: 'error', text: 'Web TX frame was not sent.' }));
      }

      if (txState.queue.length) pumpQueue(ws, txState);
    }, intervalMs);
  }

  function startMonitor(ws) {
    // The monitor path decodes the web microphone locally and sends it back to
    // the browser as PCM. It is a microphone/encoder test, not a network test.
    const writer = new OggSpeexWriter(sampleRate, framesPerPacket);
    const decoder = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'ogg', '-i', 'pipe:0',
      '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1',
    ]);

    decoder.stdin.on('error', () => {});
    decoder.stdout.on('data', (pcm) => {
      if (isWsOpen(ws)) ws.send(pcm);
    });
    decoder.stdin.write(writer.headers());

    return {
      write(packet) {
        writeIfOpen(decoder.stdin, writer.frame(packet));
      },
      close() {
        safeEnd(decoder.stdin);
        safeKill(decoder);
      },
    };
  }

  function start(ws, com, startOptions = {}) {
    // A TX session owns: microphone encoder, optional local monitor decoder,
    // packet queue, and the COM indicator state. Restarting first guarantees
    // there is only one active TX chain per browser.
    if (!enabled) {
      ws.send(JSON.stringify({ kind: 'error', text: 'Web TX is disabled in config.json.' }));
      return false;
    }
    const monitorOnly = startOptions.monitorOnly === true;
    const monitorEnabled = monitorOnly || startOptions.monitor === true;

    if (!monitorOnly && !activeTxSession) {
      ws.send(JSON.stringify({ kind: 'error', text: 'Join a voice channel first. If Web TX is still not ready, press the real Altitude PTT once.' }));
      return false;
    }

    stop(ws);

    const txState = {
      ffmpeg: null,
      com: com === 2 ? 2 : 1,
      monitorOnly,
      monitor: monitorEnabled ? startMonitor(ws) : null,
      queue: [],
      sendTimer: null,
      stats: createTxStats(com === 2 ? 2 : 1, monitorOnly),
    };

    const reader = new OggPacketReader((packet) => {
      txState.stats.speexPackets += 1;
      txState.stats.speexBytes += packet.length;
      const normalized = normalizeSpeexPacket(packet, txState.stats);
      if (txState.monitor) txState.monitor.write(normalized);
      if (!txState.monitorOnly) queuePacket(ws, txState, normalized);
    });

    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0',
      ...speexEncoderArgs(),
      '-flush_packets', '1',
      '-max_delay', '0',
      '-page_duration', '20000',
      '-f', 'ogg', 'pipe:1',
    ]);

    txState.ffmpeg = ffmpeg;
    ffmpeg.stdin.on('error', () => {});
    ffmpeg.stdout.on('data', (chunk) => {
      txState.stats.oggBytes += chunk.length;
      reader.push(chunk);
    });
    ffmpeg.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (diagnostics && text) logger.warn(`[WEBTX ffmpeg] ${text}`);
    });
    ffmpeg.on('exit', (code, signal) => {
      txState.stats.ffmpegExit = `code=${code} signal=${signal || ''}`;
      stop(ws, 'encoder closed');
    });

    webTxBySocket.set(ws, txState);
    if (!monitorOnly) options.setTxLamp(txState.com, true);
    ws.send(JSON.stringify({
      kind: 'voice_tx',
      active: true,
      com: txState.com,
      monitorOnly,
      text: monitorOnly ? '' : `TX COM${txState.com} active`,
    }));
    return true;
  }

  function stop(ws, reason = '') {
    // Cleanup mirrors start(): turn off the UI lamp, stop timers, close local
    // monitor/encoder processes, and notify the browser.
    const tx = webTxBySocket.get(ws);
    if (!tx) return;

    webTxBySocket.delete(ws);
    if (!tx.monitorOnly) options.setTxLamp(tx.com, false);
    if (tx.sendTimer) clearTimeout(tx.sendTimer);
    if (tx.monitor) tx.monitor.close();
    safeEnd(tx.ffmpeg.stdin);
    safeKill(tx.ffmpeg);
    logTxStats(tx, reason);
    if (isWsOpen(ws)) ws.send(JSON.stringify({
      kind: 'voice_tx',
      active: false,
      com: tx.com,
      monitorOnly: tx.monitorOnly,
      text: reason,
    }));
  }

  function writePcm(ws, pcm) {
    // Browser microphone packets arrive as raw 16-bit PCM prefixed with CTX1.
    // The proxy streams only the PCM payload into ffmpeg.
    const tx = webTxBySocket.get(ws);
    if (!tx || !tx.ffmpeg || tx.ffmpeg.stdin.destroyed) return false;
    tx.stats.pcmChunks += 1;
    tx.stats.pcmBytes += pcm.length;
    tx.ffmpeg.stdin.write(pcm);
    return true;
  }

  function logTxStats(tx, reason) {
    const stats = tx.stats;
    if (!diagnostics) return;
    const durationMs = Math.max(0, Date.now() - stats.startedAt);
    logger.log(
      `[WEBTX] stop COM${stats.com} monitor=${stats.monitorOnly} pcmChunks=${stats.pcmChunks} `
      + `pcm=${stats.pcmBytes} ogg=${stats.oggBytes} speexPackets=${stats.speexPackets} `
      + `speex=${stats.speexBytes} queued=${stats.queuedPackets} sent=${stats.sentPackets} `
      + `trimmed=${stats.trimmedPackets} failed=${stats.sendFailures} duration=${durationMs}ms `
      + `reason="${reason}" ffmpeg="${stats.ffmpegExit}"`
    );
  }

  return {
    cacheTxSession,
    invalidateTxSession,
    start,
    stop,
    writePcm,
    isEnabled: () => enabled,
    isReady: () => Boolean(activeTxSession),
    sampleRate,
  };
}

module.exports = {
  createWebTx,
};
