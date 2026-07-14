'use strict';

const fs = require('fs');
const os = require('os');

function readConfig(file) {
  // config.json is intentionally optional. Public installs can start from
  // config.example.json or run with these defaults.
  const defaults = {
    lanIp: '',
    voiceDecode: true,
    voiceDiagnostics: false,
    voiceSampleRate: 32000,
    voiceStripBytes: 1,
    voiceFramesPerPacket: 12,
    webTxEnabled: false,
    webTxSampleRate: 8000,
    webTxQuality: 10,
    webTxAbr: false,
    webTxBitrate: 0,
    webTxFramesPerPacket: 5,
    webTxPacketIntervalMs: 92,
    webTxPacketMode: 'fixed',
    remoteAgentEnabled: false,
    remoteRelayUrl: '',
    remoteRelayToken: '',
    remoteDeviceId: '',
    remoteDeviceName: '',
    remoteReconnectMs: 5000,
    updateCheckUrl: '',
  };

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return validateConfig({ ...defaults, ...raw }, defaults);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn('[CONFIG] config.json not found, using defaults. Copy config.example.json to config.json to customize.');
    } else {
      console.warn(`[CONFIG] config.json could not be read, using defaults: ${err.message}`);
    }
    return defaults;
  }
}

function validateConfig(config, defaults) {
  // Validation is fail-soft: a bad option should never stop the proxy from
  // starting. Instead, VoxHF warns and falls back to the known-safe default.
  const schemaKeys = new Set(Object.keys(defaults));
  for (const key of Object.keys(config)) {
    if (!schemaKeys.has(key)) console.warn(`[CONFIG] ${key}: unknown option ignored by VoxHF`);
  }

  config.lanIp = validateLanIp(config.lanIp, defaults.lanIp);
  config.voiceDecode = validateBoolean('voiceDecode', config.voiceDecode, defaults.voiceDecode);
  config.voiceDiagnostics = validateBoolean('voiceDiagnostics', config.voiceDiagnostics, defaults.voiceDiagnostics);
  config.webTxEnabled = validateBoolean('webTxEnabled', config.webTxEnabled, defaults.webTxEnabled);
  config.webTxAbr = validateBoolean('webTxAbr', config.webTxAbr, defaults.webTxAbr);
  config.remoteAgentEnabled = validateBoolean('remoteAgentEnabled', config.remoteAgentEnabled, defaults.remoteAgentEnabled);

  config.voiceSampleRate = validateChoice('voiceSampleRate', config.voiceSampleRate, [8000, 16000, 32000], defaults.voiceSampleRate);
  config.webTxSampleRate = validateChoice('webTxSampleRate', config.webTxSampleRate, [8000, 16000, 32000], defaults.webTxSampleRate);
  config.voiceStripBytes = validateInteger('voiceStripBytes', config.voiceStripBytes, defaults.voiceStripBytes, 0, 8);
  config.voiceFramesPerPacket = validateInteger('voiceFramesPerPacket', config.voiceFramesPerPacket, defaults.voiceFramesPerPacket, 1, 20);
  config.webTxQuality = validateInteger('webTxQuality', config.webTxQuality, defaults.webTxQuality, 0, 10);
  config.webTxBitrate = validateInteger('webTxBitrate', config.webTxBitrate, defaults.webTxBitrate, 0, 128000);
  config.webTxFramesPerPacket = validateInteger('webTxFramesPerPacket', config.webTxFramesPerPacket, defaults.webTxFramesPerPacket, 1, 12);
  config.webTxPacketIntervalMs = validateInteger('webTxPacketIntervalMs', config.webTxPacketIntervalMs, defaults.webTxPacketIntervalMs, 20, 1000);
  config.remoteReconnectMs = validateInteger('remoteReconnectMs', config.remoteReconnectMs, defaults.remoteReconnectMs, 1000, 60000);

  config.remoteRelayUrl = validateTextOption('remoteRelayUrl', config.remoteRelayUrl, defaults.remoteRelayUrl, 512);
  config.remoteRelayToken = validateTextOption('remoteRelayToken', config.remoteRelayToken, defaults.remoteRelayToken, 512);
  config.remoteDeviceId = validateTextOption('remoteDeviceId', config.remoteDeviceId, defaults.remoteDeviceId, 160);
  config.remoteDeviceName = validateTextOption('remoteDeviceName', config.remoteDeviceName, defaults.remoteDeviceName, 128);
  config.updateCheckUrl = validateTextOption('updateCheckUrl', config.updateCheckUrl, defaults.updateCheckUrl, 512);

  if (!['fixed', 'variable'].includes(config.webTxPacketMode)) {
    warnConfigDefault('webTxPacketMode', config.webTxPacketMode, defaults.webTxPacketMode);
    config.webTxPacketMode = defaults.webTxPacketMode;
  }

  return config;
}

