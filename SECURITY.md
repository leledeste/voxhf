# Security Policy

## Scope

This document covers the VoxHF local agent, webapp, relay, and self-hosting configuration.

VoxHF is experimental software. It interacts with IVAO Altitude traffic and browser microphone access, so remote access must be designed defensively.

## Supported Versions

The project is pre-1.0. Security fixes target the latest public version unless a stable branch exists.

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| Older versions | No |

## Reporting Vulnerabilities

Please do not publicly disclose a suspected vulnerability before maintainers have had a reasonable chance to investigate.

Recommended report contents:

- Affected component: agent, webapp, relay, docs, packaging, or infrastructure.
- Version or commit.
- Steps to reproduce.
- Expected impact.
- Whether credentials, tokens, audio, or personal data may be exposed.

Use a private GitHub security advisory if available for the repository. If that
is not available, contact the maintainer privately before opening a public
issue.

## Core Security Principles

- The local agent must never be exposed directly to the public internet.
- Remote access must go through authenticated HTTPS/WSS relay connections.
- Remote mode must accept only typed, allowlisted commands.
- Raw FSD, TS2, or PilotCore command tunneling must not be exposed remotely.
- Every WebSocket connection must be authenticated.
- Every remote action must be authorized for the selected user and device.
- The local agent must still rate-limit remote commands after relay authorization.
- Pairing codes must be short-lived and single-use.
- Device tokens must be revocable.
- Preview pairing persistence must avoid storing raw browser ids where practical.
- Logs must not contain secrets, voice audio, raw traffic, chat contents, or complete tokens.

## Remote Security Controls

### Transport

- HTTPS/WSS only in production.
- Secure reverse proxy defaults.
- No mixed-content remote mode.

### WebSocket Handshake

- Validate `Origin` against an explicit allowlist.
- Reject browser WebSocket handshakes that omit `Origin`; non-browser agent
  clients may omit it, but browser clients should not.
- Authenticate browser and agent connections.
- Reject unknown protocol versions.
- Disable compression unless it is explicitly needed and reviewed.

### Message Validation

- Validate message shape, size, and type.
- Reject unknown message types.
- Enforce per-message authorization.
- Rate-limit high-risk actions such as chat send, tuning, pairing, and TX.
- Enforce a second small agent-side rate limit before touching PilotCore or FSD.
- Close connections that repeatedly send malformed messages.

### Authentication

Preferred options:

- Passkeys/WebAuthn for the web account.
- OAuth with MFA as a fallback.
- Short-lived access tokens.
- Refresh-token rotation.
- Hashed device tokens.

Relay owner accounts can opt into WebAuthn/passkey MFA from the admin Security
page. Enrollment is never forced. The relay stores public credential material,
counters, and hashed one-use recovery codes; biometric verification remains on
the user's device. Keep the separate admin token available as a break-glass
credential because recovery intentionally revokes sessions and clears MFA.

### Pairing

- Pairing code or QR generated locally by the agent.
- Short expiry, ideally 60-120 seconds.
- One-time use.
- Device name shown before confirmation.
- Existing devices visible and revocable from the account.
- Preview relay persistence stores hashed browser ids and agent ids only.

### TX Safety

- Require explicit user gesture to start PTT.
- Maximum PTT duration.
- Stop TX on browser disconnect.
- Stop TX on agent disconnect.
- Local agent kill switch.
- Visible local indication when remote TX is active.

### Audio Parsing

- Treat TS2 voice and browser microphone streams as untrusted parser input.
- Invoke ffmpeg with fixed argument arrays, not shell-built commands.
- Stream audio through stdin/stdout and avoid peer-controlled file paths.
- Keep codec options validated and limited.
- Keep remote audio relay forwarding live-only: no caching, replay, or logging.
- Accept browser-to-agent Remote TX binary audio only during an explicit `tx.start` / `tx.stop` window, with pairing authorization, selected-agent checks, `CTX1` frame prefixing, frame/byte limits, timeout, and stop-on-disconnect handling.

## Logging

Security logs should include:

- Login success/failure.
- Pairing success/failure.
- Device connected/disconnected.
- Authorization failures.
- Rate-limit events.
- Abnormal WebSocket closes.

Security logs should not include:

- Passwords.
- Access or refresh tokens.
- Pairing codes after creation.
- Chat message contents.
- Voice/audio payloads.
- Raw FSD or TS2 packets.

## Dependency Security

Recommended GitHub settings:

- Dependabot alerts and updates.
- Secret scanning.
- CodeQL or equivalent static analysis.
- Required CI checks before release.

## Threat Model

See [Threat Model](docs/THREAT_MODEL.md).

The current internal review baseline is recorded in
[Security Audit](docs/SECURITY_AUDIT.md). It does not replace independent review.


The implemented local and remote boundaries are described in the [Technical Paper](docs/TECHNICAL_PAPER.md).
