'use strict';

// Uses a deterministic clock to verify start, replacement, cancellation, and
// one-time expiry without waiting for the real three-minute interval.
const assert = require('assert');
const { DEFAULT_DURATION_MS, createUnicomTimer } = require('../proxy/unicom-timer');

(async () => {
  let clock = Date.parse('2026-08-01T12:00:00.000Z');
  let scheduled = null;
  const cleared = [];
  const states = [];
  const expirations = [];
  let timerSequence = 0;

  const timer = createUnicomTimer({
    now: () => clock,
    setTimer(callback, delay) {
      scheduled = { id: ++timerSequence, callback, delay };
      return scheduled.id;
    },
    clearTimer(id) {
      cleared.push(id);
      if (scheduled?.id === id) scheduled = null;
    },
    onState: state => states.push(state),
    onExpired: event => expirations.push(event),
    logger: { warn() {} },
  });

  assert.equal(timer.durationMs, DEFAULT_DURATION_MS);
  assert.deepEqual(timer.getState(), { active: false });

  const started = timer.start();
  assert.deepEqual(started, {
    active: true,
    startedAt: '2026-08-01T12:00:00.000Z',
    expiresAt: '2026-08-01T12:03:00.000Z',
  });
  assert.equal(scheduled.delay, DEFAULT_DURATION_MS);
  assert.deepEqual(states, [started]);

  clock += 30_000;
  const restarted = timer.start();
  assert.equal(cleared.length, 1);
  assert.equal(restarted.expiresAt, '2026-08-01T12:03:30.000Z');
  assert.equal(states.length, 2);

  const cancelled = timer.cancel();
  assert.deepEqual(cancelled, { active: false });
  assert.equal(cleared.length, 2);
  assert.deepEqual(states[2], { active: false });
  assert.equal(expirations.length, 0);

  clock += 30_000;
  timer.start();
  const expiry = scheduled;
  clock += DEFAULT_DURATION_MS;
  assert.equal(await expiry.callback(), true);
  assert.deepEqual(timer.getState(), { active: false });
  assert.deepEqual(states.at(-1), { active: false });
  assert.deepEqual(expirations, [{ expiredAt: '2026-08-01T12:04:00.000Z' }]);

  console.log('[OK] UNICOM three-minute timer behavior');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
