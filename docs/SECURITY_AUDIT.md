# Security Audit Baseline

Last verified: 2026-08-05

This is an internal engineering review of the public-beta VoxHF codebase. It
documents verified controls and remaining risks; it is not a third-party
penetration test or a guarantee that the software is vulnerability-free.

## Scope

- Hosted account registration, login, logout, and browser sessions.
- Registration invites and the relay admin API.
- Agent tokens, browser pairing, WebSocket authentication, and user isolation.
- Remote command and live RX/TX routing.
- Multi-device session chat recovery, local-agent Web Push delivery, and the
  optional relay watchdog for complete proxy/PC loss.
- SQLite storage, logging, Docker/Caddy, browser headers, and dependencies.
- Local-agent command allowlists and privacy guards already covered by CI.

## Verified Controls

- Account passwords use salted Node.js `scrypt` hashes.
- Random agent, session, and admin tokens are compared in constant time where
  applicable; stored agent and session values are hashed.
- Browser sessions use `HttpOnly`, `SameSite=Lax`, expiring cookies and `Secure`
  behind HTTPS. Disabled users cannot reuse existing sessions.
- Registration invites use 18 cryptographically random bytes, are stored only
  as in-memory hashes, expire, and are consumed once.
- Browser WebSockets require an allowlisted `Origin`; every WebSocket is
  authenticated and scoped to one user.
- Browser commands and agent updates use explicit message allowlists. Raw FSD,
  PilotCore, and TS2 tunneling is not exposed to remote browsers.
- Pairing, device selection, token rotation, user disable/delete, and pairing
  revocation are scoped and covered by integration tests.
- Remote TX requires an active selected device and explicit TX state, validates
  binary framing, has a maximum duration, and stops on disconnect.
- Voice and chat contents are routed live and are not persisted by the relay.
- Agent-offline watchdog tickets are prepared and signed by the local proxy,
  bounded by the protocol, held only in relay memory, restricted to allowlisted
  HTTPS Push origins, consumed before delivery, and covered by focused tests.
- IVAO disconnect suppression requires two fresh position samples at no more
  than five knots; missing or stale telemetry fails safe by notifying.
- Session IP/user-agent metadata and audit persistence are disabled by default.
- Production dependencies reported zero known vulnerabilities through
  `npm audit --omit=dev` on the audit date.

## Hardening Added

- Short-window IP rate limits for account authentication and failed admin-token
  attempts, including `429` responses and `Retry-After`.
- Explicit rejection of account/admin requests with an untrusted `Origin`.
- `application/json` is required for state-changing account/admin requests,
  preventing simple cross-site form submissions.
- Hosted Caddy responses add HSTS, frame denial, Permissions Policy, and
  page-specific Content Security Policy headers.
- The self-hosting wizard allowlists both the app and relay origins so the
  hosted account and same-origin admin interfaces remain functional.
- Automated tests cover blocked origins, content types, rate limits, cookie
  attributes, invite reuse, account disable, and existing user isolation.

## Residual Risks

- Admin access now uses a separate owner account and hashed server-side session;
  the long-lived admin token is limited to bootstrap, compatibility, and
  break-glass recovery. Owner passkey MFA and one-use recovery codes are
  implemented as an opt-in control.
- Owner and pilot password changes, break-glass recovery, session listing, and
  session revocation are implemented. Pilot password recovery uses an
  owner-issued, short-lived, one-use code stored only as a hash.
- HTTP rate-limit state is in memory and local to one relay process. A
  multi-instance public deployment needs a shared limiter or an upstream WAF.
- Node agent tokens use the WebSocket upgrade Authorization header. A temporary
  configuration flag can still accept query tokens from older agents and
  should be disabled after migration. Manual browser-token mode still uses a
  query token because browser WebSocket APIs cannot set custom headers.
- WebSocket sessions are long-lived. Account disable/delete closes current
  sockets, but routine session-token rotation is not implemented.
- The hosted app intentionally permits connections to operator-selected HTTPS
  and WSS relay origins; a compromised trusted browser can still act as the user.
- The app CSP still permits inline styles because the current UI updates a small
  number of style properties dynamically; scripts remain restricted to self.
- IVAO/Altitude protocols are observed private interfaces and may change.
- ffmpeg processes untrusted live codec data and must be kept updated.
- Live IVAO behavior cannot be fully reproduced in automated tests.

## Before Expanding Beta Access

1. Complete the real-device passkey matrix; automated WebAuthn preflight and
   recovery-path tests are implemented.
2. Enable and verify repository secret scanning, dependency updates, static
   analysis, and private vulnerability reporting.
3. Put upstream connection and authentication limits in front of any public
   multi-instance relay.
4. Run an independent code review and targeted penetration test.
5. Repeat dependency, browser, Windows, Linux, iOS, and live IVAO tests for the
   release candidate.
