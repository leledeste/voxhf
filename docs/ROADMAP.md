# VoxHF Roadmap

VoxHF is a working public beta. This file contains limitations and planned
product work, not a duplicate feature list or release history. Current use is
documented in the [User Guide](USER_GUIDE.md); completed release changes belong
in [CHANGELOG.md](../CHANGELOG.md).

## Current Beta Focus

- Keep local and remote radio, chat, RX/TX, weather, notifications, accounts,
  and self-hosting stable during real flights.
- Continue live regression tests across Altitude/IVAO updates, TS2 regions,
  browsers, mobile standby, and simultaneous listeners.
- Complete independent security review and operational hardening before any
  larger public hosted service.
- Explore simpler Local and server installation using the staged plan below;
  preserve the existing source/ZIP workflows while evaluating packaging.
- Define explicit release-candidate and beta-exit criteria from user feedback.

## Known Limitations

- VoxHF depends on observed IVAO/Altitude/FSD/TS2 behavior that can change
  outside the project.
- Full Altitude/IVAO integration cannot be reproduced in automated tests; voice
  and controller-addressed notification behavior still needs live validation.
- Browser TX may sound rougher than native Altitude, and overlapping RX can
  clip or cut. A second listener remains the reliable TX-quality check.
- A newly loaded iOS/iPadOS workspace needs one trusted tap before audible RX.
  VoxHF exposes the requirement over the radio panel and repeats it only when
  foreground recovery fails.
- iOS may change its audio route/volume while the microphone is active.
- Official Voice UNICOM RX/TX and automatic voice reports are not supported.
  Current UNICOM support is
  manual frequency/text plus the synchronized three-minute reminder.
- Local Slim requires Node.js and ffmpeg and is checksum-verified, but it is not
  a signed Windows executable.
- The Local updater stages a new folder instead of replacing a running install.
- Account/admin surfaces and single-process rate limiting fit the documented
  small self-hosted model; a public multi-instance relay needs further design
  and review.
- iOS/iPadOS Web Push requires a supported Home Screen webapp installation.

## Near-Term Product Work

- Extend live regression coverage to RX immediately after an IVAO reconnect
  and to other Altitude/network setups. TX recovery without restarting the
  proxy and cross-server RX/TX have been confirmed; see the
  [routing validation guide](VOICE_ROUTING_DIAGNOSTICS.md).
- Improve mobile audio-route recovery and make failure states easier to
  diagnose without exposing packet-level controls.
- Broaden METAR/TAF interpretation, edge cases, and explanatory tooltips.
- Add a flight-progress view using the flight-plan route and current aircraft
  coordinates. Candidate forms are a compact route strip or a map with the
  aircraft, next waypoint, remaining distance, altitude, IAS, and Mach when the
  local protocols provide reliable values.
