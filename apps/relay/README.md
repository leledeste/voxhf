# VoxHF Relay

The relay connects one local VoxHF agent to trusted remote browsers. It routes
validated state, commands, and live audio; it does not connect to IVAO itself.

For full VPS instructions see
[Self-Hosting](../../docs/SELF_HOSTING.md). For tests and database helpers see
[Development](../../docs/DEVELOPMENT.md).

## Run Locally

```powershell
Copy-Item apps\relay\.env.example apps\relay\.env
npm.cmd run relay:env
```

Set a real token in `apps/relay/.env` before starting:

```env
VOXHF_RELAY_HOST=127.0.0.1
VOXHF_RELAY_PORT=8787
VOXHF_RELAY_TOKEN=hex-token-from-openssl-rand-hex-32
VOXHF_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
VOXHF_RELAY_REQUIRE_PAIRING=true
VOXHF_RELAY_AUTH_MODE=env
```

For a full VPS deployment, the recommended path is:

```bash
docker run --rm -it -v "$PWD:/work" -w /work node:20-alpine node scripts/setup.js server
```

It generates `infra/docker/.env`; this development `.env` remains useful for
running the relay directly without Docker. When Node.js is already installed
on the host, `npm run setup -- server` is equivalent.

Docker deployments load safe, Git-tracked values from
`infra/docker/defaults.env`, then private values from `infra/docker/.env`.
The private file wins, so normal updates receive new defaults without replacing
domains or secrets. Direct non-Docker development continues to use
`apps/relay/.env.example` as the complete reference.

Health:

```text
http://127.0.0.1:8787/health
```

WebSocket sources are restricted to `agent` and `browser`. Unknown
message types, raw proxy commands, invalid origins, invalid tokens, and
unauthorized device access are rejected.

## Authentication

| Mode | Token source | Use |
| --- | --- | --- |
| `env` | `VOXHF_RELAY_TOKEN` and `VOXHF_RELAY_USERS` | Small private relay. |
| `sqlite-fallback` | SQLite plus env tokens | Short migration/test period. |
| `sqlite` | Active SQLite agent tokens | Stable multi-user relay. |

Browsers on a self-hosted instance can register/login when SQLite auth is active and
`VOXHF_RELAY_ENABLE_REGISTRATION=true`. Browser sessions use an HttpOnly
cookie. Registration requires a one-time in-memory admin invite by default;
agent tokens are shown once and stored hashed.

The public repository ships neutral legal templates. Before opening
registration to other people, provide deployment-specific Terms and Privacy
pages and set `VOXHF_LEGAL_TERMS_VERSION` and
`VOXHF_LEGAL_PRIVACY_VERSION`. Docker operators can mount private pages with
`VOXHF_LEGAL_TERMS_FILE` and `VOXHF_LEGAL_PRIVACY_FILE`; those files do not
belong in the source repository.

The Node agent sends its token in the WebSocket upgrade `Authorization` header.
`VOXHF_RELAY_ALLOW_AGENT_QUERY_TOKEN=true` temporarily accepts older agents;
set it to `false` after every agent has been updated.

Logged-in pilots can list and revoke browser sessions, log out other devices,
and change their password from the webapp settings. If a password is lost, the
owner creates a one-use recovery code from the Users page; codes expire after
`VOXHF_RELAY_ACCOUNT_RECOVERY_TTL_MS` and are stored only as hashes.

Manual token browsers use short-lived pairing codes. Pairing records are stored
in JSON for env mode and SQLite for SQLite modes.

## Admin

Set a separate `VOXHF_RELAY_ADMIN_TOKEN` and open:

```text
https://relay.example.com/admin
```

On the first visit, use that token once to create the owner account. Later
visits use the owner username and password through a short-lived HttpOnly admin
session. The token remains available for break-glass password recovery and must
stay in a password manager.

The owner may optionally enable passkey MFA from **Security**. MFA is never
forced by the relay: accounts without a passkey continue to use password login.
When enabled, a passkey or one-use recovery code completes login. Recovery
codes are shown once and stored only as hashes. Break-glass recovery resets the
password, revokes admin sessions, and removes MFA so a lost authenticator cannot
lock the owner out permanently.

The panel manages registration invites, users, agent tokens, devices, pairings,
admin sessions, password changes, and optional audit events. Account-based
administration is disabled in `env` mode.

## Live Data

The relay keeps agents and live audio routing in memory. SQLite stores the
account, hashed token, pairing, session, and device records needed for access.
Voice audio and chat history are never persisted. IP/user-agent session
metadata and audit history are opt-in and disabled by default.

The relay checks backup storage at startup and once per day. Recognized SQLite
backups, their checksum metadata, and pre-restore database copies are removed
after `VOXHF_BACKUP_RETENTION_DAYS` (30 days by default). Unrelated files are
never selected by this cleanup.

## Tests

```powershell
npm.cmd run verify
npm.cmd run remote:test
npm.cmd run remote:check
npm.cmd run relay:mfa:preflight -- https://relay.example.com
```

## Important Environment Variables

- `VOXHF_ALLOWED_ORIGINS`
- `VOXHF_RELAY_AUTH_MODE`
- `VOXHF_RELAY_DATABASE`
- `VOXHF_RELAY_ADMIN_TOKEN`
- `VOXHF_RELAY_ADMIN_SESSION_TTL_MS`
- `VOXHF_RELAY_ADMIN_SESSION_IDLE_TTL_MS`
- `VOXHF_RELAY_ADMIN_MFA_CHALLENGE_TTL_MS`
- `VOXHF_RELAY_ACCOUNT_RECOVERY_TTL_MS`
- `VOXHF_RELAY_ALLOW_AGENT_QUERY_TOKEN`
- `VOXHF_RELAY_WEBAUTHN_RP_ID` (optional; defaults to the admin origin host)
- `VOXHF_RELAY_WEBAUTHN_RP_NAME`
- `VOXHF_RELAY_ENABLE_REGISTRATION`
- `VOXHF_RELAY_REQUIRE_REGISTRATION_INVITE`
- `VOXHF_LEGAL_TERMS_VERSION`
- `VOXHF_LEGAL_PRIVACY_VERSION`
- `VOXHF_LEGAL_EFFECTIVE_DATE`
- `VOXHF_RELAY_STORE_SESSION_METADATA`
- `VOXHF_RELAY_PERSIST_AUDIT`
- `VOXHF_RELAY_AUDIT_RETENTION_DAYS`
- `VOXHF_RELAY_REQUIRE_PAIRING`
- `VOXHF_RELAY_DATA_DIR`
- `VOXHF_BACKUP_DIR`
- `VOXHF_BACKUP_RETENTION_DAYS`
- `VOXHF_RELAY_MAX_CLIENTS`
- `VOXHF_RELAY_MAX_MESSAGES_PER_WINDOW`
- `VOXHF_RELAY_MAX_COMMANDS_PER_WINDOW`
- `VOXHF_RELAY_MAX_AUTH_ATTEMPTS_PER_WINDOW`
- `VOXHF_RELAY_MAX_ADMIN_ATTEMPTS_PER_WINDOW`
- `VOXHF_RELAY_MAX_AUDIO_FRAME_BYTES`
- `VOXHF_RELAY_MAX_REMOTE_TX_DURATION_MS`

Use `apps/relay/.env.example` as the complete reference.