function validateLanIp(value, fallback) {
  // Empty lanIp means auto-detect. A configured address is accepted only when it
  // looks like a valid IPv4 literal; availability is checked later.
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) {
    const parts = text.split('.').map(Number);
    if (parts.every((part) => part >= 0 && part <= 255)) return text;
  }
  warnConfigDefault('lanIp', value, fallback || 'auto');
  return fallback;
}

function validateBoolean(key, value, fallback) {
  // Keep booleans strict so typos such as "true" are visible in the console.
  if (typeof value === 'boolean') return value;
  warnConfigDefault(key, value, fallback);
  return fallback;
}

function validateChoice(key, value, allowed, fallback) {
  // Some codec parameters must stay in a small known set because ffmpeg/Speex
  // combinations outside it can produce audio that TS2 cannot understand.
  const number = Number(value);
  if (allowed.includes(number)) return number;
  warnConfigDefault(key, value, fallback);
  return fallback;
}

function validateInteger(key, value, fallback, min, max) {
  // Numeric ranges are part safety guard, part documentation of the supported
  // tuning surface.
  const number = Number(value);
  if (Number.isInteger(number) && number >= min && number <= max) return number;
  warnConfigDefault(key, value, fallback);
  return fallback;
}

function validateTextOption(key, value, fallback, maxBytes) {
  // Remote settings are user-provided strings. Keep them bounded so a broken
  // config cannot create huge logs or oversized protocol payloads.
  const text = String(value ?? '').trim();
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  warnConfigDefault(key, value, fallback);
  return fallback;
}

function warnConfigDefault(key, value, fallback) {
  console.warn(`[CONFIG] ${key}: invalid value ${JSON.stringify(value)}, using ${JSON.stringify(fallback)}`);
}

function listLocalNetworkIps() {
  // Prefer real LAN/Wi-Fi adapters, but keep the scoring simple and visible.
  // A manual config.lanIp override is still available when auto-detection is
  // wrong on unusual network setups.
  const ifaceScore = (name) => {
    if (/virtual|vmware|virtualbox|docker|wsl|hyper-v|vethernet/i.test(name)) return -20;
    if (/wi-?fi|wlan|wireless|ethernet/i.test(name)) return 10;
    return 0;
  };

  const ipScore = (ip) => {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return -1;
    if (ip.startsWith('127.') || ip.startsWith('169.254.')) return -1;
    if (ip.startsWith('192.168.1.')) return 50;
    if (ip.startsWith('192.168.') && !ip.startsWith('192.168.56.')) return 40;
    if (ip.startsWith('10.')) return 30;
    const second = Number(ip.split('.')[1]);
    if (ip.startsWith('172.') && second >= 16 && second <= 31) return 30;
    if (ip.startsWith('192.168.56.')) return 5;
    return 1;
  };

  return Object.entries(os.networkInterfaces())
    .flatMap(([name, interfaces]) => (interfaces || [])
      .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
      .map((iface) => ({ ip: iface.address, score: ipScore(iface.address) + ifaceScore(name), name })))
    .filter((candidate) => candidate.score >= 0)
    .sort((a, b) => b.score - a.score);
}

function detectLanIp(configuredIp, candidates) {
  // A configured IP is used only if Windows currently exposes it. This avoids
  // advertising stale addresses after switching between Ethernet and Wi-Fi.
  if (candidates.some((candidate) => candidate.ip === configuredIp)) return configuredIp;
  if (configuredIp) {
    console.warn(`[CONFIG] lanIp ${configuredIp} is not available, using ${candidates[0]?.ip || '127.0.0.1'}`);
  }
  return candidates[0]?.ip || '127.0.0.1';
}

module.exports = {
  readConfig,
  listLocalNetworkIps,
  detectLanIp,
};
