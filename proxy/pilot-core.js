'use strict';

const MAX_PILOT_CORE_FRAME_BYTES = 1024 * 1024;

function makeFreqPacket(com, freqMhz) {
  // PilotUI/PilotCore binary packet:
  // [07 00 00 00 20 20 COM F0 F1 F2 00], frequency in kHz little-endian.
  const freqKhz = Math.round(Number(freqMhz) * 1000);
  const buf = Buffer.alloc(11);
  buf[0] = 0x07;
  buf[4] = 0x20;
  buf[5] = 0x20;
  buf[6] = com;
  buf.writeUIntLE(freqKhz, 7, 3);
  return buf;
}

function makeSquawkPacket(code) {
  // Fixed header plus 4-digit ASCII squawk.
  const header = Buffer.from([12, 0, 0, 0, 0, 0x30, 0, 0x01, 4, 0, 0, 0]);
  return Buffer.concat([header, Buffer.from(String(code).padStart(4, '0'), 'ascii')]);
}

function makeCoreFrame(type, payload) {
  // Some PilotCore -> PilotUI feedback messages are framed as:
  // uint32 length, uint32 type, uint32 payloadLength, payload ASCII.
  const body = Buffer.from(String(payload), 'ascii');
  const frame = Buffer.alloc(12 + body.length);
  frame.writeUInt32LE(8 + body.length, 0);
  frame.writeUInt32LE(type >>> 0, 4);
  frame.writeUInt32LE(body.length, 8);
  body.copy(frame, 12);
  return frame;
}

function encodeMessagePack(value) {
  if (value === null) return Buffer.from([0xc0]);
  if (value === false) return Buffer.from([0xc2]);
  if (value === true) return Buffer.from([0xc3]);

  if (Number.isInteger(value) && value >= 0) {
    if (value < 0x80) return Buffer.from([value]);
    if (value <= 0xff) return Buffer.from([0xcc, value]);
    if (value <= 0xffff) {
      const buffer = Buffer.alloc(3);
      buffer[0] = 0xcd;
      buffer.writeUInt16BE(value, 1);
      return buffer;
    }
    if (value <= 0xffffffff) {
      const buffer = Buffer.alloc(5);
      buffer[0] = 0xce;
      buffer.writeUInt32BE(value, 1);
      return buffer;
    }
  }

  if (typeof value === 'string') {
    const body = Buffer.from(value, 'utf8');
    if (body.length < 32) return Buffer.concat([Buffer.from([0xa0 | body.length]), body]);
    if (body.length <= 0xff) return Buffer.concat([Buffer.from([0xd9, body.length]), body]);
    if (body.length <= 0xffff) {
      const header = Buffer.alloc(3);
      header[0] = 0xda;
      header.writeUInt16BE(body.length, 1);
      return Buffer.concat([header, body]);
    }
  }

  if (Array.isArray(value)) {
    if (value.length >= 16) throw new RangeError('PilotCore MessagePack arrays are limited to 15 items');
    return Buffer.concat([Buffer.from([0x90 | value.length]), ...value.map(encodeMessagePack)]);
  }

  throw new TypeError(`Unsupported PilotCore MessagePack value: ${typeof value}`);
}

