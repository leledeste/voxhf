# VoxHF Maintainer Handoff

Last updated: 2026-07-13
Project version: `0.1.0` pre-release
License: MIT
Repository: `https://github.com/leledeste/voxhf`
Public domains: `voxhf.com`, `app.voxhf.com`, `relay.voxhf.com`

This document is the complete working context for an AI or human maintainer.
Read it before changing code. It describes the current working tree, the
architecture, verified behavior, product decisions, known documentation drift,
and work that remains before a wider beta.

## 1. Read This First

- VoxHF is an unofficial, open-source companion for IVAO Altitude. It does not
  replace Altitude and is not affiliated with or endorsed by IVAO.
- The local Node.js agent is the source of truth. It stays on the simulator PC
  and sits between PilotUI, PilotCore, IVAO FSD, and IVAO TS2 voice.
- The browser never talks directly to IVAO. Remote browsers talk to a relay;
  the relay talks to the local agent through an outbound WSS connection.
- Never expose local ports `4827`, `6809`, `8767`, or `3000` to the internet.
- The project is pre-release. Version metadata intentionally remains `0.1.0`.
- The local checkout folder may still be named `contrail`, but the product,
  package, repository, domains, UI, and documentation are named VoxHF.
- The current branch is `main`. At the time of this handoff, `origin/main` is
  commit `0c3c245`, while the working tree contains substantial intentional,
  unreleased changes. Do not reset, discard, or overwrite the dirty tree.
- All source comments and user-facing project documentation must be in English.
- Prefer the existing dependency-free frontend and focused Node modules. Do not
  add a framework or abstraction without a concrete need.

### Important documentation drift

`docs/TECHNICAL_PAPER.md` still says that Web TX needs one physical Altitude
PTT press after startup. That is no longer the normal behavior. The current
`proxy/web-tx.js` derives the TX session seed from TS2 setup packets and was
manually confirmed to work without the first physical PTT, including after a
TS2 server change. A native Altitude TX packet is now only a replacement or
fallback seed. Update the paper before release.

The operational source of truth is, in order:

1. Current working-tree code and automated tests.
2. `docs/ROADMAP.md` and `CHANGELOG.md`.
3. This handoff.
4. Older narrative documents such as the Technical Paper when they conflict.

## 2. Product Summary

VoxHF provides one browser workspace for:

- COM1 and COM2 frequency control.
- Online ATC station dropdowns sorted by aircraft distance when coordinates are
  available.
- Permanent UNICOM `122.800` selection and `_OBS` filtering.
- Live IVAO voice receive in local and remote browsers.
- Browser microphone transmit on COM1 or COM2.
- A phone-as-microphone workflow for simulator PCs without a microphone.
- Squawk, STBY/ALT, and IDENT controls.
- Frequency, broadcast, and private text messages.
- Per-peer private chat tabs and dot-command completion.
- METAR, TAF, ATIS, route weather, and optional plain-language weather parsing.
- Local-only operation without an account.
- Remote operation from another network through a private or self-hosted relay.
- Multiple browsers for the same user and simulator agent.

VoxHF is currently intended for responsible private testing. There is no open
public account service. Account registration on a self-hosted deployment is
invite-only by default.

## 3. Product Modes

### Local

- Run the local agent on the Altitude PC.
- Open `http://localhost:3000`.
- No account, relay, SQLite database, Docker, or public network exposure.
- The local static server maps `/` directly to `webapp/app.html`, not to the
  public landing page.

### Existing remote server

- The operator provides the hosted app URL, relay URL, and an invite when
  registration is restricted.
- The user creates an account, receives an agent token once, and configures the
  local agent with that relay and token.
- Every trusted browser signs in to the hosted app with the same account.
- One user can use multiple browsers, but only that user's agent is visible.

### Self-hosted

- One VPS is sufficient for a private or small community installation.
- Caddy serves the landing page and hosted app and terminates HTTPS/WSS.
- The relay, SQLite accounts, admin UI, and directory API run in one Node
  service inside Docker.
- The local agent still runs on each pilot's Windows PC.

## 4. Public URLs And Web Surfaces

The production routing contract is in `infra/docker/Caddyfile`.

### `https://voxhf.com`

- `/`: public landing page from `webapp/index.html`.
- `/setup`: visual setup guide from `webapp/setup.html`.
- `/servers`: opt-in public server directory from `webapp/servers.html`.
- `/privacy.html`: concise public privacy page.
- `/directory/api/*`: proxied to the central relay directory API.
- Operational app files are deliberately blocked on the landing hostname.

### `https://app.voxhf.com`

