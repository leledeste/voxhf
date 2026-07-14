# VoxHF Remote Threat Model

Status: implemented baseline with planned hardening. This document covers the
current remote architecture and the controls still required before broader use.

## Assets

- User account.
- Paired device tokens.
- Local agent control channel.
- Radio tuning state.
- Chat sending capability.
- Web TX capability.
- Browser microphone permission.
- IVAO/FSD/TS2 live traffic passing through the local agent.
- Security logs.

## Trust Boundaries

```text
Browser
  | untrusted network
Relay
  | untrusted network
Local Agent
  | local machine boundary
Altitude / PilotCore / IVAO
```

The browser, relay, and agent must authenticate each other at their boundary. The relay must never assume a connected socket can do everything.

## Main Threats

### Unauthorized Remote Control

An attacker controls radio, chat, XPDR, or TX.

Controls:

- Strong authentication.
- Device pairing.
- Per-message authorization.
- Token revocation.
- Local kill switch.

### Cross-Site WebSocket Hijacking

A malicious website tries to open a WebSocket using the user's browser session.

Controls:

- Strict `Origin` allowlist.
- SameSite cookies if cookies are used.
- Token-based WebSocket auth.
- Message-level authorization.

### Stolen Device Token

An attacker steals the agent token.

Controls:

- Store only hashed tokens on the relay.
- Make tokens revocable.
- Show active devices.
- Rotate tokens after suspected compromise.
- Keep local token file permissions tight.

### Pairing Code Abuse

An attacker guesses or reuses a pairing code.

Controls:

- Short-lived code.
- One-time use.
- Rate-limit attempts.
- Bind pairing to authenticated user session.
- Show device details before confirmation.

### Malicious Relay Operator

A relay operator inspects or modifies traffic.

Controls:

- Open source code.
- Self-hosting support.
- Optional end-to-end encryption for remote payloads.
- No required official relay.
- Clear privacy documentation.

The public server directory does not remove this trust boundary. Server
identity, source, and privacy links are operator declarations; a heartbeat
only proves recent possession of a listing token. The central registry controls
the `official` flag, and relay heartbeats cannot change listing identity.

### Audio Abuse

Remote TX stays active after disconnect or is triggered without user intent.

Controls:

- PTT requires user gesture.
- Stop TX on disconnect.
- Maximum PTT duration.
- Agent-side TX timeout.
- Local visible remote-TX indicator.
- Local kill switch.

### Untrusted Audio Parsing

The local agent decodes and encodes voice through ffmpeg. Audio bytes originate
from live TS2 traffic or browser microphone streams, so they must be treated as
untrusted parser input even when ffmpeg is launched without a shell.

Controls:

- Invoke ffmpeg with fixed argument arrays, never shell-built command strings.
- Stream audio through stdin/stdout instead of file paths controlled by peers.
- Keep codec settings in a small validated configuration surface.
- Stop decoder/encoder processes on disconnect.
- Keep ffmpeg updated through normal system package updates.

### Remote Command Flood

A paired browser, compromised browser session, or compromised relay sends
authorized commands at an unsafe rate.

Controls:

- Relay-side rate limits for pairing, chat, tuning, XPDR, and TX.
- Agent-side rate limits before touching PilotCore/FSD.
- No raw protocol tunnel.
- Visible local state updates when remote commands change radio or XPDR state.

### State Desynchronization

The browser, relay, agent, and Altitude disagree about current radio, XPDR, TX,
or connection state after reconnects or dropped messages.

Controls:

- Treat the local agent and IVAO/FSD feedback as source of truth.
- Replay compact state snapshots after browser reconnect and device selection.
- Drop remote commands when the agent is disconnected from IVAO.
- Make remote TX fail closed on browser, relay, or agent disconnect.

### Denial of Service

Attackers overload relay, pairing, login, or WebSocket resources.

Controls:

- Rate limits.
- Message size limits.
- Connection limits.
- Idle timeouts.
- Backpressure handling.
- Separate security logs for abuse.

### Sensitive Logging

Logs accidentally include chat, raw packets, audio, or secrets.

Controls:

- Structured logging allowlist.
- Redaction.
- No payload logging by default.
- Short retention.
- Review logging in code review.

## Explicitly Disallowed Remote Capabilities

- Raw FSD command tunnel.
- Raw TS2 packet tunnel from browser.
- Raw PilotCore command tunnel.
- Unauthenticated WebSocket control.
- Publicly exposed local agent ports.

## Open Questions

- Whether to implement end-to-end payload encryption before or after the first relay prototype.
- Which authentication hardening should become mandatory if an official relay
  is ever offered.
- Whether a future official public relay should exist beyond invite-only beta.