function makeMessagePackFrame(type, payload) {
  const body = encodeMessagePack([type, payload]);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function makeV114FreqPacket(com, freqMhz) {
  return makeMessagePackFrame(0x1800, [com === 2 ? 2 : 1, Math.round(Number(freqMhz) * 1000)]);
}

function makeV114SquawkPacket(code) {
  // Altitude 1.14 sends squawk changes through the generic PilotCore event
  // envelope. The code remains a four-character decimal string so leading
  // zeroes are not lost (for example 0421).
  return makeV114CoreEventFrame(0x0100, String(code).padStart(4, '0'));
}

function makeV114XpdrTogglePacket() {
  // Altitude 1.14's PilotUI sendTransponderToggle slot emits 0x1601.
  return makeMessagePackFrame(0x1601, []);
}

function makeV114IdentPacket() {
  // Altitude 1.14's PilotUI sendTransponderIdent slot emits 0x1602.
  return makeMessagePackFrame(0x1602, []);
}

function makeV114RadioVolumePacket(com, volume) {
  // PilotUI sends VHF volume updates through the generic PilotCore event
  // envelope as "radio|volume", with volume expressed from 0 to 100.
  const radio = com === 2 ? 2 : 1;
  const level = Math.round(Number(volume));
  if (!Number.isFinite(level) || level < 0 || level > 100) {
    throw new RangeError('PilotCore radio volume must be between 0 and 100');
  }
  return makeV114CoreEventFrame(0xdde6, `${radio}|${level}`);
}

function makeV114CoreEventFrame(type, payload) {
  return makeMessagePackFrame(0x3000, [type, String(payload)]);
}

function decodeMessagePack(buffer) {
  let offset = 0;

  function requireBytes(count) {
    if (offset + count > buffer.length) throw new RangeError('Truncated PilotCore MessagePack value');
  }

  function read() {
    requireBytes(1);
    const marker = buffer[offset++];
    if (marker <= 0x7f) return marker;
    if (marker >= 0xe0) return marker - 0x100;
    if ((marker & 0xe0) === 0xa0) return readString(marker & 0x1f);
    if ((marker & 0xf0) === 0x90) return readArray(marker & 0x0f);
    if ((marker & 0xf0) === 0x80) return readMap(marker & 0x0f);

    switch (marker) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xca:
        requireBytes(4);
        offset += 4;
        return buffer.readFloatBE(offset - 4);
      case 0xcb:
        requireBytes(8);
        offset += 8;
        return buffer.readDoubleBE(offset - 8);
      case 0xcc:
        requireBytes(1);
        return buffer[offset++];
      case 0xcd:
        requireBytes(2);
        offset += 2;
        return buffer.readUInt16BE(offset - 2);
      case 0xce:
        requireBytes(4);
        offset += 4;
        return buffer.readUInt32BE(offset - 4);
      case 0xd0:
        requireBytes(1);
        return buffer.readInt8(offset++);
      case 0xd1:
        requireBytes(2);
        offset += 2;
        return buffer.readInt16BE(offset - 2);
      case 0xd2:
        requireBytes(4);
        offset += 4;
        return buffer.readInt32BE(offset - 4);
      case 0xd9:
        requireBytes(1);
        return readString(buffer[offset++]);
      case 0xda:
        requireBytes(2);
        offset += 2;
        return readString(buffer.readUInt16BE(offset - 2));
      case 0xdc:
        requireBytes(2);
        offset += 2;
        return readArray(buffer.readUInt16BE(offset - 2));
      case 0xde:
        requireBytes(2);
        offset += 2;
        return readMap(buffer.readUInt16BE(offset - 2));
      default:
        throw new TypeError(`Unsupported PilotCore MessagePack marker 0x${marker.toString(16)}`);
    }
  }

  function readString(length) {
    requireBytes(length);
    const value = buffer.toString('utf8', offset, offset + length);
    offset += length;
    return value;
  }

  function readArray(length) {
    if (length > 256) throw new RangeError('PilotCore MessagePack array is too large');
    return Array.from({ length }, read);
  }

  function readMap(length) {
    if (length > 256) throw new RangeError('PilotCore MessagePack map is too large');
    const value = {};
    for (let index = 0; index < length; index++) value[String(read())] = read();
    return value;
  }

  const value = read();
  if (offset !== buffer.length) throw new RangeError('Trailing bytes in PilotCore MessagePack frame');
  return value;
}

function createMessagePackFrameReader(onMessage) {
  let pending = Buffer.alloc(0);

  return function push(data) {
    if (!Buffer.isBuffer(data) || !data.length) return;
    pending = pending.length ? Buffer.concat([pending, data]) : data;

    while (pending.length >= 4) {
      const bodyLength = pending.readUInt32LE(0);
      if (bodyLength < 1 || bodyLength > MAX_PILOT_CORE_FRAME_BYTES) {
        pending = Buffer.alloc(0);
        return;
      }
      if (pending.length < bodyLength + 4) return;

      const body = pending.subarray(4, bodyLength + 4);
      pending = pending.subarray(bodyLength + 4);
      try {
        onMessage(decodeMessagePack(body));
      } catch {
        // The bridge still forwards unknown frames byte-for-byte. Observation
        // must never make a new Altitude message version fail closed.
      }
    }
  };
}

