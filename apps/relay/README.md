# VoxHF Relay

The relay connects authenticated remote browsers to a selected local VoxHF
agent. It routes validated state, commands, messages, and live audio; it does
not connect to IVAO or expose the agent's local ports.

Use [Self-Hosting](../../docs/SELF_HOSTING.md) for a production VPS. This file is
the direct-development reference for the relay component.

## Run Locally

```powershell
Copy-Item apps\relay\.env.example apps\relay\.env
npm.cmd run relay:env
```

Replace every placeholder needed by the selected mode. A minimal private test:

```env
VOXHF_RELAY_HOST=127.0.0.1
VOXHF_RELAY_PORT=8787
VOXHF_RELAY_TOKEN=replace-with-a-random-32-byte-hex-token
VOXHF_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
VOXHF_RELAY_REQUIRE_PAIRING=true
VOXHF_RELAY_AUTH_MODE=env
```

Health is available at `http://127.0.0.1:8787/health`. The exact environment
reference is [apps/relay/.env.example](.env.example); production Docker defaults
are in [infra/docker/defaults.env](../../infra/docker/defaults.env).

## Authentication Modes

| Mode | Credential source | Intended use |
| --- | --- | --- |
| `env` | `VOXHF_RELAY_TOKEN` / `VOXHF_RELAY_USERS` | Private direct test or small token relay |
| `sqlite-fallback` | SQLite plus env tokens | Temporary migration/testing |
| `sqlite` | Active hashed SQLite agent tokens | Account deployment |

Account login requires `sqlite-fallback` or `sqlite` mode. New registration also
requires `VOXHF_RELAY_ENABLE_REGISTRATION=true` and is invite-only by default;
disabling registration does not disable existing account login.
Pilot and admin browser sessions use separate HttpOnly cookies. The Node agent
uses `Authorization: Bearer <token>` during the WebSocket upgrade.

`VOXHF_RELAY_ALLOW_AGENT_QUERY_TOKEN=true` accepts older agents temporarily.
Disable it after every connected agent is current.

## Administration

Account-mode administration is at `/admin`. A separate
`VOXHF_RELAY_ADMIN_TOKEN` creates or recovers the owner; daily access uses the
owner password/session. Optional passkey MFA, recovery codes, user/invite/token
management, pairings, devices, sessions, and optional audit events are covered
in [Administration](../../docs/ADMINISTRATION.md).

## Data Boundary

SQLite stores account, hashed credential, pairing, device, session, legal
acceptance, and optional bounded audit records. Agents, live routing, pairing
codes, invites, and normal message/audio state are held in memory as needed.
Voice and chat history are never persisted by the relay.

The optional PC/proxy offline alert keeps sealed short-lived Push requests in
process memory only. They are already encrypted and signed by the local agent,
deleted before one-use delivery, and excluded from SQLite, logs, audits, and
backups.

See [Privacy Architecture](../../docs/PRIVACY.md) and the
[Threat Model](../../docs/THREAT_MODEL.md).

## Verification

```powershell
npm.cmd run verify
npm.cmd run remote:test
npm.cmd run relay:account:test
npm.cmd run relay:admin:test
npm.cmd run watchdog:test
npm.cmd run relay:backup:test
```

For an HTTPS deployment with passkeys:

```powershell
npm.cmd run relay:mfa:preflight -- https://relay.example.com
```

Database helpers, diagnostics, and the full test matrix are in
[Development](../../docs/DEVELOPMENT.md).
