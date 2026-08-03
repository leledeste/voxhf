'use strict';

const net = require('net');

const DEFAULT_OFFLINE_DELAY_MS = 30_000;
const DEFAULT_MAX_TICKET_LIFETIME_MS = 20 * 60 * 1000;
const DEFAULT_FIRED_RECEIPT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_TICKETS = 32;
const DEFAULT_MAX_BATCHES_PER_DEVICE = 4;
const MAX_TICKET_BODY_BYTES = 16 * 1024;

function createAgentWatchdog(options = {}) {
  // Tickets contain a pre-encrypted, pre-signed Web Push request. The relay
  // holds them only in memory and can send them unchanged, but cannot decrypt
  // their payload or create another notification without the proxy VAPID key.
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const sendTicket = options.sendTicket || (ticket => sendSealedPushTicket(ticket, options));
  const onFired = options.onFired || (() => {});
  const logger = options.logger || console;
  const offlineDelayMs = positiveInteger(options.offlineDelayMs, DEFAULT_OFFLINE_DELAY_MS);
  const maxTicketLifetimeMs = positiveInteger(options.maxTicketLifetimeMs, DEFAULT_MAX_TICKET_LIFETIME_MS);
  const firedReceiptTtlMs = positiveInteger(options.firedReceiptTtlMs, DEFAULT_FIRED_RECEIPT_TTL_MS);
  const maxTickets = positiveInteger(options.maxTickets, DEFAULT_MAX_TICKETS);
  const maxBatchesPerDevice = positiveInteger(options.maxBatchesPerDevice, DEFAULT_MAX_BATCHES_PER_DEVICE);

  const active = new Map();
  const batches = new Map();
  const fired = new Map();
  let generation = 0;

  function stage(deviceKey, payload) {
    // Tickets arrive separately to keep protocol envelopes bounded. They are
    // inert until an entire batch is committed atomically for the agent.
    cleanup();
    const expiresAtMs = Date.parse(payload.ticket.expiresAt);
    const currentTime = Number(now());
    if (!Number.isFinite(expiresAtMs)
      || expiresAtMs <= currentTime + offlineDelayMs
      || expiresAtMs > currentTime + maxTicketLifetimeMs) {
      return { ok: false, error: 'watchdog ticket expiry is outside the allowed window' };
    }
    if (!isAllowedPushEndpoint(payload.ticket.endpoint, options.allowedPushOrigins)) {
      return { ok: false, error: 'watchdog push endpoint is not allowlisted' };
    }

    const key = batchKey(deviceKey, payload.batchId);
    let batch = batches.get(key);
    if (!batch) {
      const deviceBatchCount = Array.from(batches.values())
        .filter(candidate => candidate.deviceKey === deviceKey).length;
      if (deviceBatchCount >= maxBatchesPerDevice) {
        return { ok: false, error: 'too many pending watchdog batches' };
      }
      batch = {
        deviceKey,
        sessionId: payload.sessionId,
        batchId: payload.batchId,
        createdAtMs: currentTime,
        tickets: new Map(),
      };
      batches.set(key, batch);
    }
    if (batch.sessionId !== payload.sessionId) {
      return { ok: false, error: 'watchdog batch session mismatch' };
    }
    if (!batch.tickets.has(payload.ticket.deviceId) && batch.tickets.size >= maxTickets) {
      return { ok: false, error: 'too many watchdog tickets' };
    }
    batch.tickets.set(payload.ticket.deviceId, { ...payload.ticket });
    return { ok: true, ticketCount: batch.tickets.size };
  }

  function commit(deviceKey, payload) {
    // Replacing the active batch prevents old subscriptions from surviving a
    // device opt-out or a periodic ticket refresh.
    cleanup();
    const key = batchKey(deviceKey, payload.batchId);
    const batch = batches.get(key);
    if (!batch || batch.sessionId !== payload.sessionId || batch.tickets.size < 1) {
      return { ok: false, error: 'watchdog batch is missing or empty' };
    }

    clearActiveTimer(deviceKey);
    deleteDeviceBatches(deviceKey);
    fired.delete(deviceKey);
    active.set(deviceKey, {
      sessionId: payload.sessionId,
      tickets: Array.from(batch.tickets.values()),
      offlineTimer: null,
      offlineGeneration: 0,
    });
    return { ok: true, ticketCount: batch.tickets.size };
  }

  function disarm(deviceKey, sessionId) {
    // A mismatched session cannot disarm a newer flight. The delivery receipt
    // is returned only to the matching proxy to avoid duplicate local alerts.
    cleanup();
    const current = active.get(deviceKey);
    if (!current || !sessionId || current.sessionId === sessionId) {
      clearActiveTimer(deviceKey);
      active.delete(deviceKey);
      deleteDeviceBatches(deviceKey);
    }

    const receipt = fired.get(deviceKey);
    const didFire = Boolean(receipt && receipt.sessionId === sessionId && receipt.status === 'sent');
    if (didFire) fired.delete(deviceKey);
    return { ok: true, fired: didFire };
  }

  function agentOnline(deviceKey) {
    clearActiveTimer(deviceKey);
  }

  function agentOffline(deviceKey) {
    cleanup();
    const current = active.get(deviceKey);
    if (!current || current.offlineTimer || !current.tickets.length) return false;
    const expectedGeneration = ++generation;
    current.offlineGeneration = expectedGeneration;
    current.offlineTimer = setTimer(
      () => fire(deviceKey, current.sessionId, expectedGeneration),
      offlineDelayMs,
    );
    return true;
  }

  async function fire(deviceKey, sessionId, expectedGeneration) {
    // Generation checking makes an old grace-period callback harmless after a
    // reconnect, refresh, disarm, or replacement batch.
    const current = active.get(deviceKey);
    if (!current
      || current.sessionId !== sessionId
      || current.offlineGeneration !== expectedGeneration) return false;

    active.delete(deviceKey);
    deleteDeviceBatches(deviceKey);
    const currentTime = Number(now());
    const tickets = current.tickets.filter(ticket => Date.parse(ticket.expiresAt) > currentTime);
    const receipt = {
      sessionId,
      status: 'sending',
      expiresAtMs: currentTime + firedReceiptTtlMs,
    };
    fired.set(deviceKey, receipt);

    const results = await Promise.allSettled(tickets.map(ticket => sendTicket(ticket)));
    const sent = results.filter(result => result.status === 'fulfilled' && result.value?.sent === true).length;
    const failed = results.length - sent;
    if (sent) logger.log(`[WATCHDOG] Agent offline alert delivered to ${sent} device${sent === 1 ? '' : 's'}.`);
    if (failed) logger.warn(`[WATCHDOG] Agent offline alert failed for ${failed} device${failed === 1 ? '' : 's'}.`);
    if (fired.get(deviceKey) === receipt) {
      if (sent > 0) {
        receipt.status = 'sent';
        receipt.expiresAtMs = Number(now()) + firedReceiptTtlMs;
        try {
          if (onFired({ deviceKey, sessionId, sent, failed }) === true) fired.delete(deviceKey);
        } catch (_) {
          logger.warn('[WATCHDOG] Could not report successful delivery to the reconnected agent.');
        }
      } else {
        fired.delete(deviceKey);
      }
    }
    return true;
  }

  function clearActiveTimer(deviceKey) {
    const current = active.get(deviceKey);
    if (!current?.offlineTimer) return;
    clearTimer(current.offlineTimer);
    current.offlineTimer = null;
    current.offlineGeneration = 0;
  }

  function deleteDeviceBatches(deviceKey) {
    for (const [key, batch] of batches.entries()) {
      if (batch.deviceKey === deviceKey) batches.delete(key);
    }
  }

  function cleanup() {
    const currentTime = Number(now());
    for (const [key, batch] of batches.entries()) {
      if (currentTime - batch.createdAtMs > maxTicketLifetimeMs) batches.delete(key);
    }
    for (const [key, receipt] of fired.entries()) {
      if (receipt.expiresAtMs <= currentTime) fired.delete(key);
    }
  }

  function getState(deviceKey) {
    const current = active.get(deviceKey);
    return current ? {
      armed: true,
      sessionId: current.sessionId,
      ticketCount: current.tickets.length,
      offlinePending: Boolean(current.offlineTimer),
    } : { armed: false };
  }

  function dispose() {
    for (const key of active.keys()) clearActiveTimer(key);
    active.clear();
    batches.clear();
    fired.clear();
  }

  return {
    agentOffline,
    agentOnline,
    commit,
    disarm,
    dispose,
    getState,
    stage,
  };
}