- `/`: operational workspace from `webapp/app.html`.
- `/login`: account page from `webapp/login.html`.
- `/register`: the same account page opened in registration mode.
- Registration, login, and recovery share one page and one `auth.js` client.

### `https://relay.voxhf.com`

- `/ws`: browser and agent WebSocket endpoint.
- `/health`: JSON health endpoint.
- `/admin`: relay owner administration UI.
- Account, admin, pairing, directory, and session APIs are served here.

The app and relay have been deployed together on one Hetzner VPS with DNS at
Cloudflare and TLS handled by Caddy. Core hosted workflows have worked in live
testing. The latest uncommitted landing-page changes have not necessarily been
pushed or redeployed yet.

## 5. High-Level Architecture

```text
PilotUI
  | TCP 4827 to the selected LAN IPv4
  v
VoxHF local agent
  | TCP 4827 pass-through
  v
PilotCore at 127.0.0.2

PilotCore -- redirected FSD --> VoxHF 127.0.0.1:6809 --> real IVAO FSD
PilotCore -- redirected TS2 --> VoxHF LAN-IP:8767      --> real IVAO TS2

Local browser <---- HTTP + WebSocket on 127.0.0.1:3000 ----> local agent

Local agent ---- outbound authenticated WSS ----> optional relay
Remote browser <----------- HTTPS/WSS ----------> optional relay
```

VoxHF forwards the original Altitude sessions and observes only the state it
needs. Remote mode is not a raw tunnel. Browsers send typed allowlisted actions
and receive typed state plus live PCM audio.

## 6. Local Runtime And Ports

`proxy.js` is the composition root. It validates configuration, detects the
LAN IPv4, creates each focused module, wires callbacks, starts listeners, and
prints startup instructions.

| Port | Binding | Purpose |
| --- | --- | --- |
| `4827` | selected LAN IPv4 | PilotUI -> VoxHF -> PilotCore bridge |
| `6809` | `127.0.0.1` | redirected PilotCore FSD connection |
| `8767` TCP/UDP | `0.0.0.0` | redirected TS2 control and voice transport |
| `3000` | `127.0.0.1` | local webapp and `/ws` control/audio channel |

The LAN address is chosen from active non-loopback IPv4 interfaces. Automatic
selection must work with Ethernet or Wi-Fi. `config.json.lanIp` can override it
when needed. Start VoxHF before PilotUI and enter the printed address as the
PilotUI Simulator Address.

### Runtime module map

| File | Responsibility |
| --- | --- |
| `proxy.js` | Composition root and startup only |
| `proxy/config.js` | Config defaults, validation, interface enumeration, LAN IP choice |
| `proxy/pilot-bridge.js` | PilotUI/PilotCore pass-through, FSD rewrite, COM learning, synthetic TX lamp |
| `proxy/pilot-core.js` | Binary PilotCore frame helpers for frequency and XPDR |
| `proxy/fsd-proxy.js` | FSD TCP proxy, parsed state, text, weather, ATIS, flight-plan and voice announcements |
| `proxy/fsd-parser.js` | Buffered FSD line parsing and normalization |
| `proxy/ts2-voice-proxy.js` | TS2 TCP/UDP forwarding, RX packet extraction, ffmpeg decoder, TX seed side tap |
| `proxy/web-tx.js` | Microphone PCM encoding, Ogg/Speex extraction, TS2 TX shaping and pacing |
| `proxy/ogg-speex.js` | Ogg/Speex packet reader/writer and CRC support |
| `proxy/app-state.js` | Browser-visible source of truth and reconnect snapshots |
| `proxy/local-web-server.js` | Local HTTP server, origin checks, WebSocket fan-out and binary audio |
| `proxy/websocket-commands.js` | Small allowlisted local browser command dispatcher |
| `proxy/remote-agent.js` | Optional outbound relay connection and typed command/audio bridge |
| `proxy/static-web.js` | Safe static file serving; local `/` maps to `app.html` |
| `proxy/socket-utils.js` | Defensive socket/process cleanup helpers |
| `proxy/port-diagnostics.js` | Friendly bind-error diagnostics |

Do not merge these modules back into a monolithic `proxy.js`.

## 7. Local State Model

`proxy/app-state.js` is the source of truth for UI-visible state:

- callsign and FSD connection state;
- current COM1/COM2 frequencies and selected station names;
- squawk and transponder mode;
- flight-plan filed/missing state and departure/destination/alternate;
- departure and destination METAR/TAF state;
- online ATC stations and own position;
- the latest 200 in-memory messages.

New browsers receive an `init` snapshot with the latest state and last 100
messages. Existing browsers receive live events. This is why COM and XPDR state
can survive a page refresh while the proxy remains open and why two browser
tabs should converge on the same agent state.

