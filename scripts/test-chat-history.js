'use strict';

const assert = require('assert');
const { createAppState } = require('../proxy/app-state');

const published = [];
const state = createAppState({
  timestamp: () => '2026-07-28T12:00:00.000Z',
  publish: message => published.push(message),
});

state.broadcast({
  kind: 'message',
  type: 'private',
  sender: 'LIMC_TWR',
  recipient: 'WZZ2807',
  text: 'First message',
  direction: 'incoming',
  timestamp: '2026-07-28T12:00:00.000Z',
});
state.broadcast({
  kind: 'message',
  type: 'frequency',
  sender: 'LIMC_TWR',
  recipient: '@26805',
  text: 'WZZ2807, contact tower',
  direction: 'incoming',
  timestamp: '2026-07-28T12:00:01.000Z',
});

const history = state.getMessageLog(50);
assert.equal(history.length, 2);
assert.match(history[0].messageId, /^local-/);
assert.match(history[1].messageId, /^local-/);
assert.notEqual(history[0].messageId, history[1].messageId);
assert.equal(published[0].messageId, history[0].messageId);
assert.deepEqual(state.getInitState().log, history);

history[0].text = 'mutated copy';
assert.equal(state.getMessageLog(50)[0].text, 'First message');

console.log('Chat history checks passed.');
