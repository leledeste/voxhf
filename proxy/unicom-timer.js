'use strict';

const DEFAULT_DURATION_MS = 3 * 60 * 1000;

function createUnicomTimer(options = {}) {
  // The timer belongs to the local agent so browser suspension and device
  // changes cannot stop the countdown. State remains session-only.
  const durationMs = normalizeDuration(options.durationMs);
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const onState = options.onState || (() => {});
  const onExpired = options.onExpired || (() => {});
  const logger = options.logger || console;

  let timerId = null;
  let generation = 0;
  let state = inactiveState();

  function start() {
    generation += 1;
    if (timerId) clearTimer(timerId);
    const startedAtMs = Number(now());
    state = {
      active: true,
      startedAt: new Date(startedAtMs).toISOString(),
      expiresAt: new Date(startedAtMs + durationMs).toISOString(),
    };
    const currentGeneration = generation;
    timerId = setTimer(() => expire(currentGeneration), durationMs);
    onState(getState());
    return getState();
  }

  function cancel() {
    const changed = state.active || Boolean(timerId);
    generation += 1;
    if (timerId) clearTimer(timerId);
    timerId = null;
    state = inactiveState();
    if (changed) onState(getState());
    return getState();
  }

  async function expire(expectedGeneration) {
    if (expectedGeneration !== generation || !state.active) return false;
    const expiredAt = state.expiresAt;
    timerId = null;
    state = inactiveState();
    onState(getState());
    try {
      await onExpired({ expiredAt });
    } catch (err) {
      logger.warn(`[UNICOM TIMER] Expiry handler failed: ${err.message}`);
    }
    return true;
  }

  function getState() {
    return { ...state };
  }

  return {
    durationMs,
    start,
    cancel,
    getState,
  };
}

function inactiveState() {
  return { active: false };
}

function normalizeDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 1000 ? Math.round(duration) : DEFAULT_DURATION_MS;
}

module.exports = {
  DEFAULT_DURATION_MS,
  createUnicomTimer,
};