Chat history is intentionally memory-only. It survives a page refresh while the
agent remains open and disappears when the agent restarts. Persistent full chat
history was explicitly rejected as unnecessary and should not be added by
default.

## 8. Radio, XPDR, Messages, And Weather

### Radios

- Frequencies can be typed directly; the UI inserts the decimal after the first
  three digits.
- Station dropdowns combine learned FSD/voice station data with UNICOM.
- `_OBS` stations are ignored.
- Distance sorting uses own aircraft latitude/longitude plus station
  coordinates learned from FSD when both exist.
- A selected station label, frequency, and distance are retained after refresh
  once the station list catches up.
- Web changes optimistically update state, but PilotCore/FSD feedback remains
  authoritative.

### XPDR

- Squawk, STBY/ALT, and IDENT send small PilotCore binary commands.
- Own FSD position packets are parsed to learn the transponder state actually
  being sent to IVAO.
- IDENT remains active visually for five seconds.
- Multiple browser tabs receive the same `xpdr_update` state.

### Messages

- Filters: All, Frequency, Private, System, and one tab per private peer.
- Incoming private messages automatically create the corresponding peer tab.
- Private tabs can be closed with their adjacent close control.
- There is no global Clear button. It was deliberately removed.
- The composer supports recipient selection and private-tab recipient locking.
- There is no raw FSD log in the UI.

Supported dot commands:

```text
.metar ICAO       .wx ICAO
.taf ICAO
.atis CALLSIGN
.msg CALLSIGN text    .m CALLSIGN text
.chat CALLSIGN [text]
.c1 frequency     .c2 frequency
.x code           .sq code
.xpdr              .xp
.ident             .id
```

Typing `.` opens completion. Arrow navigation is bounded at the top and bottom,
scrolls the highlighted option into view, Tab completes, and Enter submits.

### Flight plan and weather

- Repeated `$ERSERVER ... FSD_FPL_ERROR` lines are represented as a compact
  red `No flight plan` status instead of chat spam.
- A filed plan shows a green flight-plan status.
- The route weather panel uses only departure and destination from the flight
  plan. It does not infer airports from the selected radio station yet.
- METAR and TAF are requested manually per airport/type to avoid saturating
  IVAO request limits. New results replace the old panel value.
- Manually requested weather still appears in chat.
- `webapp/weather.js` performs dependency-free METAR/TAF interpretation.
- Interpretation is collapsible and uses `Interpret >`.
- ATIS is available through the command path but does not auto-refresh.

## 9. Voice Receive

### Local flow

```text
real TS2 server
  -> TS2 RXVOICE UDP packet (class 0xBEF3, subtype 0x0C00)
  -> VoxHF extracts payload after the 22-byte RX header
  -> configured leading voice byte is stripped
  -> payload is wrapped as Ogg/Speex for ffmpeg
  -> ffmpeg decodes mono PCM s16le
  -> local WebSocket binary frame
  -> browser Web Audio scheduler
```

Only real RX voice packets are decoded. Earlier experimental versions treated
setup/control traffic as voice and produced noise, compressed-sounding garbage,
and ffmpeg errors. Do not broaden the accepted packet classes without packet
evidence.

Default RX configuration:

```json
{
  "voiceDecode": true,
  "voiceDiagnostics": false,
  "voiceSampleRate": 32000,
  "voiceStripBytes": 1,
  "voiceFramesPerPacket": 12
}
```

### Remote RX

- The agent forwards decoded PCM to the relay in chunks no larger than 32 KiB.
- The relay forwards live PCM only to authenticated browsers watching that
  user's selected agent.
- Audio is not cached, replayed, or written to SQLite.
- There is no RX frame-count or byte-window rate limit. Earlier limits caused
  valid long transmissions to stop with `audio-rate-limited` errors and were
  removed. The per-frame size guard remains.
- Remote RX was manually confirmed on PC and iPhone, including both devices at
  the same time. Subjective latency was below roughly 200 ms in one test.

Known RX issues:

- Overlapping simultaneous callers can both be audible but may clip or cut.
- IVAO/TS2 packet details can change.
- UNICOM is proximity-based and needs broader live validation.
- iOS can alter audio routing/volume while microphone capture is active.

## 10. Voice Transmit

### Browser capture

- TX is hold-to-talk on the COM1 or COM2 button.
- `getUserMedia` requests mono audio with echo cancellation, noise suppression,
  and automatic gain control.
- PCM16 microphone frames use the `CTX1` prefix on the browser WebSocket.
- A 300 ms release tail keeps final syllables from being cut. The microphone is
  not kept open permanently because the user explicitly rejected prewarming.
