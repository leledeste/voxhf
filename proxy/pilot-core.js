'use strict';

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
  formatComFrequency,
  normalizePilotComFrequency,
  loopbackSameLength,
  extractCoreTextPayloads,
  isMostlyPrintable,
  parseComToken,
  normalizeComCandidate,
};
