'use strict';

// Exercise the actual FSD proxy data handlers with deterministic TCP chunks.
// Real TCP writes may be coalesced, so fake sockets are necessary to cover
// every byte boundary reliably without connecting to IVAO or PilotCore.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { createRequire } = require('module');

const filename = path.resolve(__dirname, '../proxy/fsd-proxy.js');
const source = fs.readFileSync(filename, 'utf8');
const localRequire = createRequire(filename);
const lanIp = '192.0.2.10';
const voice = Buffer.from('$CRSERVER:TEST123:VOICE:TEST_TWR:voice.example/TEST_TWR\r\n');
const expectedVoice = Buffer.from(voice.toString().replace('voice.example', lanIp));

class Socket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.sent = [];
  }
  write(data) { this.sent.push(Buffer.from(data)); return true; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
  bytes() { return Buffer.concat(this.sent); }
}

function harness() {
  let accept;
  let remote;
  let connected;
  let online = false;
  const events = [];
  const hosts = [];
  const errors = [];
  const closes = [];
  const weather = [];
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Buffer, console,
    require(name) {
      if (name !== 'net') return localRequire(name);
      return {
        createServer(callback) { accept = callback; return {}; },
        createConnection(_options, callback) {
          remote = new Socket();
          connected = callback;
          return remote;
        },
      };
    },
  }, { filename });
  const proxy = module.exports.createFsdProxy({
    getHost: () => 'fsd.example',
    logger: { log() {}, error: message => errors.push(message) },
    getVoiceEndpoint(host) { hosts.push(host); return lanIp; },
    onClose: meta => closes.push(meta),
    state: {
      getCallsign: () => 'TEST123', getConnected: () => online,
      setConnected(value) { online = value; }, rememberFsdState() {},
      broadcast: event => events.push(event),
      updateWeather: (...args) => weather.push(args),
    },
  });
  return {
    events, hosts, errors, closes, weather, proxy,
    connect() {
      const core = new Socket();
      accept(core);
      connected();
      return { core, remote };
    },
  };
}

// Every split position, including the prefix, hostname, slash and CR/LF.
for (let split = 0; split <= voice.length; split += 1) {
  const h = harness();
  const { core, remote } = h.connect();
  remote.emit('data', voice.subarray(0, split));
  if (split < voice.length) assert.equal(core.bytes().length, 0, `early forwarding at ${split}`);
  remote.emit('data', voice.subarray(split));
  assert.deepEqual(core.bytes(), expectedVoice, `wrong rewrite at ${split}`);
  assert.equal(h.events.filter(event => event.kind === 'atc_voice_info').length, 1);
  assert.ok(h.hosts.includes('voice.example'));
  assert.equal(h.errors.length, 0);
}

// Preserve unrelated records exactly, including empty lines, UTF-8 characters,
// non-UTF-8 bytes, multiple replies and already-local voice targets.
const unrelated = Buffer.concat([
  Buffer.from('\r\n\n#TMOTHER:TEST123:caf\u00e9 \u2708\n'),
  Buffer.from([0x23, 0x3f, 0xff, 0xfe, 0x0d, 0x0a]),
]);
const voiceLf = Buffer.from('$CRSERVER:TEST123:VOICE:OTHER_APP:other.example/OTHER_APP\n');
const voiceUtf8 = Buffer.from('$CRSERVER:TEST123:VOICE:OTHER_APP:other.example/caf\u00e9\n');
const stream = Buffer.concat([unrelated, voice, voiceLf, expectedVoice, voiceUtf8]);
const expectedStream = Buffer.concat([
  unrelated, expectedVoice,
  Buffer.from(voiceLf.toString().replace('other.example', lanIp)),
  expectedVoice, Buffer.from(voiceUtf8.toString().replace('other.example', lanIp)),
]);
for (const chunks of [[stream], Array.from(stream, byte => Buffer.from([byte]))]) {
  const h = harness();
  const { core, remote } = h.connect();
  for (const chunk of chunks) remote.emit('data', chunk);
  assert.deepEqual(core.bytes(), expectedStream);
  assert.equal(h.events.filter(event => event.kind === 'atc_voice_info').length, 4);
  assert.equal(h.events.find(event => event.kind === 'message').text, 'caf\u00e9 \u2708');
}

