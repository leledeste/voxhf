# VoxHF Remote Protocol

This package defines the versioned, allowlisted messages shared by browsers,
the relay, and the local agent.

Every JSON message contains:

```json
{
  "v": 1,
  "id": "message-1",
  "type": "radio.set",
  "payload": {
    "com": 1,
    "freq": "128.350"
  }
}
```

- `v` is the protocol version.
- `id` traces the same message across hops.
- `type` is an allowlisted action or state update.
- `payload` is validated per message type.

The validator rejects unknown types, extra fields, invalid source/type
combinations, oversized JSON, out-of-range values, and raw FSD/TS2/PilotCore
commands.

Browsers can send only typed controls such as radio, chat, weather, XPDR, and
TX state. Agents publish typed status, stations, chat, weather, and audio.
The relay routes valid messages only within the authenticated user and selected
agent scope.

```js
const {
  MESSAGE_SOURCES,
  MESSAGE_TYPES,
  createRemoteMessage,
  validateRemoteMessage,
} = require('./packages/protocol');

const message = createRemoteMessage(MESSAGE_TYPES.RADIO_SET, {
  com: 1,
  freq: '128.350',
});

const result = validateRemoteMessage(message, {
  source: MESSAGE_SOURCES.BROWSER,
});

if (!result.ok) throw new Error(result.error);
```