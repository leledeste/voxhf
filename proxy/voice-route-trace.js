'use strict';

// Temporary, local-only routing investigation. Never serialize packet bodies,
// session bytes, credentials, or arbitrary PilotCore/FSD text. Station hints
// are matches against ATC names already announced in VOICE responses; they are
// correlation clues, not a decoded channel-selection command.
function createVoiceRouteTrace({ enabled = false, logger = console, now = Date.now } = {}) {
  if (!enabled) return null;
  const started = now();
  const stations = new Set();
  const streams = new WeakMap();
  let nextStream = 0;
  let lines = 0;
  let stopped = false;
  const labels = new Set(['enabled', 'fsd-query', 'fsd-reply', 'route-change', 'com',
    'tcp-open', 'tcp-close', 'udp-open', 'udp-close', 'packet']);
  const fields = {
    station: /^[A-Z0-9-]{2,12}_[A-Z0-9_]{2,20}$/,
    host: /^[a-zA-Z0-9.-]{1,253}$/,
    from: /^[a-zA-Z0-9.-]{1,253}$/,
    to: /^[a-zA-Z0-9.-]{1,253}$/,
    transport: /^(pilot|ts2-tcp|ts2-udp)$/,
    direction: /^(out|in)$/,
    stream: /^\d{1,10}$/,
    port: /^\d{1,5}$/,
    bytes: /^\d{1,10}$/,
    cls: /^[0-9a-f]{4}$/,
    subtype: /^[0-9a-f]{4}$/,
    frame: /^[0-9a-f]{8}$/,
    com: /^[12]$/,
    freq: /^1\d{2}\.\d{3}$/,
    hints: /^(?:[A-Z0-9-]{2,12}_[A-Z0-9_]{2,20})(?:,[A-Z0-9-]{2,12}_[A-Z0-9_]{2,20}){0,3}$/,
  };

  function active() {
    if (stopped) return false;
    if (lines >= 1200 || now() - started >= 10 * 60 * 1000) {
      stopped = true;
      logger.log('[ROUTE] limit reached; tracing stopped (restart explicitly to repeat)');
      return false;
    }
    return true;
  }

  function event(label, values = {}) {
    if (!active() || !labels.has(label)) return;
    if (label === 'fsd-reply' && fields.station.test(values.station) && stations.size < 128) {
      stations.add(values.station);
    }
    const safe = Object.entries(values).filter(([key, value]) => Object.hasOwn(fields, key) && fields[key].test(String(value)))
      .map(([key, value]) => `${key}=${value}`).join(' ');
    lines += 1;
    logger.log(`[ROUTE] +${now() - started}ms ${label}${safe ? ` ${safe}` : ''}`);
  }

  function stream(socket) {
    let state = streams.get(socket);
    if (!state) {
      state = { id: ++nextStream, seen: new Set() };
      streams.set(socket, state);
    }
    return state;
  }

  function id(socket) { return active() ? stream(socket).id : 0; }

  function packet(transport, direction, socket, data) {
    if (!active()) return;
    const state = stream(socket);
    if (state.seen.size >= 24) return;
    const values = { transport, direction, stream: state.id, bytes: data.length };
    if (transport === 'pilot' && data.length >= 12) {
      const frameLength = data.readUInt32LE(0);
      const payloadLength = data.readUInt32LE(8);
      if (frameLength >= 8 && frameLength + 4 <= data.length && payloadLength <= frameLength - 8) {
        values.frame = data.readUInt32LE(4).toString(16).padStart(8, '0');
      }
    }
    if (transport !== 'pilot' && data.length >= 4) {
      const cls = data.readUInt16LE(0);
      const subtype = data.readUInt16LE(2);
      // Skip known voice datagrams entirely, including native TX. No PCM or
      // session-header values are retained or logged by this tracer.
      if (cls === 0xBEF2 || ([0xBEF0, 0xBEF3].includes(cls) && subtype === 0x0C00)) return;
      values.cls = cls.toString(16).padStart(4, '0');
      values.subtype = subtype.toString(16).padStart(4, '0');
    }
    const bounded = data.subarray(0, 4096);
    const hints = [];
    for (const station of stations) {
      if (bounded.includes(Buffer.from(station, 'ascii'))) hints.push(station);
      if (hints.length === 4) break;
    }
    if (hints.length) values.hints = hints.join(',');
    // Suppress repeated shapes, not just repeated packets. Keep no raw bytes.
    const shape = JSON.stringify(values);
    if (state.seen.has(shape)) return;
    state.seen.add(shape);
    event('packet', values);
  }

  event('enabled');
  return { event, id, packet };
}

module.exports = { createVoiceRouteTrace };