// Forward complete records immediately, retaining only the unfinished tail.
{
  const { core, remote } = harness().connect();
  remote.emit('data', Buffer.concat([unrelated, voice.subarray(0, 20)]));
  assert.deepEqual(core.bytes(), unrelated);
  remote.emit('data', voice.subarray(20));
  assert.deepEqual(core.bytes(), Buffer.concat([unrelated, expectedVoice]));
  const outgoing = Buffer.from('#TMTEST123:OTHER:hello\n');
  core.emit('data', outgoing.subarray(0, 4));
  assert.deepEqual(remote.bytes(), outgoing.subarray(0, 4), 'outgoing forwarding must remain immediate');
  core.emit('data', outgoing.subarray(4));
  assert.deepEqual(remote.bytes(), outgoing);
}

// An incomplete old connection must not contaminate a replacement connection.
{
  const h = harness();
  const first = h.connect();
  first.remote.emit('data', voice.subarray(0, 30));
  first.remote.destroy();
  assert.equal(first.core.bytes().length, 0);
  const second = h.connect();
  second.remote.emit('data', voice);
  assert.deepEqual(second.core.bytes(), expectedVoice);
}

// Enforce a per-record bound, not a per-chunk limit. Never log the payload.
for (const suffix of ['', '\n']) {
  const h = harness();
  const { core, remote } = h.connect();
  remote.emit('data', Buffer.from('x'.repeat(65537) + suffix));
  assert.equal(core.destroyed, true);
  assert.equal(remote.destroyed, true);
  assert.equal(core.bytes().length, 0);
  assert.equal(h.errors.length, 1);
  assert.ok(h.errors[0].includes('64 KiB'));
  assert.equal(h.closes.length, 1);
  assert.equal(h.closes[0].wasConnected, true);
}
{
  const { core, remote } = harness().connect();
  const largeBatch = Buffer.from('x'.repeat(65536) + '\n' + 'short\n'.repeat(12000));
  remote.emit('data', largeBatch);
  assert.deepEqual(core.bytes(), largeBatch);
  assert.equal(core.destroyed, false);
}
{
  const { core, remote } = harness().connect();
  remote.emit('data', Buffer.alloc(65536, 0x78));
  assert.equal(core.destroyed, false);
  remote.emit('data', Buffer.from('x'));
  assert.equal(core.destroyed, true);
}

// Corrected observations must satisfy pending panel requests, not fall through
// into chat merely because COR precedes the ICAO code. Raw reports stay intact.
for (const [kind, type, raw] of [
  ['metar', 0, 'METAR COR EGLL 051400Z 12007MPS 9999 Q1015'],
  ['metar', 0, 'SPECI COR EGLL 051400Z 12007KT 0000 Q1015'],
  ['taf', 1, 'TAF COR EGLL 051400Z 0515/0615 12007MPS 9999'],
]) {
  const h = harness();
  const { core, remote } = h.connect();
  assert.equal(h.proxy.sendWeatherRequest(kind, 'EGLL', () => {}, { source: 'panel', role: 'destination' }), true);
  const reply = Buffer.from(`&DSERVER:TEST123:${type}:${raw}\r\n`);
  remote.emit('data', reply);
  assert.deepEqual(h.weather, [['destination', kind, 'EGLL', raw]]);
  assert.equal(h.events.length, 0, 'panel weather must not leak into chat');
  assert.deepEqual(core.bytes(), reply, 'weather text forwarded to PilotCore must stay unchanged');
}

console.log('[OK] FSD stream framing, voice rewriting, byte preservation, bounded tails and corrected panel weather');