- Late iOS permission resolution is guarded so releasing PTT before permission
  completes does not start a stuck TX.
- Monitor TX loops the encoded/decoded microphone back locally. It verifies the
  microphone and codec but not IVAO reception.

The 300 ms tail is implemented but still needs broader live confirmation that
both the beginning and end of transmissions are no longer truncated.

### Agent encoding and TS2 shaping

Working profile:

```text
PCM sample rate: 8000 Hz
Channels: mono
Speex quality: 10
ABR: off
Frames per Speex packet: 5
TS2 packet mode: fixed
TS2 datagram size: 325 bytes
TS2 payload: 0x05 plus 308 bytes
Packet interval: 92 ms
```

The flow is:

```text
browser PCM16
  -> ffmpeg/libspeex encoder
  -> Ogg/Speex stdout
  -> JavaScript Ogg packet reader
  -> raw Speex packet
  -> bounded pacing queue
  -> TS2-shaped UDP datagram through Altitude's learned UDP socket
```

The queue is bounded to avoid accumulating seconds of lag. Oversized Speex
packets are trimmed only as a defensive fallback; the working profile normally
fits the 308-byte payload.

### Automatic TX session derivation

The current implementation no longer normally requires the first real Altitude
PTT press:

1. `ts2-voice-proxy.js` observes Altitude's client-to-server UDP packets.
2. `web-tx.js` recognizes TS2 setup classes `0xBEF0/0x0005`,
   `0xBEF1/0x0000`, or `0xBEF4/0x0001`.
3. Bytes `4..11` become the TX session bytes.
4. VoxHF constructs a `0xBEF2/0x0C00` TX header and starts the sequence at
   `0xffffffff`, so the first sent packet uses sequence zero.
5. If Altitude later sends a native TX packet, the exact native header and
   sequence replace the derived seed.

The seed is invalidated when the TS2 UDP client closes, FSD disconnects, or the
voice server changes. It is re-derived after the new TS2 setup. This was
manually confirmed to keep TX working after a server change.

The UI and error strings still contain a fallback suggestion to press the real
PTT if no setup seed was observed. That wording should be refined, but do not
remove the fallback path without evidence.

Known TX issues and validation gaps:

- Another listener is required because IVAO does not echo the user's own TX.
- Native listeners reported working, intelligible audio, sometimes with slight
  crackle compared with Altitude.
- Long idle periods should be tested to prove the derived seed never becomes
  stale without a server/client transition.
- iOS raises playback volume or changes the audio route while the microphone is
  active and has previously shown a latched-looking ON AIR state.
- Do not reintroduce TX frame-count or byte-window rate limits. Keep only frame
  size, explicit `tx.start` state, disconnect cleanup, and the maximum TX
  duration guard.

## 11. Remote Architecture

`proxy/remote-agent.js` opens an outbound WebSocket as `source=agent`. The Node
agent authenticates with `Authorization: Bearer <agent-token>` during the
upgrade. Query-token acceptance exists only behind the temporary
`VOXHF_RELAY_ALLOW_AGENT_QUERY_TOKEN` compatibility flag.

`apps/relay/index.js` accepts only `source=agent` or `source=browser`. It:

- validates origins;
- authenticates the socket;
- scopes every connection to one relay user;
- validates every JSON envelope with `packages/protocol`;
- pairs or selects only agents owned by that user;
- routes typed state and allowlisted commands;
- routes binary RX and TX audio live;
- closes or stops TX on disconnect, revocation, timeout, or device switch.

### Protocol envelope

```json
{
  "v": 1,
  "id": "message-id",
  "type": "radio.set",
  "payload": { "com": 1, "freq": "128.350" }
}
```

Types include ping/pong, device list/select/state, pairing begin/code/confirm/
revoke, relay identity/errors, agent hello/status, radio/stations/weather state,
chat send/message, weather/ATIS requests, XPDR controls, TX start/stop, and
monitor start/stop. Unknown types, invalid source/type combinations, extra
fields, invalid frequencies, oversized JSON, and raw protocol tunnels are
rejected.

### Multi-user meaning

Current multi-user support means:

- each relay user has an independent account or token;
- each user normally has one local simulator agent;
- each user can connect multiple browsers, phones, or tablets;
- one user's browsers cannot see or control another user's agent;
- the agent and relay replay compact state to every selected browser.

This is not Shared Cockpit. Do not conflate multiple devices for one owner with
granting another account partial control of the same aircraft.

### Pairing