async function sendSealedPushTicket(ticket, options = {}) {
  // The relay forwards the exact request prepared by the local proxy. Redirects
  // are forbidden so an allowlisted endpoint cannot redirect into another host.
  if (!isAllowedPushEndpoint(ticket.endpoint, options.allowedPushOrigins)) {
    throw new Error('watchdog push endpoint is not allowlisted');
  }
  if (!safeAuthorization(ticket.authorization)) throw new Error('invalid watchdog authorization');
  if (ticket.contentEncoding !== 'aes128gcm') throw new Error('unsupported watchdog content encoding');

  const body = Buffer.from(ticket.body, 'base64url');
  if (!body.length || body.length > MAX_TICKET_BODY_BYTES) throw new Error('invalid watchdog payload size');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  const response = await fetchImpl(ticket.endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: ticket.authorization,
      'Content-Encoding': ticket.contentEncoding,
      'Content-Type': 'application/octet-stream',
      TTL: '300',
      Urgency: 'high',
    },
    body,
    signal: options.abortSignal || AbortSignal.timeout(10_000),
  });
  return {
    sent: response.status >= 200 && response.status < 300,
    expired: response.status === 404 || response.status === 410,
    status: response.status,
  };
}

function isAllowedPushEndpoint(value, extraOrigins = []) {
  // Exact HTTPS origins plus known browser Push hosts prevent the sealed POST
  // primitive from becoming a generic server-side request facility.
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    const hostname = url.hostname.toLowerCase();
    if (!hostname || net.isIP(hostname)) return false;
    const allowedHost = hostname === 'fcm.googleapis.com'
      || hostname === 'updates.push.services.mozilla.com'
      || hostname === 'push.apple.com'
      || hostname.endsWith('.push.apple.com')
      || hostname === 'notify.windows.com'
      || hostname.endsWith('.notify.windows.com');
    const configured = new Set((extraOrigins || []).map(origin => String(origin).trim().toLowerCase()));
    return allowedHost || configured.has(url.origin.toLowerCase());
  } catch (_) {
    return false;
  }
}

function safeAuthorization(value) {
  return typeof value === 'string'
    && value.length >= 16
    && Buffer.byteLength(value, 'utf8') <= 4096
    && !/[\r\n]/.test(value);
}

function batchKey(deviceKey, batchId) {
  return `${deviceKey}\n${batchId}`;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

module.exports = {
  DEFAULT_OFFLINE_DELAY_MS,
  createAgentWatchdog,
  isAllowedPushEndpoint,
  sendSealedPushTicket,
};
