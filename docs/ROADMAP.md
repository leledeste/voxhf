# VoxHF Roadmap

VoxHF is an experimental IVAO Altitude companion. This file tracks product
status, not implementation history. Released changes belong in
[CHANGELOG.md](../CHANGELOG.md).

## Working

### Local Agent

- PilotUI/PilotCore bridge and automatic Ethernet/Wi-Fi IPv4 selection.
- Parsed FSD chat, ATC, weather, flight-plan, and position state.
- TS2 forwarding with automatic voice-server and TX-session refresh.
- Modular local runtime and loopback webapp.

### Webapp

- Responsive desktop/mobile Light/Dark interface.
- COM1/COM2, UNICOM, `_OBS` filtering, and distance sorting.
- Squawk, STBY/ALT, and IDENT.
- Frequency, broadcast, private messaging, and command completion.
- METAR/TAF/ATIS, route weather, and plain-language weather interpretation.
- Heartbeat and standby recovery.

### Voice

- Live RX in local and selected remote browsers.
- Local and remote microphone TX on COM1/COM2.
- Phone-as-microphone workflow.
- Automatic TX session derivation across channel/server changes.
- RX test and TX monitor.

### Remote And Self-Hosting

- HTTPS/WSS relay with strict origin checks.
- Account registration/login and HttpOnly sessions.
- Hashed per-user agent tokens.
- Multiple browser devices for one user/agent.
- Manual-token browser pairing.
- SQLite users, agents, pairings, sessions, and audit events.
- Admin panel, Docker Compose, and Caddy.
- Remote controls, RX audio, TX audio, and update notices.
- Opt-in public server directory with authenticated heartbeats, operator and
  privacy links, access policy, and recent availability status.

### Installation And Operations

- Secret-safe Local Slim, Hosted Webapp, Server, and Full Source ZIPs.
- Package-specific lockfiles, SHA-256 sums, and isolated install tests.
- Verified staged Local updates that preserve the previous installation.
- Relay minimum-agent enforcement and recommended-version notices.
- Consistent SQLite backup, integrity verification, restore, and pre-restore
  preservation.
- VPS setup, diagnostics, start, backup, restore, update, and rollback commands.
- Tag-driven GitHub release workflow.
- Clean Local Slim installation verified on a second Windows PC.
- Backup, update, restore, and rollback verified on a live VPS deployment.

## Implemented, Validation Pending

- The 300 ms TX release tail is implemented, but onset/release clipping still
  needs broader live-listener validation.
- Remote RX/TX works on desktop and mobile browsers; additional networks,
  devices, and simultaneous-listener combinations should remain part of beta
  regression testing.
- Automatic TX-session refresh works across channel and TS2 server changes,
  but should remain covered by live regression tests because the observed
  protocol can change.

## Known Limitations

- Observed IVAO/Altitude protocols can change without notice.
- TX can sound slightly rougher than native Altitude.
- Another listener is required for final TX confirmation.
- Overlapping RX transmissions may clip or cut.
- iOS changes audio route/volume while its microphone is active.
- Local Slim currently requires Node.js and ffmpeg to be installed separately.
- Full automated Altitude/IVAO integration tests do not exist yet.
- Self-hosted account and admin surfaces need broader production review.
- The Local updater stages a new folder; it does not silently replace a running
  installation or provide signed Windows binaries yet.

## Next Priorities

1. Scan every public branch, tag, and release artifact for secrets and rotate
   development tokens.
2. Enable CodeQL, Dependabot, secret scanning, and private vulnerability
   reporting on GitHub.
3. Complete an independent security review before opening registration or
   expanding access to a VoxHF-operated relay.
4. Decide whether a signed Windows installer/portable runtime is justified
   after measuring Local Slim setup friction.
5. Collect public-beta feedback, define explicit beta exit criteria, and
   stabilize the release candidate.

The current account, session, recovery, optional MFA, relay, and core flight
workflow test matrix has passed. These priorities cover the remaining release
and operational work rather than repeating that completed functional test.

## Planned Features

- Broader weather abbreviation coverage, interpretation edge cases, and
  explanatory tooltips.
- Controlled automatic ATIS and route-weather refresh.
- Opt-in notifications for important private messages.
- Experimental opt-in RX transcription with callsign context, without voice
  recording or persistent audio storage.
- Structured clearance scratchpad.
- Airport map with taxi route highlighting.
- Aircraft model detection and optional checklist.
- Further mobile ergonomics and iOS audio-route refinements.
- Richer audit filters.
- Optional compressed remote audio if bandwidth requires it.

## Long-Term Concepts

- Shared cockpit access with explicit per-user permissions for radio tuning,
  transponder controls, RX, and TX. This is deliberately deferred and is not a
  current implementation priority.

## Not Planned

- Public exposure of local PilotUI/PilotCore, FSD, or TS2 proxy ports.
- Browser or relay storage of IVAO credentials.
- Voice recording.
- Persistent full chat history.
- Open public registration on a VoxHF-operated relay before an independent
  security review and an explicit hosting decision.
- Replacing Altitude or bypassing IVAO rules.