- Add a structured IFR/VFR cosciale with FPL-prefilled fields and free notes.
- Add VID-based friends and private-chat names, Add friend from a conversation,
  online presence, and `.chat` by saved name; see the
  [friends plan](FEATURE_PLANS.md#friends-identity-and-presence).
  Extending page-only drafts with refresh survival and synchronization remains a
  [future design decision](FEATURE_PLANS.md#per-conversation-drafts).
- Show ATC spoken radio names for the connected position, keeping dropdowns
  limited to callsign/frequency; investigate the available IVAO data source.
- Add a copyable ATC contact log: qualify a position only after own TX followed
  by RX on that same position, with no visible timestamps.
- Show the current voice speaker beside RX if TS2 sender identity can be verified.
- Indicate stale source data without treating unchanged values as stale.
- Add customizable checklist templates, local import/export, and separately
  designed account storage/sharing.
- Evaluate a technical VoxHF preflight check.
- Improve audit filtering and incident-oriented server diagnostics.

Detailed decisions, examples, rejected alternatives, data sources, and open
questions are preserved in [Feature Plans](FEATURE_PLANS.md), with implemented
baselines explicitly versioned. The preflight check remains a proposal,
not committed implementation work.

## Live RX Speaker Identification Plan

Show the current speaker only when the identity is reliable; otherwise retain
ordinary RX. The full [speaker identification plan](FEATURE_PLANS.md#live-rx-speaker-identification)
covers participant mappings, simultaneous speakers, privacy, and live validation.

## Private Chat Aliases Plan

Keep names beside real callsigns, with friends identified by VID rather than
callsign ownership. The [alias notes](FEATURE_PLANS.md#private-chat-aliases)
retain earlier UI alternatives; the current
[friends plan](FEATURE_PLANS.md#friends-identity-and-presence) defines Add friend,
name-based chat shortcuts, shared presence caching, and open storage decisions.
Refresh is configurable at 15 seconds, 30 seconds, or 1 minute: local-only
defaults to 30 seconds (user setting); relays default to 15 seconds (server
administrator setting). This replaces the earlier session-only alias direction
without making chat history persistent. No part of this plan is implemented.

## Installation And Operator Experience Plan

Planning only: the following installers, tray controls, and command examples
are proposals, not shipped features. Do not rewrite the proxy, change audio
routing, or embed the operational webapp merely to simplify installation.

### Local Windows App Without A Console

- Prototype a tray launcher around the existing Node agent, keeping the
  operational webapp in the user's browser. Prefer evaluating a small C#/.NET
  launcher first; Electron remains an alternative if a full desktop interface
  becomes justified. The framework choice is not final. Start as an ordinary
  user-session app, not a Windows service.
- Target flow: download `VoxHF Setup.exe`, install, choose local-only operation
  or connection to a server, then run in the background without a console.
  The first-run wizard should collect the existing relay settings and show the
  exact Simulator Address to enter in PilotUI. Local mode must remain usable
  without an account.
- Provide tray actions for opening VoxHF in the browser, configuration,
  diagnostics, optional start-with-Windows, and explicit exit. Display agent,
  Altitude, and relay status separately. Closing a configuration window leaves
  the agent running; exiting VoxHF stops it.
- Retain both tray and console launch modes around the same agent code. Keep
  `start.bat` available for direct console diagnostics; do not maintain a second
  proxy implementation. Opening a second launcher must not create another agent.
- Provide a tray diagnostics view for the running session without restarting
  an active flight. Use a bounded in-memory log buffer with explicit copy/export;
  exclude credentials, pairing codes, private message content, and audio. Extra
  routing diagnostics remain explicitly enabled, not normal-operation dumps.
- Package a tested Node runtime, preinstalled Local-only dependencies, and a
  Speex-capable FFmpeg build so users do not need Winget or npm on first launch.
  If .NET is selected, evaluate self-contained distribution too. Measure the
  download/runtime cost and define maintenance of every bundled dependency.
- Before bundling FFmpeg, verify the exact build's redistribution requirements
  and include applicable licenses, notices, and corresponding source/build
  references. Evaluate Windows code signing and retain a source/ZIP option.
- Enforce one agent instance, expose startup failures and port conflicts, and
  manage child-process lifetime explicitly. Exit must stop TX and FFmpeg;
  neither launcher failures nor restart attempts may leave orphan processes.
  Preserve the existing disconnect and optional proxy-offline alert policy.
- Separate application binaries from private configuration and notification
  state. Updates must preserve device identity and subscriptions, support
  recovery to the previous version, and never silently restart an active flight.
  Diagnostics must remain bounded and exclude audio, chat contents, credentials,
  and Push tickets.
- Sequence: prototype tray lifecycle/configuration first; test with existing
  Altitude and browser behavior; then package dependencies and build the installer.

### Local First-Run And Configuration Flow

The tray proposal above should use the following guided flow; none of these
installer screens is implemented yet.

1. Offer explicit import from an existing VoxHF folder. Preserve private
   configuration, stable device identity, and local notification credentials and
   subscriptions without resetting pairing or starting a duplicate agent.
2. Ask whether VoxHF will be used only on this PC or also from other devices.
   Local-only operation needs no account; remote mode must retain local access.
3. For remote mode, offer the VoxHF server or a custom server, the existing agent
   token flow with a link explaining where to obtain it, a friendly PC name, and
   a connection test with actionable errors. Browser-based authorization could
   replace token copy/paste later, but requires a separately designed and tested
   authentication flow; do not collect the account password in the launcher.
4. Detect the network interface and show a copyable Simulator Address with
   PilotUI instructions and a connection check. Allow manual interface selection
   when detection is ambiguous. Do not silently edit Altitude configuration.

Keep launcher settings limited to server/device connection, network selection,
optional Windows startup, updates, and diagnostics. Browser-specific microphone,
audio output, RX activation, and notification permissions/preferences remain in
the webapp. Do not expose every codec or packet-timing parameter as an ordinary
setting; preserve the tested defaults and reuse configuration validation rather
than introducing conflicting launcher defaults.

Build the tray, wizard, and existing-install migration first, validate their
lifecycle with Altitude, then package the complete installer. On uninstall, ask
explicitly before deleting private configuration or notification state. Treat
installation, import, update, rollback, and removal as separate test scenarios.

### Guided Server Installation And Updates

- Keep Docker Compose/Caddy and SSH recovery. The current detached deployment
  already runs without an open SSH terminal; simplify setup and maintenance,
  rather than adding another background-process manager.
- Publish prebuilt, versioned VoxHF container images with recorded digests so
  the VPS downloads tested artifacts instead of compiling dependencies. Keep
  source builds available and make release identity visible in diagnostics.
- Add a guided installer covering prerequisites, domains, configuration, DNS,
  port availability, and HTTPS/health verification. Explain privileged changes
  before applying them; preserve existing configuration and SSH access, and
  never expose the local-agent ports.
- Offer a single update workflow: verified backup, artifact download, controlled
  restart, health check, and a documented recovery path. Distinguish Git, release
  package, and future image-based installations instead of always using Git pull.
- Use the existing admin panel for ordinary account administration. Do not give
  the web application direct Docker-socket access to implement an update button.
  Installation and emergency recovery must remain available through SSH.

### Complete Server Command Help

- Expand today's `infra/docker/voxhf-server.sh help` into one discoverable
  reference. A short `voxhf` entry point is a candidate, not an existing command.
- Inventory existing scripts and group all supported operations under setup and
  status; maintenance; pilot accounts; owner administration; and diagnostics.
  Candidate coverage includes start/stop/restart, version/doctor, update,
  backup/list/verify/restore/rollback, users and invites, access recovery,
  session revocation, owner setup/recovery, logs, and connection checks.
- Map each operation to its real implementation before exposing it. Some need
  wrappers around separate scripts; others need implementation first. Help must
  never advertise unavailable commands or incompatible deployment workflows.
- Provide a short overview plus command-specific help. Proposed examples:
  `voxhf help`, `voxhf help backup`, `voxhf help update`, and `voxhf help users`.
  Each entry should explain purpose, syntax, arguments/options, a copyable
  example, required privileges, and consequences such as connection interruption,
  data changes, or restart requirements.
- Keep normal commands scriptable, with useful errors for missing arguments and
  nonzero exit codes on failure. Interactive menus may be optional, never the
  only way to operate the server. Keep help and installation docs consistent
  with the actual command definitions and cover dispatch/help with tests.

## Features Requiring A Separate Product Decision

- Integrate the official IVAO Voice UNICOM service at `122.800` for manual
  browser RX/TX. The local agent must use the official encrypted and signed
  Voice session while IVAO retains propagation, terrain, attenuation, and
  collision behavior. The protocol, live-capture plan, approval gate, and
  current findings are preserved in [Voice Integration Research](VOICE_RESEARCH.md).
- Evaluate a managed live IVAO frequency-listening page. Predictable coverage
  requires an official read-only feed or authorized service identities; an
  opt-in community source election can provide only explicitly labelled,
  incomplete coverage. Public rebroadcasting requires IVAO authorization and a
  separate privacy, load, abuse, and threat-model review. See
  [Voice Integration Research](VOICE_RESEARCH.md).
- Add privacy-preserving public activity counters for remote use: contributing
  pilots, tracked flights, flight hours, and nautical miles. Calculations would
  stay in the local agent and the server would persist aggregate counters, not
  callsigns, routes, coordinates, or per-flight history. Local-only flights and
  other self-hosted relays would not be included in the main site's totals.
- Controlled automatic ATIS or route-weather refresh. Any polling must be
  bounded and opt-in.
- Guided UNICOM text/voice reports based on phase of flight, including the
  known three-minute reporting rule. Automatic transmission requires live IVAO
  validation, explicit user control, and a separate safety design.
- Opt-in live RX transcription with callsign context. It must not introduce
  voice recording or persistent audio storage.
- Airport/taxi maps and route highlighting.
- Automatic aircraft model detection for checklist selection; manually
  customizable checklist templates are covered in [Feature Plans](FEATURE_PLANS.md#custom-checklists-and-sharing).
- Compressed remote audio, only if measured bandwidth requires it.

## Not Planned

- Publishing local PilotUI, PilotCore, FSD, TS2, or webapp ports.
- Storing IVAO credentials in the browser or relay.
- Voice recording or normal-operation voice dumps.
- Persistent full chat history.
- Mandatory MFA or Shared Cockpit.
- Replacing Altitude or bypassing IVAO rules.
- Open registration on a VoxHF-operated public relay before independent review
  and an explicit hosting/legal decision.