- Account mode normally discovers and selects the user's own agent after login.
- Manual token mode also uses a short-lived pairing code.
- Pairing codes are generated by the relay, expire after ten minutes by
  default, and can be renewed from the local agent without restarting it.
- JSON pairing persistence is used in `env` mode; SQLite persistence is used in
  SQLite modes.

## 12. Accounts, Admin, And Data

### Authentication modes

| Mode | Meaning |
| --- | --- |
| `env` | One token or `user=token` entries; simplest private relay |
| `sqlite-fallback` | SQLite plus env tokens during migration only |
| `sqlite` | Active SQLite agent tokens only; normal multi-user mode |

New multi-user installations should start directly in `sqlite`. Fallback mode
exists for migrations, not as a preferred permanent configuration.

### Pilot accounts

- Registration is invite-only by default.
- No email address is requested or stored.
- Passwords use salted Node.js `scrypt` hashes.
- Browser sessions use opaque hashed server-side tokens and HttpOnly cookies.
- Registration invites, recovery codes, and agent tokens are shown once and
  stored only as hashes where persisted.
- A lost agent token is rotated; it cannot be recovered.
- The owner can issue a one-use password recovery code.
- Account recovery revokes older browser sessions but does not rotate the agent
  token.

### Admin

- `VOXHF_RELAY_ADMIN_TOKEN` is bootstrap and break-glass only.
- Daily administration uses a separate owner username/password and HttpOnly
  admin session.
- The panel manages users, invites, agent tokens, devices, pairings, sessions,
  recovery, audit state, and account deletion.
- Owner passkey MFA is implemented but always opt-in.
- Removing the last passkey disables MFA.
- Recovery codes are one-use and stored hashed.
- A break-glass owner recovery resets password, revokes sessions, and clears
  MFA to avoid permanent lockout.

### Storage and privacy

Stored by account mode:

- username and display name;
- password hash;
- hashed agent/session/pairing identifiers;
- device and session lifecycle timestamps;
- optional bounded audit metadata;
- optional session IP and user-agent metadata.

Not stored by default:

- IVAO credentials;
- raw FSD or TS2 packets;
- voice recordings;
- PCM/Speex audio;
- persistent full chat history;
- full authentication tokens.

`VOXHF_RELAY_PERSIST_AUDIT` and
`VOXHF_RELAY_STORE_SESSION_METADATA` are false by default. Audit retention is
seven days by default when enabled.

## 13. Public Server Directory

`webapp/servers.html` is a separate public page. A relay is never listed
automatically. The central directory administrator creates the listing and a
dedicated heartbeat token; the operator explicitly opts in.

Published listing data can include server name, operator, region, access
policy, app/relay URLs, source/privacy links, version, registration state, and
last heartbeat. Heartbeats do not contain user counts, accounts, messages,
radio state, position, audio, or IVAO traffic.

The directory must always explain that:

- independent servers may modify VoxHF;
- their privacy and data handling cannot be verified by the project;
- a heartbeat proves only recent possession of the listing token;
- a listing is not an audit, uptime guarantee, or endorsement;
- only the central registry can mark a listing official;
- a future VoxHF-operated server should appear first and be explicitly labelled.

The registry, authenticated heartbeat, official-label protection, sorting,
search/filter UI, CLI operations, and directory API tests are implemented. A
real official public listing has not been launched.

## 14. Webapp And Visual Design

The frontend is static HTML, CSS, and JavaScript with no build step.

### Operational app

Files: `webapp/app.html`, `webapp/styles.css`, `webapp/app.js`,
`webapp/weather.js`.

The current workspace has:

- responsive desktop/mobile layout;
- Light and Dark themes;
- persistent top status, radios, XPDR, communications, and route weather;
- settings for Audio, Connection, Remote, and About;
- heartbeat and standby recovery;
- update notices from `release.json` and relay version policy;
- deterministic `?demo=1` fixtures for screenshots.

The operational visual direction is modern, minimal, compact, and work-focused.
Avoid oversized marketing cards, nested cards, excessive pills, decorative
orbs, and generic AI-dashboard styling.

### Public landing

Files: `webapp/index.html`, `webapp/site.css`, `webapp/landing.css`,
`webapp/site.js`.

Latest requirements already implemented locally:

- bright white editorial base;
- plain white two-column hero with a dedicated `1600 x 960` workspace
  screenshot slot, not a blurred or decorative UI background;
- deep green emphasis on the `HF` wordmark, key headings, operational labels,
  and primary actions without making the whole page monochromatic;
- full-width dark content bands;
- text-only `VoxHF` wordmark;
- no aircraft-light red/green logo;
- no generic pill-based status decoration;
- horizontal four-feature gallery with native touch swipe, side arrow buttons,
  keyboard navigation, dot indicators, and no visible scrollbar;
