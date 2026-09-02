# VoxHF Development

This guide contains commands and diagnostics for contributors. Pilot setup is
in [Local Installation](INSTALL_LOCAL.md), operation is in the
[User Guide](USER_GUIDE.md), and VPS setup is in
[Self-Hosting](SELF_HOSTING.md).

## Setup

```powershell
npm.cmd ci
npm.cmd run setup -- local
npm.cmd run verify
```

Requirements:

- Node.js 20 or newer.
- ffmpeg with Speex support for live voice work.
- Windows and Altitude for real IVAO integration tests.
- Docker only for self-hosted relay testing.

## Verification

| Command | Purpose |
| --- | --- |
| `npm.cmd run verify` | Syntax, required files, protocol rules, DB migrations, auth/admin/account tests, privacy guards, licenses, and assets. |
| `npm.cmd run setup -- local` | Generate a normal local-agent configuration. |
| `npm.cmd run setup -- agent` | Connect the local agent to an existing relay. |
| `npm run setup -- server` | Generate a Docker self-hosting environment. |
| `npm.cmd run remote:test` | Temporary relay with two users, pairing, controls, RX/TX binary routing, and revocation. |
| `npm.cmd run webapp:test` | Browser-state regressions for workspace accounts/sessions, chat history, Settings, iOS/iPadOS RX activation and recovery, notifications, UNICOM timer, reconnect recovery, radios, XPDR, and route weather. |
| `npm.cmd run relay:account:test` | Hosted pilot-account registration, login, recovery, sessions, and deletion. |
| `npm.cmd run relay:admin:test` | Relay-owner administration, sessions, recovery, and optional MFA paths. |
| `npm.cmd run fsd:test` | Confirmed disconnect detection and stationary-aircraft suppression policy. |
| `npm.cmd run webtx:test` | Web TX readiness and atomic TS2 session replacement across alternating UDP flows. |
| `npm.cmd run unicom:test` | Deterministic three-minute reminder state and expiry behavior. |
| `npm.cmd run watchdog:test` | Memory-only relay watchdog staging, expiry, reconnect, and delivery behavior. |
| `npm.cmd run remote:check` | Compare local relay `.env` with `config.json` and check relay health. |
| `npm.cmd audit` | Dependency vulnerability report. |
| `npm.cmd run release:prepare` | Generate ignored release folders under `dist/`. |
| `npm.cmd run release:verify` | Inspect checksums, ZIP contents, locks, and package structure. |
| `npm.cmd run release:test` | Extract all ZIPs and perform clean isolated installs. |
| `npm.cmd run relay:backup:test` | Create, mutate, and restore a temporary SQLite database. |
| `npm.cmd run update:test` | Download and stage Local through verified release metadata. |
| `npm.cmd run release:version -- <version>` | Synchronize package and update-policy versions. |

Run `verify` and `remote:test` before every commit that changes the
webapp, proxy, protocol, relay, database, or release layout.

## Source Layout

| Path | Purpose |
| --- | --- |
| `proxy.js` | Local-agent bootstrap and dependency wiring. |
| `proxy/` | Pilot, FSD, TS2, Web TX, local web, state, and remote-agent modules. |
| `webapp/` | Static browser UI; `app.js` composes live flight state while `account.js` owns workspace account/session flows. |
| `apps/relay/` | HTTP/WebSocket relay, SQLite, migrations, and admin page. |
| `packages/protocol/` | Versioned remote envelopes and allowlists. |
| `scripts/` | Tests, preflight, DB helpers, and release generation. |
| `infra/docker/` | Caddy and Docker Compose self-hosting. |

Generated `dist/` files are never source. Delete or regenerate them freely.

## Local Relay Test

Create a development environment:

```powershell
Copy-Item apps\relay\.env.example apps\relay\.env
```

Set at least:

```env
VOXHF_RELAY_TOKEN=hex-token-from-openssl-rand-hex-32
VOXHF_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
```

Start the relay:

