# Changelog

All notable VoxHF changes are recorded here.

## Unreleased

## 0.1.2-beta.2 - 2026-09-02

### Changed

- Reorganized the documentation into a concise project overview, a complete
  pilot user guide, a focused Local installation guide, and a step-by-step VPS
  server/operator guide; removed repeated and historical descriptions and
  corrected the dependency policy for the project's AGPL-3.0-only license.

### Fixed

- Filtered incoming frequency chat so UNICOM remains visible while other
  traffic appears only when its frequency matches the current COM1 or COM2.
- Interpreted unavailable METAR and TAF visibility (`////`) and cloud
  (`//////`) groups explicitly, kept `RMK` content together in a dedicated
  Remarks field, and decoded runway-ceilometer `NCD` remarks without losing
  unknown supplementary text.

## 0.1.2-beta.1 - 2026-08-03

### Added

- Added per-device Web Push alerts when a previously confirmed IVAO connection
  remains disconnected for ten seconds, with local retries for temporary
  Internet outages while the proxy keeps running. The alert is suppressed only
  when fresh telemetry shows the aircraft stationary at no more than five
  knots; missing or stale telemetry fails safe by notifying.
- Added an optional per-device IVAO online confirmation alert. Incoming SERVER
  welcome messages remain in chat but do not generate Push notifications during
  the first two seconds of a confirmed IVAO connection.
- Added a proxy-owned three-minute UNICOM reminder. Its countdown stays in sync
  across connected devices, survives browser refreshes and mobile suspension,
  and sends a Push alert to subscribed devices when it expires.
- Added an optional per-device PC/proxy offline alert for remote mode. During a
  confirmed IVAO session, the relay can use a short-lived Push request that the
  local proxy already encrypted and signed if that proxy remains unreachable
  after the disconnect grace period. The ticket is memory-only, one-use, and
  removed on reconnect, normal IVAO disconnect, expiry, opt-out, or relay
  restart; the relay never receives the local VAPID private key.

### Changed

- Replaced the browser-native PC/proxy offline opt-in confirmation with an
  accessible VoxHF dialog that summarizes how the temporary relay ticket works.
- Simplified hosted workspace account access by directing sign-in and
  registration to the dedicated account page instead of duplicating those
  controls inside the operational app.
- Reduced the shipped frontend surface by removing unused styles and historical
  screenshot assets that were no longer part of the product.
- Simplified relay maintenance by separating account, administration,
  credential, and session responsibilities from live WebSocket routing without
  changing their external behavior.
- Simplified workspace maintenance by separating account and browser-session
  behavior from live flight, WebSocket, radio, chat, notification, and audio
  state without changing the visible account flow.

### Fixed

- Let route METAR and TAF content extend the normal page height on phones,
  avoiding an inaccessible nested weather scroller in iOS Safari.
- Added an iOS/iPadOS-only RX activation prompt that makes WebKit's required
  first gesture explicit, disappears when audio is running, and returns if
  automatic recovery after browser standby cannot resume RX.
- Stabilized Web TX readiness when Altitude exposes multiple TS2 UDP flows by
  ignoring unrelated packets and replacing a validated transmit-session seed
  atomically, without changing the established voice-channel routing.

## 0.1.1-beta.1 - 2026-07-29

### Added

- Restored the current proxy session's recent chat history after local or
  remote browser refresh and reconnect, independently of notification support.
- Added per-device Web Push notifications, sent by the local proxy for incoming
  private messages and public messages beginning with the active callsign.
- Added installable webapp metadata, a notification service worker, and
  Settings controls to enable or disable each device without a synthetic test
  message button.

### Changed

- Expanded the visual setup guide and self-hosting reference with complete
  local-agent, DNS, firewall, account, validation, and recovery steps.
- Updated the roadmap, README, and technical paper to match the working public
  beta, verified mobile interface, weather interpretation, automatic TX-session
  derivation, second-PC installation, and live VPS operations.
- Replaced pre-release public-site labels with the current public-beta status.
- Preserved private local notification credentials and subscriptions when a
  Local Slim update is staged.
- Simplified the top flight-plan indicator to show only the departure and
  destination airports.
- Reworked short tablet landscape layout so radios and chat remain aligned
  while route weather moves to a full-width row below them.
- Added versioned workspace asset URLs so browsers fetch updated Settings and
  notification code immediately after a server update.
- Simplified the internal project structure and maintenance guidance by
  replacing the historical `CLAUDE.md` handoff with a concise repository-wide
  `AGENTS.md`.
- Reduced unused browser code by removing duplicate mobile visibility rules
  and the screenshot-only runtime path.

### Fixed

- Prevented the Settings dialog from becoming unresponsive after opening it on
  iPad and stopped touch scrolling from moving the workspace behind the dialog.
- Restored access to route METAR and TAF content in tablet landscape layouts.
- Kept the radio and chat surfaces at a stable matching height while scrolling
  short iPad landscape pages.
- Removed the transient scrollbar flash when switching between All, Frequency,
  Private, and System chat filters on desktop.
- Closing a private-chat tab now hides only that tab and no longer removes its
  messages from All, Private, or the restored session history.
- Made the one-time mobile audio unlock listener remove itself after audio
  starts, avoiding interference with subsequent iOS Settings taps.
- Vertically aligned setup-route descriptions with their section headings.
- Documented the guided and manual `config.json` setup for connecting Local
  Slim to an existing server.
- Made release publication replace existing tag artifacts safely when a beta
  tag must be republished.
- Preserved executable Unix permissions for the VPS operator script in release
  ZIPs generated on Windows.

### Removed

- Removed the unused public server directory across the website, relay API,
  heartbeat publisher, SQLite schema, CLI, configuration, tests, packaging,
  and documentation.
- Made the retired server-directory pages and API routes return `404` and
  invalidated the previous workspace asset URLs.

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
