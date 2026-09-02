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
- Measure Local installation friction before deciding whether to build a signed
  Windows installer or bundled portable runtime.
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
- Automatic UNICOM voice reports are not supported. Current UNICOM support is
  manual frequency/text plus the synchronized three-minute reminder.
- Local Slim requires Node.js and ffmpeg and is checksum-verified, but it is not
  a signed Windows executable.
- The Local updater stages a new folder instead of replacing a running install.
- Account/admin surfaces and single-process rate limiting fit the documented
  small self-hosted model; a public multi-instance relay needs further design
  and review.
- iOS/iPadOS Web Push requires a supported Home Screen webapp installation.

## Near-Term Product Work

- Recognize METAR and TAF wind groups reported in metres per second (`MPS`),
  including calm, variable wind, and gusts. Keep the original unit visible and
  add the rounded knot equivalent without moving valid groups into
  **Not interpreted**.
- Add an explicit controller-voice mute/output control so users at the
  simulator PC can avoid hearing Altitude and browser RX twice without changing
  the current audio path silently.
- Improve mobile audio-route recovery and make failure states easier to
  diagnose without exposing packet-level controls.
- Broaden METAR/TAF interpretation, edge cases, and explanatory tooltips.
- Add a flight-progress view using the flight-plan route and current aircraft
  coordinates. Candidate forms are a compact route strip or a map with the
  aircraft, next waypoint, remaining distance, altitude, IAS, and Mach when the
  local protocols provide reliable values.
- Add a structured clearance/communication scratchpad.
- Improve audit filtering and incident-oriented server diagnostics.

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
- Aircraft model detection and optional checklists.
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