```powershell
npm.cmd run relay:env
```

Set the same token and local relay URL in `config.json`, enable
`remoteAgentEnabled`, then start VoxHF. Use:

```powershell
npm.cmd run remote:check
```

The health endpoint is `http://127.0.0.1:8787/health`.

## Voice Diagnostics

Enable temporarily in `config.json`:

```json
{
  "voiceDiagnostics": true
}
```

Useful live summaries:

- `[VOICE RX]`: received TS2 packets, decoded Speex, and PCM output.
- `[REMOTE TX]`: browser PCM frames reaching the local agent.
- `[WEBTX]`: encoded Speex packets and TS2 send results.
- `[TS2]`: voice channel and server changes.

Disable diagnostics after testing.

The current working TX configuration is defined in `config.example.json`.
Do not change sample rate, Speex quality, frames per packet, payload shaping, or
packet timing without a second IVAO listener and before/after captures.

## Database And Admin Helpers

Default local database:

```text
.voxhf-relay/voxhf.db
```

Commands:

```powershell
npm.cmd run relay:db:user -- list --db .voxhf-relay/voxhf.db
npm.cmd run relay:db:user -- add user1 --db .voxhf-relay/voxhf.db
npm.cmd run relay:db:user -- rotate user1 --db .voxhf-relay/voxhf.db
npm.cmd run relay:db:user -- revoke user1 --db .voxhf-relay/voxhf.db
npm.cmd run relay:db:user -- disable user1 --db .voxhf-relay/voxhf.db
npm.cmd run relay:db:user -- enable user1 --db .voxhf-relay/voxhf.db
npm.cmd run relay:db:user -- delete user1 --db .voxhf-relay/voxhf.db
npm.cmd run relay:db:user -- backup backup.db --db .voxhf-relay/voxhf.db
```

Import env-mode tokens into SQLite:

```powershell
npm.cmd run relay:db:import-users -- --env apps/relay/.env --db .voxhf-relay/voxhf.db --list
```

The admin page is `/admin` on the relay origin. In SQLite modes the first visit
uses `VOXHF_RELAY_ADMIN_TOKEN` to bootstrap the owner account; normal access
then uses the owner password and a server-side admin session. The token remains
the break-glass recovery credential. See [Administration](ADMINISTRATION.md).

## Auth Modes

- `env`: simplest private relay; tokens come from `.env`.
- `sqlite-fallback`: SQLite tokens plus env tokens during migration/testing.
- `sqlite`: SQLite is the only token source.

New private-token deployments use `env`. New account deployments can start
directly in `sqlite`. Use `sqlite-fallback` only for a temporary migration from
existing env tokens.

## Release Preparation

Update source files first, then run:

```powershell
npm.cmd run verify
npm.cmd run remote:test
npm.cmd run release:prepare
npm.cmd run release:test
```

Inspect the four versioned ZIPs, `release-artifacts.json`, and
`SHA256SUMS.txt`. Never commit `dist/`. A `v<version>` tag runs the release
workflow, repeats these checks, and publishes the generated files through the
GitHub CLI.

Prepare a new release version before committing:

```powershell
npm.cmd run release:version -- 0.1.2-beta.1
# Add --minimum only for an intentionally incompatible/security release.
npm.cmd run release:version:check
npm.cmd run verify
```

Update `CHANGELOG.md`, commit, create the matching `v<version>` tag, and push
the tag. The release workflow refuses tags that differ from `package.json` or
`webapp/release.json`.
Tags with a prerelease suffix, such as `v0.1.0-beta.1`, are automatically
published as GitHub prereleases.

## Code Rules

- Preserve existing protocol and module boundaries.
- Keep comments focused on behavior and reasoning.
- Use parsed structures instead of string guessing where practical.
- Do not log tokens, passwords, raw browser cookies, or IVAO credentials.
- Keep remote commands allowlisted in `packages/protocol`.
- Keep audio live-only and out of SQLite.
- Add tests in proportion to the affected trust boundary.