- the gallery currently uses white `1600 x 960` placeholders for radio and
  XPDR, live voice, network messages, and route weather;
- final images must use `object-fit: contain` and remain uncropped at narrow
  widths;
- mobile-shaped screenshots are deliberately excluded from the landing page;
- no document-level horizontal overflow;
- compact white sections and dark full-width bands based on the preferred
  structure of the earlier landing page.

Planned gallery screenshot assets:

```text
webapp/assets/screenshots/hero-workspace.jpg
webapp/assets/screenshots/feature-radio-xpdr.jpg
webapp/assets/screenshots/feature-voice.jpg
webapp/assets/screenshots/feature-messages.jpg
webapp/assets/screenshots/feature-weather.jpg
```

Screenshot fixture URLs include:

```text
/app.html?demo=1&theme=light&mode=remote
/app.html?demo=1&theme=dark&mode=remote
/app.html?demo=1&theme=dark&mode=remote&panel=communications
/app.html?demo=1&theme=light&mode=remote&panel=weather&weather=expanded
```

### Public setup guide

Files: `webapp/setup.html`, `webapp/site.css`, `webapp/setup.css`,
`webapp/site.js`.

The setup guide follows the landing page's white and deep-green visual system.
It opens with a two-column introduction and three clearly separated setup
paths, then presents each path as a full-width instruction section. Command
examples use dedicated dark terminal blocks; inline code keeps the lighter
documentation style. At narrow widths the path selector, headings, steps, and
command blocks collapse to one column without document-level horizontal
overflow.

Run `npm.cmd run site:preview` for visual review without opening Altitude proxy
ports. The latest landing revision still needs user approval after deployment.

### Account and admin UX

The account page is separate from the workspace. Login, Register, and Recover
are tabs in one page. The admin panel is a separate operational surface on the
relay domain. Both work, but their information architecture and final visual
polish should be reviewed again before beta.

## 15. Standby And Reconnection

An earlier page could become visually disconnected after browser standby while
audio continued playing. Current `app.js` uses ping/pong timestamps, connect
timeouts, visibility/page lifecycle events, AudioContext resume logic, and a
forced reconnect when the control socket is stale.

The browser state must not rely only on `WebSocket.readyState === OPEN`, because
a suspended tab can retain a stale socket object. Audio and control recovery are
separate concerns. Preserve this distinction when simplifying the frontend.

## 16. Deployment

### Docker layout

- `voxhf-relay`: Node relay on internal port `8787`.
- `caddy`: ports `80` and `443`, TLS, static webapp, reverse proxy.
- named volumes: relay data, Caddy data, Caddy config.
- host backup directory mounted at `/var/backups/voxhf`.
- JSON logs rotate at 10 MiB with three files.

Tracked safe defaults live in `infra/docker/defaults.env`. Private domains,
tokens, and operator choices live in ignored `infra/docker/.env`, loaded last.
Do not tell operators to recopy every new default into `.env`.

Use `infra/docker/voxhf-server.sh` for `doctor`, `start`, `logs`, `backup`,
`restore`, `update`, and `rollback`. Managed update requires a clean VPS Git
tree, creates a pre-update SQLite backup, performs a fast-forward pull, rebuilds,
waits for health, and records the previous commit. Rollback is explicit because
it resets tracked source and restores the matching database backup.

The normal VPS deployment has been used successfully. A complete disaster
recovery rehearsal, including provider snapshot, off-server backup, failed
upgrade, rollback, and restore, remains pending.

## 17. Release And Update System

`release-manifest.json` generates four independent packages:

1. `voxhf-local`: local agent and webapp, dependency only on `ws`.
2. `voxhf-hosted-webapp`: static browser UI only; not functional without a
   trusted relay and local agent.
3. `voxhf-server`: relay, SQLite, admin, Docker/Caddy, webapp, and server tools.
4. `voxhf-full-source`: complete contributor/auditor source tree.

Commands:

```powershell
npm.cmd run release:version -- 0.1.1
npm.cmd run release:version:check
npm.cmd run release:prepare
npm.cmd run release:verify
npm.cmd run release:test
```

Artifacts include package-specific `package.json`/lockfiles, SHA-256 checksums,
and release metadata. `release:test` extracts every ZIP, performs isolated
dependency installs, and runs package-specific smoke checks. Never commit
`dist/`.

The tag-driven GitHub workflow publishes a release only when the tag version,
`package.json`, and `webapp/release.json` agree.

### Update behavior

- The webapp checks `release.json` or relay version policy and shows a required
  or recommended update notice.
