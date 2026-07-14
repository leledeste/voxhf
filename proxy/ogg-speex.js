'use strict';

// Ogg pages include a CRC calculated with the Ogg polynomial. ffmpeg rejects
// pages with a wrong CRC, so the proxy computes it when wrapping raw Speex.
const CRC32_OGG = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    table[i] = r;
  }
  return table;
})();

function oggCrc(page) {
  // The checksum field is zero while the page is being built, then filled with
  // the result returned here.
  let crc = 0;
  for (const b of page) crc = (((crc << 8) >>> 0) ^ CRC32_OGG[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc;
}

class OggSpeexWriter {
  // ffmpeg expects a small Ogg/Speex stream, while IVAO/TS2 gives us raw Speex
  // payloads. This class wraps each raw payload into enough Ogg pages for
  // ffmpeg to decode or monitor it.
  constructor(sampleRate, framesPerPacket) {
    this.sampleRate = sampleRate;
    this.framesPerPacket = framesPerPacket;
    this.serial = (Math.random() * 0xffffffff) >>> 0;
    this.seq = 0;
    this.granule = 0n;
    this.frameSize = sampleRate === 16000 ? 320 : sampleRate === 32000 ? 640 : 160;
  }

  headers() {
    // Speex-in-Ogg starts with an identification packet and a comment packet.
    // The fields used here are the minimal ones ffmpeg needs to decode.
    const header = Buffer.alloc(80);
    header.write('Speex   ', 0, 'ascii');
    header.write('1.2.1', 8, 'ascii');
    header.writeUInt32LE(1, 28);
    header.writeUInt32LE(80, 32);
    header.writeUInt32LE(this.sampleRate, 36);
    header.writeUInt32LE(this.sampleRate === 32000 ? 2 : this.sampleRate === 16000 ? 1 : 0, 40);
    header.writeUInt32LE(4, 44);
    header.writeUInt32LE(1, 48);
    header.writeInt32LE(-1, 52);
    header.writeUInt32LE(this.frameSize, 56);
    header.writeUInt32LE(0, 60);
    header.writeUInt32LE(this.framesPerPacket, 64);

    const vendor = Buffer.from('VoxHF', 'ascii');
    const comment = Buffer.alloc(8 + vendor.length);
    comment.writeUInt32LE(vendor.length, 0);
    vendor.copy(comment, 4);
    comment.writeUInt32LE(0, 4 + vendor.length);

    return Buffer.concat([this.page(header, 0x02, 0n), this.page(comment, 0x00, 0n)]);
  }

  frame(data) {
    // Granule position advances by decoded samples, not by encoded bytes. This
    // keeps ffmpeg timing stable while the browser receives streaming PCM.
    this.granule += BigInt(this.frameSize * this.framesPerPacket);
    return this.page(data, 0x00, this.granule);
  }

  page(data, flags, granule) {
    // Ogg stores packet sizes as lacing values. A value of 255 means the packet
    // continues into the next segment; values below 255 finish the packet.
    const segments = [];
    for (let left = data.length; left >= 255; left -= 255) segments.push(255);
    segments.push(data.length % 255);

    const page = Buffer.alloc(27 + segments.length + data.length);
    page.write('OggS', 0, 'ascii');
    page[5] = flags;
    page.writeBigInt64LE(granule, 6);
    page.writeUInt32LE(this.serial, 14);
    page.writeUInt32LE(this.seq++, 18);
    page[26] = segments.length;
    Buffer.from(segments).copy(page, 27);
    data.copy(page, 27 + segments.length);
    page.writeUInt32LE(oggCrc(page), 22);
    return page;
  }
}

class OggPacketReader {
  // ffmpeg encodes browser PCM as an Ogg/Speex stream. TS2 does not want Ogg;
  // it wants raw Speex packets. This reader unwraps complete Ogg packets from
  // arbitrary stdout chunks and skips the first two Speex header packets.
  constructor(onPacket) {
    this.onPacket = onPacket;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    this.count = 0;
  }

  push(chunk) {
    // stdout chunks from ffmpeg are arbitrary. The reader keeps a rolling
    // buffer, finds complete Ogg pages, then rebuilds complete Speex packets
    // from their lacing segments.
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 27) {
      const start = this.buffer.indexOf('OggS');
      if (start < 0) { this.buffer = Buffer.alloc(0); return; }
      if (start > 0) this.buffer = this.buffer.slice(start);
      if (this.buffer.length < 27) return;

      const segCount = this.buffer[26];
      const tableStart = 27;
      const dataStart = 27 + segCount;
      if (this.buffer.length < dataStart) return;

      let dataLen = 0;
      for (let i = 0; i < segCount; i++) dataLen += this.buffer[tableStart + i];
      const pageLen = dataStart + dataLen;
      if (this.buffer.length < pageLen) return;

      const data = this.buffer.slice(dataStart, pageLen);
      const segs = this.buffer.slice(tableStart, dataStart);
      this.buffer = this.buffer.slice(pageLen);

      let offset = 0;
      for (const len of segs) {
        this.pending.push(data.slice(offset, offset + len));
        offset += len;
        if (len < 255) {
          const packet = Buffer.concat(this.pending);
          this.pending = [];
          this.count++;
          if (this.count > 2 && packet.length) this.onPacket(packet);
        }
      }
    }
  }
}

module.exports = {
  OggSpeexWriter,
  OggPacketReader,
};
