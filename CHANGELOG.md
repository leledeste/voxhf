# Changelog

All notable VoxHF changes are recorded here.

## Unreleased

### Changed

- Expanded the visual setup guide and self-hosting reference with complete
  local-agent, DNS, firewall, account, validation, and recovery steps.
- Updated the roadmap, README, and technical paper to match the working public
  beta, verified mobile interface, weather interpretation, automatic TX-session
  derivation, second-PC installation, and live VPS operations.
- Replaced pre-release public-site labels with the current public-beta status.

### Fixed

- Vertically aligned setup-route descriptions with their section headings.
- Documented the guided and manual `config.json` setup for connecting Local
  Slim to an existing server.
- Made release publication replace existing tag artifacts safely when a beta
  tag must be republished.

## 0.1.0-beta.1 - 2026-07-14

### Added

- Comprehensive maintainer handoff covering the complete architecture,
  verified behavior, product decisions, deployment, testing, and pending work.
- Rebuilt public landing page with a bright editorial layout, dark content
  bands, and a touch-friendly horizontal gallery of full product screenshots.
- Public visual setup guide for local, existing-server, and self-hosted use.
- Opt-in public server directory with search/filtering, independent-server
  warnings, authenticated heartbeats, and centrally controlled official labels.
- Directory registry CLI for listing creation, token rotation, maintenance,
  disable, and deletion operations.
- Compact text wordmarks and status rails that avoid decorative logo marks and
  keep operational state readable without generic badge styling.
- Secret-safe, versioned release ZIPs with package-specific lockfiles,
  SHA-256 checksums, and isolated clean-install verification.
- Lightweight Local Slim installation and second-PC acceptance checklist.
- Verified staged Local updates that retain the previous folder for rollback.
- Minimum/recommended agent version handling between relay, proxy, and webapp.
- SQLite backup metadata, integrity verification, restore, and automatic
  preservation of the pre-restore database.
- Unified VPS operator commands for diagnostics, start, logs, backup, restore,
  update, and rollback.
- Tag-driven GitHub release publication after package and update tests.

### Fixed

- Preserved the landing hero screenshot aspect ratio instead of stretching it
  to the full height of the hero column.
- Simplified and aligned the public server directory layout across desktop and
  narrow screens.
- Added smooth, reduced-motion-aware FAQ expansion on the public landing page.
- Kept VoxHF-operated listings first without allowing a server heartbeat to
  claim or alter official status.
- Prevented ignored `.env`, `config.json`, database, log, dump, and diagnostic
  files from entering generated release packages through recursive copies.
- Generated coherent Local and Server lockfiles instead of combining reduced
  package metadata with the full-source lockfile.

## 0.1.0 - Initial Beta

### Added

- Local PilotUI/PilotCore, FSD, and TS2 voice bridge.
- Browser COM1/COM2 tuning with online stations, UNICOM, distance sorting, and
  observer filtering.
- Browser RX audio and COM1/COM2 microphone TX.
- Automatic TS2 TX-session derivation and refresh across channel/server changes.
- Squawk, STBY/ALT, IDENT, flight-plan state, and route weather.
- Frequency, broadcast, private messaging, private tabs, and command completion.
- METAR, TAF, and ATIS requests with basic visual weather interpretation.
- Responsive Light/Dark desktop and mobile interface.
- WebSocket heartbeat and standby recovery.
- Versioned remote protocol with allowlisted commands.
- Self-hosted HTTPS/WSS relay, browser pairing, and multi-user isolation.
- SQLite users, agent tokens, browser sessions, pairings, devices, and audit
  events.
- Self-hosted account registration/login and one-time agent tokens.
- Separate public landing, account, and operational workspace pages.
- Invite-only account registration with one-time in-memory admin codes.
- Privacy-first relay defaults for audit and session metadata retention.
- Relay admin panel.
- Owner-based relay administration with password login, server-side admin
  sessions, password changes, session revocation, and break-glass recovery.
- Opt-in WebAuthn/passkey MFA for relay owners, with one-use recovery codes,
  passkey management, and break-glass MFA reset.
- Agent WebSocket authentication through the HTTP Authorization header, with a
  temporary compatibility switch for older agents.
- Pilot browser-session management, password changes, and owner-issued one-use
  password recovery codes.
- Remote controls plus live RX/TX audio, including phone-as-microphone use.
- Docker Compose, Caddy, release packaging, CI checks, and security/privacy
  documentation.
- Guided first-run setup for local-only use, existing relay connections, and
  private-token or account-based self-hosted servers.
- Git-tracked Docker defaults separated from the private deployment `.env`, so
  updates add safe configuration values without overwriting domains or secrets.
- Public VoxHF landing page with explicit pre-release status, product preview,
  architecture, self-hosting options, requirements, FAQ, and a minimal website
  privacy notice.
- Invite-protected official app access for private hosted testing.

### Security

- Strict browser origin validation.
- Account/admin HTTP origin and JSON-content enforcement.
- IP-level authentication rate limits with `Retry-After` responses.
- HSTS, CSP, Permissions Policy, and frame-denial headers for hosted pages.
- Scoped user/device routing.
- Hashed tokens and pairings.
- HttpOnly hosted-account sessions.
- Separate HttpOnly admin sessions with strict cookie scope and idle expiry.
- Short-lived, purpose-bound, single-use WebAuthn challenges and hashed admin
  recovery codes.
- No raw IVAO credentials, chat history, or voice recordings in relay storage.
- Local proxy ports remain private and must not be internet-exposed.

### Known Limitations

- Private IVAO/Altitude protocols may change.
- TX can sound slightly rougher than native Altitude.
- Overlapping RX transmissions can clip.
- iOS changes audio routing while microphone capture is active.
- Full automated Altitude/IVAO integration tests are not yet available.
