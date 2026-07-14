'use strict';

function timestamp() {
  // Use UTC ISO timestamps so browser and relay clients can render messages in
  // their own local timezone without losing ordering information.
  return new Date().toISOString();
}

function parseFsdLine(rawLine, direction) {
  // FSD is line-oriented text. This parser converts only the messages VoxHF
  // understands into typed events and leaves unknown lines untouched.
  const line = rawLine.trim();
  if (!line) return null;

  // Flight plan filing: PilotCore can send a plan directly, or IVAO can answer
  // a flight-plan query with a $CR...:FP line. Treat both as UI state.
  if (line.startsWith('$FP') || line.startsWith('#FP')) {
    return {
      raw: line,
      kind: 'flight_plan_status',
      status: 'filed',
      flightPlan: parseFlightPlanFields(line.slice(3).split(':')),
      timestamp: timestamp(),
    };
  }

  if (line.startsWith('#TM')) {
    const parts = line.slice(3).split(':');
    if (parts.length < 3) return null;

    const sender = parts[0];
    const recipient = parts[1];
    const text = parts.slice(2).join(':');
    let type = 'frequency';
    if (recipient === '*') type = 'broadcast';
    else if (recipient === 'FP') type = 'system';
    else if (!recipient.startsWith('@')) type = 'private';

    return { raw: line, kind: 'message', type, sender, recipient, text, timestamp: timestamp() };
  }

  // ATC FSD position: %CALLSIGN:FREQ:...
  // The frequency may arrive as 128.350, 128350, or 28350.
  if (line.startsWith('%')) {
    const parts = line.slice(1).split(':');
    const callsign = parts[0];
    const freq = normalizeAtcFrequency(parts[1]);
    const position = readLatLon(parts[5], parts[6]);
    if (callsign && callsign.includes('_')) {
      return {
        raw: line,
        kind: 'atc_detected',
        callsign,
        freq,
        lat: position ? position.lat : undefined,
        lon: position ? position.lon : undefined,
        timestamp: timestamp(),
      };
    }
  }

  if (line.startsWith('@')) {
    const parts = line.split(':');
    const callsign = parts[1];
    const lat = Number(parts[4]);
    const lon = Number(parts[5]);
    const squawk = normalizeSquawkCode(parts[2]);
    const xpdrMode = parseFsdXpdrMode(parts[0]);
    if (direction === 'outgoing' && Number.isFinite(lat) && Number.isFinite(lon)) {
      return {
        raw: line,
        kind: 'own_position',
        callsign,
        lat,
        lon,
        squawk,
        xpdrMode,
        timestamp: timestamp(),
      };
    }
  }

  if (line.startsWith('#AP')) {
    const callsign = line.slice(3).split(':')[0];
    return { raw: line, kind: 'login', callsign, timestamp: timestamp() };
  }

  if (line.startsWith('#DP')) {
    return { raw: line, kind: 'logout', callsign: line.slice(3).split(':')[0], timestamp: timestamp() };
  }

  if (line.startsWith('$ER')) {
    if (line.includes('FSD_FPL_ERROR')) {
      return { raw: line, kind: 'flight_plan_status', status: 'missing', timestamp: timestamp() };
    }
    return { raw: line, kind: 'message', type: 'system', sender: 'SERVER', text: line, timestamp: timestamp() };
  }

  // Voice request: $CQ{pilot}:SERVER:VOICE:{station}
  if (line.startsWith('$CQ')) {
    const parts = line.slice(3).split(':');
    if (parts.length >= 4 && parts[2] === 'VOICE') {
      return { raw: line, kind: 'atc_detected', callsign: parts[3], timestamp: timestamp() };
    }
  }

  // Voice reply: $CRSERVER:{pilot}:VOICE:{station}:{ts2Host}/{channel}
  if (line.startsWith('$CR')) {
    const parts = line.slice(3).split(':');
    if (parts.length >= 3 && parts[2] === 'FP') {
      return {
        raw: line,
        kind: 'flight_plan_status',
        status: 'filed',
        flightPlan: parseFlightPlanFields(parts.slice(3)),
        timestamp: timestamp(),
      };
    }
    if (parts.length >= 5 && parts[2] === 'VOICE') {
      const atc = parts[3];
      const voiceTarget = parts[4];
      const slash = voiceTarget.lastIndexOf('/');
      return {
        raw: line,
        kind: 'atc_voice_info',
        atc,
        ts2Server: slash >= 0 ? voiceTarget.slice(0, slash) : voiceTarget,
        channelName: slash >= 0 ? voiceTarget.slice(slash + 1) : atc,
        timestamp: timestamp(),
      };
    }
  }

  // METAR/TAF reply: &DSERVER:{callsign}:{0|1}:{text}
  if (line.startsWith('&D')) {
    const parts = line.slice(2).split(':');
    if (parts.length >= 4) {
      return {
        raw: line,
        kind: 'message',
        type: 'system',
        sender: parts[2] === '1' ? 'TAF' : 'METAR',
        recipient: parts[1],
        text: parts.slice(3).join(':'),
        timestamp: timestamp(),
      };
    }
  }

  return null;
}