function formatComFrequency(freq) {
  const value = Number(String(freq || '').replace(',', '.'));
  return Number.isFinite(value) ? value.toFixed(3) : '';
}

function normalizePilotComFrequency(freq) {
  // Web and remote controls can request COM changes, but PilotCore should only
  // receive normal VHF COM frequencies in MHz.
  const formatted = formatComFrequency(freq);
  const value = Number(formatted);
  if (!/^1[0-9]{2}\.[0-9]{3}$/.test(formatted)) return '';
  if (value < 118 || value > 136.975) return '';
  return formatted;
}

function loopbackSameLength(len) {
  // PilotUI/PilotCore packets contain length-sensitive text fields. These
  // padded loopback forms let us replace an IP without changing packet size.
  const values = {
    9: '127.0.0.1',
    10: '127.0.0.01',
    11: '127.0.00.01',
    12: '127.00.0.001',
    13: '127.000.0.001',
    14: '127.000.00.001',
    15: '127.000.000.001',
  };
  return values[len] || '127.000.0.001';
}

function extractCoreTextPayloads(data) {
  // PilotCore UI events often use:
  // uint32 frameLength, uint32 type, uint32 payloadLength, payload ASCII.
  // The parser is deliberately tolerant because multiple frames can share one
  // TCP chunk and unrelated binary data can appear before or after them.
  const payloads = [];
  for (let i = 0; i + 12 <= data.length; i++) {
    const frameLength = data.readUInt32LE(i);
    const payloadLength = data.readUInt32LE(i + 8);
    const totalLength = 4 + frameLength;
    if (frameLength < 8 || payloadLength > frameLength - 8) continue;
    if (totalLength < 12 || i + totalLength > data.length) continue;

    const payload = data.slice(i + 12, i + 12 + payloadLength);
    if (isMostlyPrintable(payload)) payloads.push(payload.toString('ascii').replace(/\0/g, ' ').trim());
    i += totalLength - 1;
  }
  return payloads.filter(Boolean);
}

function isMostlyPrintable(buffer) {
  if (!buffer.length) return false;
  let printable = 0;
  for (const byte of buffer) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)) printable++;
  }
  return printable / buffer.length >= 0.85;
}

function parseComToken(value) {
  const match = String(value || '').trim().toUpperCase().match(/^(?:COM|COMM|RADIO)?([12])$/);
  return match ? Number(match[1]) : 0;
}

function normalizeComCandidate(value) {
  const text = String(value || '').trim().replace(',', '.');
  let mhz = '';
  if (/^1[1-3]\d\.\d{1,3}$/.test(text)) mhz = Number(text).toFixed(3);
  else if (/^1[1-3]\d\d{3}$/.test(text)) mhz = `${text.slice(0, 3)}.${text.slice(3)}`;
  else if (/^\d{5}$/.test(text)) mhz = `1${text.slice(0, 2)}.${text.slice(2)}`;

  const number = Number(mhz);
  if (!Number.isFinite(number) || number < 118 || number > 137) return '';
  return number.toFixed(3);
}

module.exports = {
  makeFreqPacket,
  makeSquawkPacket,
  makeCoreFrame,
  makeMessagePackFrame,
  makeV114FreqPacket,
  makeV114SquawkPacket,
  makeV114XpdrTogglePacket,
  makeV114IdentPacket,
  makeV114RadioVolumePacket,
  makeV114CoreEventFrame,
  decodeMessagePack,
  createMessagePackFrameReader,
  formatComFrequency,
  normalizePilotComFrequency,
  loopbackSameLength,
  extractCoreTextPayloads,
  isMostlyPrintable,
  parseComToken,
  normalizeComCandidate,
};