- The relay can reject agents below a configured minimum version.
- The Local updater checks metadata, verifies size and SHA-256, downloads, and
  stages a sibling installation folder while copying only `config.json`.
- It does not silently overwrite a running installation and does not yet ship a
  signed Windows binary or installer.

## 18. Verification Status

### Automated checks completed on 2026-07-13

```text
npm.cmd run check           PASS
npm.cmd run remote:test     PASS
npm.cmd run release:prepare PASS
npm.cmd run release:test    PASS (four clean package installs)
git diff --check            PASS
browser console errors      none during landing QA
```

The latest package sizes were approximately 560 KiB Local, 508 KiB Hosted
Webapp, 597 KiB Server, and 700 KiB Full Source.

Automated coverage includes syntax, configuration, protocol validation, origin
rejection, token rejection, user isolation, pairing, device selection,
allowlisted command routing, RX/TX binary routing, account/admin APIs, SQLite
migrations, backup/restore helpers, directory registry/API, dependency licenses,
privacy guards, web assets, and release structure.

### Live/manual behavior confirmed during development

- PilotUI/PilotCore/FSD proxy connection.
- COM, XPDR, commands, private/frequency chat, METAR/TAF.
- Local RX and TX with another listener.
- Hosted app account login and session persistence.
- Remote COM, XPDR, chat, RX, and TX through the VPS.
- PC and iPhone connected simultaneously to one agent.
- iPhone remote access over 4G.
- Remote TX reported intelligible, including a later 5/5 report.
- Automatic TX session derivation without a physical PTT.
- TX continued after changing TS2 server.
- SQLite pairing, users, admin operations, token rotation, disable/delete.
- Public relay health and Caddy/TLS after domain migration.

Manual evidence is valuable but is not a substitute for repeatable integration
tests. IVAO does not provide a local echo for final TX quality.

## 19. Known Limitations And Unfinished Validation

- Real Altitude/IVAO/TS2 integration is not automated.
- A clean Local ZIP installation on a genuinely clean second Windows PC is
  still required.
- A full real-VPS update, restore, and rollback rehearsal is still required.
- A broader independent security review and penetration test are required.
- Git history must be scanned for old secrets and development tokens rotated.
- GitHub CodeQL, Dependabot, secret scanning, and private vulnerability
  reporting should be enabled and verified.
- Passkey MFA has automated preflight coverage, but the complete real-device
  Windows/macOS/iOS matrix must be repeated for the release candidate.
- The app is responsive but still needs a dedicated mobile interaction and
  audio UX pass.
- iOS microphone/audio-route behavior needs focused work.
- Overlapping RX transmissions can clip.
- Slight TX crackle compared with native Altitude remains possible.
- The 300 ms TX release tail needs wider live testing.
- Long-idle derived TX session behavior needs deliberate testing.
- UNICOM proximity voice behavior needs deliberate testing.
- Account/admin UI needs final product and accessibility review.
- The current frontend `app.js` is still large. Split it only along stable
  responsibilities and with regression tests; do not repeat the earlier
  extraction regressions in radio/XPDR/RX/TX synchronization.
- The Technical Paper must be updated for the current TX seed derivation,
  account architecture, directory, packaging, branding, and UI.
- Current local landing changes need commit, push, VPS deployment, and final
  visual approval.

## 20. Planned Product Features

Nearer-term candidates already accepted into the roadmap:

- richer METAR/TAF interpretation and abbreviation tooltips;
- controlled ATIS and route-weather refresh;
- opt-in notifications for important private messages;
- improved mobile layout and iOS audio interaction;
- richer admin audit filtering;
- smoother onboarding for local, existing-server, and self-hosted setup;
- possible lightweight Windows installer or portable runtime after clean-PC
  friction is measured.

Longer-term experimental features:

- RX transcription with callsign context;
- structured clearance scratchpad populated from transcription;
- airport map with highlighted taxi routing;
- aircraft-model detection from the IVAO flight plan and optional checklists;
- optional compressed remote audio only if bandwidth measurements justify it;
- email-based account recovery only if the project intentionally accepts the
  added personal-data, delivery, abuse, and operational burden.

### Shared Cockpit is deliberately deferred

Shared Cockpit is a future concept, not current work. It would let another
account access one pilot's audio, TX, radio, XPDR, and messages. Before any
implementation it needs:

- explicit owner/guest grants;
- COM-specific permissions such as `tx_com1` and `tx_com2`;
- an atomic TX lock with defined user-vs-browser ownership;
- owner force-release and disconnect cleanup;
- queryable permission tables rather than opaque JSON blobs;
- structured audit fields;
- graceful fallback to local operation when the relay is unavailable.

