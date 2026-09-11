# VoxHF Repository Instructions

These instructions apply to the entire repository.

## Product Scope

VoxHF is an unofficial, open-source browser companion for IVAO Altitude. The
current product has three supported modes:

1. A local Node.js agent and browser app on the simulator PC.
2. The same local agent connected outbound to a trusted relay so the app can be
   used from other devices.
3. A self-hosted relay, account service, static webapp, and public website.

The local agent is always the source of truth. The browser never connects
directly to IVAO, PilotCore, FSD, or TS2.

## Current Architecture

- `proxy.js` is the local-agent composition root.
- `proxy/` contains focused PilotUI, PilotCore, FSD, TS2 voice, web TX, local
  web server, state, notification, and remote-agent modules.
- `apps/relay/` contains the authenticated remote relay, SQLite account/admin
  storage, and relay HTTP APIs.
- `packages/protocol/` defines and validates the typed remote protocol.
- `webapp/app.html`, `webapp/app.js`, `webapp/account.js`,
  `webapp/styles.css`, and `webapp/weather.js` form the dependency-free
  operational frontend. `app.js` owns live flight state and composition;
  `account.js` owns workspace account and browser-session behavior.
- Other files in `webapp/` provide the public site, setup, authentication,
  administration, legal pages, and installable-webapp assets.
- `infra/docker/` is the production Caddy and Docker Compose deployment.

Keep these boundaries unless a measured simplification removes a boundary
entirely. Do not merge the local runtime back into a monolithic `proxy.js`.

## Non-Negotiable Behavior

- Never expose local ports `4827`, `6809`, `8767`, or `3000` to the internet.
- Keep remote messages typed, validated, source-restricted, and allowlisted at
  both relay and local-agent boundaries.
- Stop TX on browser, relay, agent, pairing, or device disconnect.
- Keep audio live-only. Do not record it or store it in SQLite.
- Bind browser RX activation and recovery before account status or relay work.
  A newly loaded iOS/iPadOS document requires one trusted user gesture: expose
  that state through the radio activation prompt and let any normal page gesture
  unlock it. Opening Settings or receiving the first PCM frame must not be the
  only activation path. Keep the page-lifetime gesture retry and the
  foreground/standby recovery for mobile browsers that later suspend,
  interrupt, or close their audio context.
- Keep chat history bounded and memory-only in the local agent. It survives
  browser refreshes during the current proxy session and is independent of
  notification permission.
- Keep Web Push subscriptions and VAPID credentials local to the proxy. The
  relay normally only transports subscription commands. The sole exception is
  the explicitly enabled agent-offline watchdog: the proxy may give the relay
  short-lived, one-use Push requests that are already encrypted and signed.
  Keep those tickets in memory only, send them unchanged, and never put their
  endpoints or contents in SQLite, logs, audits, or backups. The relay must
  never receive the local VAPID private key.
- Notifications are per device and cover incoming private messages, public
  messages beginning with the active callsign, and confirmed IVAO disconnects
  unless fresh telemetry shows the aircraft stationary at no more than five
  knots. Missing or stale flight telemetry must fail safe by sending the
  disconnect alert. Incoming IVAO SERVER welcome messages during the first two
  seconds of a confirmed connection remain in chat but do not trigger Push.
  IVAO online confirmations are optional per browser device. User-started
  three-minute UNICOM reminders are owned in memory by the local proxy, stay
  synchronized across browsers, and notify every subscribed device at expiry.
  The relay must not own or persist their countdown. A remote browser may also
  opt into an agent-offline alert. Arm it only during a confirmed IVAO session,
  disarm it on an observed FSD close before applying the normal disconnect
  policy, and make relay reconnects cancel the offline grace period.
- Preserve local operation without an account or relay.
- Preserve multiple browser devices for one user's selected local agent.
- Keep Settings scroll-contained, route weather reachable on short tablet
  landscape layouts, radio/chat heights aligned, and closing private tabs
  non-destructive.

## Deliberate Product Decisions

Do not add or restore these without an explicit product decision:

- raw FSD, TS2, or PilotCore tunnels through the relay;
- raw FSD logs in the webapp;
- persistent full chat history;
- voice recording or normal-operation voice dumps;
- analytics, advertising trackers, or email collection;
- permanently open microphone capture or TX prewarming;
- automatic weather-request polling;
- `_OBS` stations in radio choices;
- a global chat-clear action;
- mandatory MFA or Shared Cockpit.

## Security And Privacy

- Treat the local agent as a privileged boundary.
- Validate locally before changing PilotCore, FSD, TS2, radio, XPDR, or TX
  state.
- Use fixed argument arrays for ffmpeg; never construct shell audio commands.
- Keep authentication tokens out of URLs where headers or secure cookies work.
- Preserve exact origin checks and HttpOnly, Secure, SameSite cookie behavior.
- Store authentication secrets as hashes and compare secrets in constant time
  where applicable.
- Keep account and relay-owner identities separate.
- Add focused tests for every changed trust boundary.

## Refactoring Policy

Prefer deletion, consolidation, and direct data flow over new abstraction.
Before removing code:

1. Identify its runtime entry point and every static reference.
2. Decide whether it belongs to the current local, remote, or self-hosted
   product.
3. Remove its tests, configuration, documentation, and release paths together.
4. Run the focused tests and the complete verification suite.

Do not remove defensive protocol, reconnect, standby, audio pacing, origin, or
disconnect logic merely because the happy path works. These handle failures
observed during real flights.

The large `webapp/app.js` may be split only along stable responsibilities with
regression coverage. Avoid cosmetic extraction that increases indirection
without reducing state coupling.

## Source And Documentation

- Source comments and user-facing project documentation must be in English.
- Current code and automated tests are the primary source of truth.
- `CHANGELOG.md` records released behavior.
- `docs/ROADMAP.md` records planned work.
- `docs/TECHNICAL_PAPER.md` explains architecture and protocol details.
- Installation and operation belong in `README.md` and `docs/`.
- Keep transient deployment status, old commit IDs, test anecdotes, and
  completed task lists out of this file.

## Versioning

The runtime version lives in `package.json` and must agree with
`package-lock.json` and `webapp/release.json`.

Use:

```powershell
npm.cmd run release:version -- <version>
npm.cmd run release:version:check
```

Change `minimumLocalVersion` only when compatibility is intentionally broken.
Historical versions in changelog entries, fixtures, and examples do not need
mechanical replacement.

## Verification

Use Node.js 24 LTS as the tested baseline (minimum Node.js 24). Before handing
off any code change, run:

```powershell
npm.cmd run verify
```

Also run the focused suite for the area changed:

- remote protocol or routing: `npm.cmd run remote:test`
- accounts: `npm.cmd run relay:account:test`
- relay administration: `npm.cmd run relay:admin:test`
- database backup/restore: `npm.cmd run relay:backup:test`
- local updater: `npm.cmd run update:test`
- release contents: `npm.cmd run release:prepare` then
  `npm.cmd run release:verify`

Frontend changes require real desktop and mobile viewport review. Audio, IVAO,
PilotCore, FSD, and TS2 behavior still requires live validation because the
complete external system is not reproducible in automated tests.

## Working Tree And Deployment

- Preserve unrelated user changes and never reset or overwrite a dirty working
  tree.
- Keep secrets, `config.json`, `.env`, databases, logs, backups, generated
  releases, notification credentials, and subscriptions out of source
  packages.
- Production currently uses Docker Compose and Caddy on the Hetzner VPS at
  `167.233.142.61`.
- A source edit is not deployed until the corresponding VPS files or image have
  been updated and the affected service restarted or rebuilt.