function parseFlightPlanFields(parts) {
  // Standard FSD flight plans carry departure at field 5 and destination at
  // field 9 after the callsign. Some server replies wrap the plan in a $CR
  // envelope, so fall back to the first plausible ICAO pair if fixed fields do
  // not look valid.
  const fixed = {
    departure: normalizeIcao(parts[5]),
    destination: normalizeIcao(parts[9]),
    alternate: normalizeIcao(parts[14]),
  };
  if (fixed.departure && fixed.destination) return fixed;

  const candidates = parts.map(normalizeIcao).filter(Boolean);
  return {
    departure: fixed.departure || candidates[0] || '',
    destination: fixed.destination || candidates[1] || '',
    alternate: fixed.alternate || candidates[2] || '',
  };
}

function normalizeIcao(value) {
  const text = String(value || '').trim().toUpperCase();
  return /^[A-Z]{4}$/.test(text) ? text : '';
}

function normalizeAtcFrequency(value) {
  // IVAO can encode frequencies in a few historical forms. The webapp wants a
  // normal MHz string so station menus and COM setters share one format.
  const text = String(value || '').trim();
  if (!text) return '';

  if (/^1\d{2}\.\d{1,3}$/.test(text)) return Number(text).toFixed(3);
  if (/^1\d{5}$/.test(text)) return `${text.slice(0, 3)}.${text.slice(3)}`;
  if (/^\d{5}$/.test(text)) return `1${text.slice(0, 2)}.${text.slice(2)}`;

  return '';
}

function readLatLon(latValue, lonValue) {
  // Position lines occasionally contain empty, zero, or invalid coordinates.
  // Returning null keeps station-distance sorting from using bad data.
  const lat = Number(latValue);
  const lon = Number(lonValue);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

function normalizeSquawkCode(value) {
  // Squawk codes are four octal digits. Returning an empty string means the
  // source did not contain a usable transponder code.
  const text = String(value || '').trim();
  return /^[0-7]{4}$/.test(text) ? text : '';
}

function parseFsdXpdrMode(value) {
  // Pilot position lines start with a transponder flag such as @N or @S.
  // S is standby; other valid flags mean the transponder is active/ALT.
  const token = String(value || '').replace(/^@/, '').trim().toUpperCase();
  if (!token) return '';
  if (token.includes('S')) return 'stby';
  if (/^[A-Z]+$/.test(token)) return 'alt';
  return '';
}

function parseLines(buffer, chunk, onLine) {
  // TCP chunks do not align with FSD newlines. The caller owns the small tail
  // buffer, while this helper emits only complete lines.
  buffer.text += chunk.toString('utf8');
  const lines = buffer.text.split('\n');
  buffer.text = lines.pop();
  for (const line of lines) {
    if (line.trim()) onLine(line);
  }
}

function publicFsdEvent(msg) {
  // Raw FSD lines are useful while parsing, but they may contain chat text or
  // protocol details. The webapp receives only typed fields it actually uses.
  if (!msg || !Object.prototype.hasOwnProperty.call(msg, 'raw')) return msg;
  const { raw: _raw, ...publicMsg } = msg;
  return publicMsg;
}

function normalizeFsdRecipient(value) {
  const recipient = String(value || '').trim().toUpperCase();
  return /^(\*|@[0-9]{5}|[A-Z0-9_]{2,16})$/.test(recipient) ? recipient : '';
}

function normalizeFsdText(value) {
  // FSD is newline-delimited. Rejecting CR/LF at the web boundary prevents a
  // crafted local WebSocket message from injecting a second raw FSD command.
  const text = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  return limitUtf8Bytes(text, 1024);
}

function limitUtf8Bytes(text, maxBytes) {
  // JavaScript string length is not byte length. Trim from the end until the
  // UTF-8 payload fits the FSD text budget without cutting a character in half.
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end -= 1;
  return text.slice(0, end);
}

module.exports = {
  parseFsdLine,
  normalizeAtcFrequency,
  readLatLon,
  normalizeSquawkCode,
  parseFsdXpdrMode,
  parseLines,
  publicFsdEvent,
  normalizeFsdRecipient,
  normalizeFsdText,
  limitUtf8Bytes,
  parseFlightPlanFields,
};
