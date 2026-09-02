# VoxHF Threat Model

This model describes the implemented local and remote architecture. The local
agent is trusted with simulator/IVAO access; browsers and relay connections are
authenticated but still treated as potentially compromised inputs.

## Assets

- Pilot and owner accounts, passwords, sessions, and recovery material.
- Agent tokens, browser pairings, notification credentials, and watchdog
  tickets.
- Radio, XPDR, chat, weather, and Web TX capabilities.
- Microphone permission and live RX/TX audio.
- Parsed IVAO/FSD/TS2 state and local configuration.
- SQLite data, logs, backups, and deployment secrets.

## Trust Boundaries

```text
Browser
  | HTTPS/WSS over an untrusted network
Relay and account/admin service
  | WSS over an untrusted network
Local VoxHF agent
  | local machine boundary
Altitude / PilotCore / IVAO
```

The relay authenticates users/devices and routes only approved protocol types.
The local agent validates again before changing simulator or network state. A
successful connection never implies permission to send every message type.

## Threats And Controls

| Threat | Main controls |
| --- | --- |
| Public access to privileged local ports | Local binding, outbound-only remote agent, deployment documentation, no relay tunnel for those ports |
| Unauthorized radio/chat/XPDR/TX control | Account/token authentication, browser pairing, user/device scoping, protocol source allowlists, agent-side validation and rate limits |
| Cross-site WebSocket or cookie abuse | Exact Origin checks, HttpOnly Secure SameSite cookies, scoped admin path/session, JSON/content checks |
| Stolen agent token or browser session | Hashed stored secrets, revocation/rotation, session listing, logout-other-devices, short-lived recovery codes |
| Pairing/invite guessing or reuse | Memory-only one-use codes, expiry, authenticated ownership, rate limits |
| TX continuing after user intent ends | Explicit PTT action, visible state, duration limit, release tail, stop on browser/relay/agent/pairing/device disconnect |
| Malformed or hostile audio | Fixed ffmpeg argument arrays without a shell, streamed stdin/stdout, bounded frame sizes/settings, process cleanup |
| Command or connection flood | Per-connection/IP limits, message/command size and rate limits, maximum clients, close/reject behavior |
| State desynchronization after reconnect | Local agent as source of truth, compact state/history snapshots, selected-agent checks, fail-closed TX |
| Secret/message/audio leakage through logs | Allowlisted metadata only, bounded Docker logs, privacy defaults, tests rejecting forbidden persistence/logging paths |
| Supply-chain or release tampering | Locked dependencies, license/audit checks, package-content verification, SHA-256 release manifests; no signed Windows binary yet |
| Backup or database exposure | Private Docker volume/host directory, no secrets/audio/chat in SQLite, checksum/integrity verification, operator access controls |

## Relay Operator Trust

HTTPS/WSS protects traffic from the network, not from the relay process or its
operator. A relay necessarily sees the parsed state, commands, message content,
and live audio it routes. End-to-end encryption between browser and local agent
is not implemented.

Mitigations are open source, self-hosting, deployment-specific privacy notices,
minimal persistence, and the ability to use local-only mode. Users must not
treat an unknown relay operator as a zero-trust intermediary.

## Offline Watchdog Threats

The optional PC/proxy offline alert temporarily gives the relay a Push endpoint
and request already encrypted and signed by the local proxy.

Controls:

- only the authenticated agent can stage, commit, or disarm a ticket batch;
- browsers cannot send watchdog protocol types;
- the VAPID private key and subscription encryption keys remain local;
- signatures expire within 15 minutes and tickets are one-use/memory-only;
- HTTPS port 443, no credentials/IP literals, and known or explicitly trusted
  Push origins are enforced;
- reconnect cancels the offline grace period;
- logs contain counts, never endpoint, authorization header, or encrypted body.

Residual risk: a malicious relay can replay the exact sealed alert before its
signature expires. It cannot decrypt/alter it, create another signed alert, or
use it after expiry.

## Explicitly Forbidden Capabilities

- raw FSD, TS2, or PilotCore tunnels through the relay;
- unauthenticated remote control;
- public exposure of local agent ports;
- voice recording or normal-operation packet/audio dumps;
- persistent full chat history;
- relay storage of IVAO credentials or local VAPID private keys.

## Residual Risks

- Observed Altitude/IVAO/TS2 behavior may change outside VoxHF's control.
- The local agent and its host are privileged; compromise of the simulator PC
  can bypass browser/relay protections.
- A compromised paired browser can act within that user's allowed controls
  until its session/pairing is revoked.
- The single-process in-memory rate limits are appropriate for the documented
  small VPS model, not horizontal scaling without a shared atomic limiter.
- Web TX and browser media policies depend on browser/OS behavior and still
  require live regression testing.
- Release ZIP integrity is checksum-verifiable but not backed by a signed
  Windows executable/installer.
- Internal review does not replace independent penetration testing or legal
  review for a public hosted service.

Secure deployment instructions are in [SECURITY.md](../SECURITY.md) and
[Self-Hosting](SELF_HOSTING.md). Stored-data details are in
[Privacy Architecture](PRIVACY.md).