Do not implement Shared Cockpit unless the user explicitly reprioritizes it.

## 21. Explicit Product Decisions

Do not silently reverse these decisions:

- No raw FSD log in the webapp.
- No Telegram bot or Telegram integration.
- No voice dumps or TX inspection folders in normal operation.
- No persistent full chat history by default.
- No voice recording.
- No analytics or advertising trackers.
- No email collection in the current account model.
- No public exposure of local agent ports.
- No raw FSD, TS2, or PilotCore tunnel through the relay.
- No mandatory MFA; owner passkey MFA is opt-in.
- No permanently open microphone or microphone prewarm for TX.
- No automatic weather request spam; route weather requests are manual.
- No `_OBS` entries in station dropdowns.
- No decorative aircraft-light logo.
- No screenshot cropping in the public landing gallery.
- No automatic wrap from bottom to top in command autocomplete.
- No global chat Clear button.
- No assumption that an independent directory listing is trusted or audited.

## 22. Security Rules For Future Work

- Treat the local agent as a privileged boundary.
- Keep browser and relay commands typed and allowlisted.
- Validate again at the local agent before touching PilotCore or FSD.
- Use fixed ffmpeg argument arrays, never shell-built audio commands.
- Keep audio live-only and out of SQLite/logs.
- Keep tokens out of URLs whenever the client can set an Authorization header.
- Use exact HTTPS origins and reject browser WebSockets without an allowed
  `Origin`.
- Preserve HttpOnly, Secure, SameSite cookie behavior.
- Store only token hashes and compare secrets in constant time where applicable.
- Stop TX on browser, relay, agent, pairing, or device disconnect.
- Do not reintroduce audio throughput limits that break valid continuous RX/TX;
  use frame size, session state, backpressure, and maximum TX duration instead.
- Keep account and admin identity domains separate.
- Add tests proportional to every changed trust boundary.

## 23. Development Workflow

Requirements:

- Node.js 20 or newer.
- ffmpeg with Speex encoder and decoder.
- Windows for live local Altitude tests.
- Docker/Caddy/Linux for deployment tests.

Common commands:

```powershell
npm.cmd install
npm.cmd run setup
npm.cmd start
npm.cmd run site:preview
npm.cmd run check
npm.cmd run remote:test
npm.cmd run relay:account:test
npm.cmd run relay:admin:test
npm.cmd run relay:backup:test
npm.cmd run directory:test
npm.cmd run directory:api:test
npm.cmd run update:test
npm.cmd run release:prepare
npm.cmd run release:test
npm.cmd audit
```

Before changing behavior:

1. Read the owning module and its tests.
2. Preserve current working-tree changes.
3. Keep comments concise, in English, and focused on logic or rationale.
4. Avoid unrelated refactors.
5. Run `npm.cmd run check` and the focused integration test.
6. For remote/audio changes, run `npm.cmd run remote:test`.
7. For packaging/site asset changes, run release preparation and clean-install
   verification.
8. For frontend changes, test real desktop and mobile viewports and inspect
   screenshots, not only DOM values.

## 24. Immediate Recommended Sequence

1. Review and commit the current intentional working tree without reverting
   unrelated changes.
2. Push and deploy the latest white/dark-band landing page and new screenshots.
3. Validate `voxhf.com`, `app.voxhf.com`, and `relay.voxhf.com` on desktop,
   narrow desktop, iPhone Safari, and macOS Safari.
4. Update the Technical Paper and any remaining physical-PTT wording.
5. Perform the clean second-Windows-PC Local package test.
6. Rehearse VPS backup, failed update, rollback, and restore with off-server
   copies.
7. Complete the real-device passkey matrix and independent security review.
8. Refine mobile/iOS audio UX and repeat simultaneous PC/phone RX/TX tests.
9. Publish a release candidate only after version metadata, changelog, release
   ZIPs, checksums, GitHub tag, and deployed compatibility policy agree.
10. Run a small invite-only beta and collect structured feedback before any
    broader announcement.

## 25. Final Maintainer Notes

The difficult parts of VoxHF are protocol fidelity, live voice timing, browser
standby recovery, and keeping state synchronized across Altitude, the local
agent, relay, and several browsers. A visually simple change can affect these
flows. Preserve the local agent as the authority, fail closed for remote TX,
and verify live behavior whenever packet or audio code changes.

Do not infer that a feature is missing only because an old document says so.
Check the current module and tests first. Conversely, do not call a feature
production-ready only because it worked once against IVAO. Keep the distinction
between implemented, automatically tested, manually confirmed, and still
unverified explicit in code review and documentation.
