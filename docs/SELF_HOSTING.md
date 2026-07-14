# Self-Hosting VoxHF

VoxHF can serve its webapp and relay from one VPS. The local agent stays on the
Altitude PC and creates an outbound WSS connection. Never expose the local
PilotUI/PilotCore, FSD, TS2, or webapp ports to the internet.

```text
Browser / phone
      |
      | HTTPS + WSS
      v
Caddy on VPS
  +-- static VoxHF webapp
  +-- VoxHF relay
      ^
      | outbound WSS
      |
VoxHF agent on Altitude PC
```

## Requirements

- One VPS with a public IPv4 or IPv6 address.
- Docker Engine and Docker Compose.
- A base domain plus `app` and `relay` names, for example `example.com`,
  `app.example.com`, and `relay.example.com`.
- DNS records pointing all three names to the VPS.
- TCP ports `80` and `443` open.
- A separate email address for Caddy certificate notices.
- A current VoxHF checkout.

One VPS is enough for a private or small community deployment.

## Install Docker

On Ubuntu/Debian, install Docker from the official Docker repository or your
distribution packages. A typical distribution-package installation is:

```bash
apt update
apt install -y docker.io docker-compose-v2 git curl ufw
systemctl enable --now docker
```

Some releases name the Compose package `docker-compose-plugin`; use Docker's
official repository when neither package is available. Confirm:

```bash
docker --version
docker compose version
```

If `docker compose` is unavailable, install the Docker Compose plugin before
continuing. The old `docker-compose` command is not used by this project.

Allow the real SSH port before enabling the firewall, then expose only HTTP and
HTTPS for VoxHF:

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status
```

## Prepare VoxHF

```bash
cd /opt
git clone https://github.com/leledeste/voxhf.git
cd /opt/voxhf
chmod +x infra/docker/voxhf-server.sh
infra/docker/voxhf-server.sh setup
```

The wizard asks for one base domain and derives the landing, app, and relay
hosts. It also validates the certificate email, generates cryptographic tokens,
uses the versioned privacy-first defaults, and creates the Git-ignored
`infra/docker/.env` with owner-only file permissions.

Choose one access model:

| Model | Best for | Authentication |
| --- | --- | --- |
| Private token | One owner, quickest setup | One generated token plus browser pairing. |
| Accounts | Families or small communities | SQLite accounts and invite-only registration. |

The wizard prints generated secrets once. Store them in a password manager.
It does not change DNS, firewall rules, or start Docker.

If Node.js 20+ is already installed directly on the VPS, the shorter equivalent
is `npm run setup -- server`.

## Manual Configuration

Skip this section when you used `npm run setup -- server`. For an unattended or
custom deployment, copy the private template and edit it directly:

```bash
cp infra/docker/.env.example infra/docker/.env
chmod 600 infra/docker/.env
```

Generate independent relay and admin tokens when the selected mode needs them:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Important account-mode values:

```env
LANDING_DOMAIN=example.com
WEBAPP_DOMAIN=app.example.com
RELAY_DOMAIN=relay.example.com
CADDY_ACME_EMAIL=you@example.com

VOXHF_ALLOWED_ORIGINS=https://app.example.com,https://relay.example.com
VOXHF_RELAY_TOKEN=
VOXHF_RELAY_ADMIN_TOKEN=replace-with-admin-hex-token

VOXHF_RELAY_AUTH_MODE=sqlite
VOXHF_RELAY_ENABLE_REGISTRATION=true
```

Account mode creates a separate personal agent token for every registered user,
so it does not need `VOXHF_RELAY_TOKEN`. In private-token mode use
`VOXHF_RELAY_AUTH_MODE=env`, keep registration off, and configure
`VOXHF_RELAY_TOKEN`. Never reuse the relay token as the admin token.

Docker loads configuration from two files:

- `infra/docker/defaults.env` contains safe operational defaults. It is tracked
  by Git and updates automatically with `git pull`.
- `infra/docker/.env` contains domains, origins, tokens, and deployment choices.
  It is private, ignored by Git, and loaded last so its values override the
  tracked defaults.

You do not need to copy new default keys into `.env` after an update. Add a key
from `defaults.env` to `.env` only when deliberately overriding it. Existing
deployments may keep old overrides in `.env`; no migration is required.

## Start

```bash
cd /opt/voxhf
chmod +x infra/docker/voxhf-server.sh
infra/docker/voxhf-server.sh doctor
infra/docker/voxhf-server.sh start
```

The operator script runs the same Compose deployment, waits for the HTTPS relay
health endpoint, and keeps every path consistent. Direct Compose commands remain
available for troubleshooting:

```bash
docker compose -f infra/docker/docker-compose.yml --env-file infra/docker/.env ps
docker compose -f infra/docker/docker-compose.yml --env-file infra/docker/.env logs --tail=100
```

Check endpoints:

```text
https://app.example.com
https://relay.example.com/health
https://relay.example.com/admin
```

The base domain serves the public landing page. The app domain serves the
operational interface, with `/login` and `/register` for account mode. The local
proxy maps its own root directly to the operational interface.

Health should report `ok: true` and service `voxhf-relay`.

## Authentication Modes

| Mode | Source | Recommended Use |
| --- | --- | --- |
| `env` | `VOXHF_RELAY_TOKEN` and `VOXHF_RELAY_USERS` | First private test or one owner. |
| `sqlite-fallback` | SQLite plus env tokens | Verify database auth without locking out the agent. |
| `sqlite` | Active SQLite agent tokens only | Stable multi-user deployment. |

For a manually migrated deployment:

1. Start with `sqlite-fallback` only when migrating existing env tokens.
2. Register the first account or create a SQLite user.
3. Confirm its agent token works from the Altitude PC.
4. Switch to `sqlite`.
5. Remove unused env user tokens and restart.

New account-mode installations can start directly in `sqlite`; the admin token
creates the first owner account and the owner then creates registration invites.
SQLite is optional for a simple private relay, but required for accounts and
the admin panel.

## Deployment-Specific Legal Pages

The public packages contain neutral Terms and Privacy templates, not the VoxHF
project operator's hosted-service documents. Before enabling registration for
other people, copy and edit both templates:

```bash
mkdir -p infra/docker/private/legal
cp webapp/privacy.html infra/docker/private/legal/privacy.html
cp webapp/terms.html infra/docker/private/legal/terms.html
```

Identify the actual server operator, contact, providers, data handling,
retention and terms that apply to the deployment. Then add these private
overrides to `infra/docker/.env`:

```env
VOXHF_LEGAL_PRIVACY_FILE=./private/legal/privacy.html
VOXHF_LEGAL_TERMS_FILE=./private/legal/terms.html
VOXHF_LEGAL_TERMS_VERSION=1.0
VOXHF_LEGAL_PRIVACY_VERSION=1.0
VOXHF_LEGAL_EFFECTIVE_DATE=2026-07-15
```

The `infra/docker/private/` directory is ignored by Git, excluded from Docker
build context and rejected by the release packager. Back it up separately.
Increment the corresponding version whenever users must accept a materially
updated document.

## Self-Hosted Accounts

With:

```env
VOXHF_RELAY_AUTH_MODE=sqlite
VOXHF_RELAY_ENABLE_REGISTRATION=true
VOXHF_RELAY_REQUIRE_REGISTRATION_INVITE=true
```

the self-hosted webapp shows Login/Register, but registration needs a one-time
code.

1. Open `/admin` and create the owner account with `VOXHF_RELAY_ADMIN_TOKEN`.
2. Open Access and choose `Create Invite`.
3. Privately share the code; it is held only in memory, expires, and works once.
4. Register the account with that code.
5. Save the one-time agent token.
6. Put it in the local agent `config.json` and restart the agent.
7. Log in from trusted browsers.

Tokens are stored hashed and cannot be recovered. If one is lost, rotate it
from the admin panel and replace it in `config.json`.

The local Node agent now sends this token through the WebSocket upgrade
`Authorization` header. During the transition, older agents can be accepted
with `VOXHF_RELAY_ALLOW_AGENT_QUERY_TOKEN=true`. Set it to `false` after all
Altitude PCs using the relay have been updated.

Pilots can manage active browser sessions and change their password from the
webapp Remote settings. For a forgotten password, the owner selects **Reset
password** beside the user in `/admin` and shares the code privately. The code
is shown once, expires after 30 minutes by default, and is consumed by the
**Recover** tab on the login page. Recovery revokes older browser sessions but
does not rotate the agent token.

Set `VOXHF_RELAY_REQUIRE_REGISTRATION_INVITE=false` only when deliberately
operating an open-registration relay.

## Admin Panel

Open `https://relay.example.com/admin`. On a new installation, use
`VOXHF_RELAY_ADMIN_TOKEN` once to create the owner account. Sign in with the
owner username and password after that.

The panel can:

- create, disable, enable, and delete users;
- rotate or revoke agent tokens;
- list agents and browser pairings;
- revoke pairings;
- inspect recent audit events.
- generate one-time registration invites.
- change the owner password;
- list and revoke admin sessions.
- optionally protect owner login with passkeys and one-use recovery codes.

Passkey MFA is opt-in. Open **Security**, enter the current owner password, and
add a passkey. Save the recovery codes shown once. The passkey is bound to the
relay admin hostname, so configure the final domain before enrollment. By
default the RP ID is derived from that hostname; an installation that needs an
explicit value can set `VOXHF_RELAY_WEBAUTHN_RP_ID=relay.example.com`.

Removing the last passkey disables MFA and leaves password login active. The
break-glass admin token also clears MFA during owner recovery. VoxHF stores the
credential public key and usage counter, never Face ID, Touch ID, Windows Hello,
or other biometric data.

After deployment, run the automated MFA preflight and then the real-device
matrix in [MFA Testing](MFA_TESTING.md):

```powershell
npm.cmd run relay:mfa:preflight -- https://relay.example.com
```

Audit persistence and session IP/user-agent metadata are disabled by default.
Operators can enable them with `VOXHF_RELAY_PERSIST_AUDIT=true` and
`VOXHF_RELAY_STORE_SESSION_METADATA=true`. Audit rows older than
`VOXHF_RELAY_AUDIT_RETENTION_DAYS` are removed automatically; disabling audit
persistence removes existing audit rows during maintenance.

The admin token is separate from normal account and agent credentials. It is a
bootstrap and break-glass recovery secret, not the daily login. Keep it in a
password manager.

## Local Agent

On the Altitude PC, update `config.json`:

```json
{
  "remoteAgentEnabled": true,
  "remoteRelayUrl": "wss://relay.example.com",
  "remoteRelayToken": "account-agent-token",
  "remoteDeviceId": "my-simulator-pc",
  "remoteDeviceName": "Simulator PC"
}
```

Update these fields inside the existing file and preserve its other settings.
Keep `remoteDeviceId` stable after pairing; `remoteDeviceName` is the friendly
label displayed to the user.

Start VoxHF normally. The console should report the remote agent connection.
Logged-in browsers for that account will see the agent.

Alternatively, generate the same configuration interactively:

```powershell
npm.cmd run setup -- agent
```

## Manual Token Mode

For a small private relay without accounts, use the same
`VOXHF_RELAY_TOKEN` in the agent and browser Remote settings. Manual-token
browsers also require the short-lived pairing code printed by the local agent.

Multiple independent env users can be configured with:

```env
VOXHF_RELAY_USERS=user1=hex-token-1,user2=hex-token-2
```

The helper avoids manual editing:

```bash
npm run relay:user -- add user1 --env infra/docker/.env
npm run relay:user -- rotate user1 --env infra/docker/.env
npm run relay:user -- remove user1 --env infra/docker/.env
npm run relay:user -- list --env infra/docker/.env
```

Restart the relay after env token changes.

## SQLite Helpers

Inside a source checkout:

```bash
npm run relay:db:user -- list --db /var/lib/voxhf-relay/voxhf.db
npm run relay:db:user -- add user1 --db /var/lib/voxhf-relay/voxhf.db
npm run relay:db:user -- rotate user1 --db /var/lib/voxhf-relay/voxhf.db
npm run relay:db:user -- revoke user1 --db /var/lib/voxhf-relay/voxhf.db
npm run relay:db:user -- disable user1 --db /var/lib/voxhf-relay/voxhf.db
npm run relay:db:user -- enable user1 --db /var/lib/voxhf-relay/voxhf.db
npm run relay:db:user -- delete user1 --db /var/lib/voxhf-relay/voxhf.db
```

The Docker database lives in the named relay volume. Prefer the admin panel for
normal operations and use the CLI only where the database path is mounted.

## Optional Public Directory

A self-hosted server is private by default and never appears in the public
directory automatically. Listing is an explicit agreement between the server
operator and the VoxHF directory administrator.

The directory administrator creates the public identity and a dedicated
heartbeat token. The operator then adds only these values to the private
`infra/docker/.env`:

```env
VOXHF_DIRECTORY_PUBLISH=true
VOXHF_DIRECTORY_HEARTBEAT_URL=https://voxhf.com/directory/api/heartbeat
VOXHF_DIRECTORY_HEARTBEAT_TOKEN=replace-with-issued-hex-token
```

Restart the relay after changing `.env`. The heartbeat publishes the running
VoxHF version and whether registration is open. It does not publish user
counts, account details, messages, radio state, audio, or IVAO traffic.

The public listing is self-declared. A recent heartbeat proves only that the
listed relay contacted the directory; it is not a security, privacy, source,
or uptime certification. Operators must provide accurate operator, privacy,
and source information and keep it current.

### Central Registry Administration

Only the central directory host should set:

```env
VOXHF_DIRECTORY_REGISTRY_ENABLED=true
```

On the Docker host, create a listing in the live registry database with:

```bash
docker compose -f infra/docker/docker-compose.yml --env-file infra/docker/.env \
  exec voxhf-relay node scripts/directory-server.js add community-eu \
  --name "Community EU" \
  --operator "Example operator" \
  --region "Europe" \
  --access invite \
  --app https://app.example.com \
  --relay https://relay.example.com \
  --privacy https://example.com/privacy \
  --source https://github.com/example/voxhf
```

During local development, the equivalent command is
`npm run directory:server -- add ...`.

The generated heartbeat token is shown once. Send it privately to the
operator. Use `rotate`, `disable`, `maintenance-on`, or `delete` from the same
CLI when the listing changes.

The `--official` flag is reserved for a server operated by the VoxHF project.
An official listing is sorted first and labelled **VoxHF operated**. A server
cannot claim that status through its heartbeat.

## Backup

Back up:

- `infra/docker/.env`;
- the relay Docker volume containing `voxhf.db`;
- Caddy data if preserving certificates matters.

`infra/docker/defaults.env` does not need a separate backup because Git restores
it. Never put secrets in that tracked file.

Create a consistent online SQLite backup:

```bash
infra/docker/voxhf-server.sh backup
```

By default, files and SHA-256 metadata are written to
`infra/docker/backups/`, outside the database volume and ignored by Git. Set
`VOXHF_BACKUP_HOST_DIR` in the private `.env` to use another host directory.
The relay removes recognized backups, metadata, and pre-restore database copies
after 30 days during daily maintenance. Override
`VOXHF_BACKUP_RETENTION_DAYS` in the private `.env` only when a different
retention period is required. This cleanup does not select unrelated files.

Verify or restore a named backup:

```bash
docker compose -f infra/docker/docker-compose.yml --env-file infra/docker/.env \
  exec -T voxhf-relay node scripts/relay-backup.js verify \
  /var/backups/voxhf/voxhf-manual-TIMESTAMP.db

infra/docker/voxhf-server.sh restore voxhf-manual-TIMESTAMP.db
```

Restore stops only the relay, validates integrity/checksum, preserves the
current database as a pre-restore file, restores, and waits for health. Test
restoration before depending on any backup strategy. Back up `.env` separately;
database backups intentionally do not contain deployment secrets.

## Update

When adopting this operator script on an existing VPS for the first time,
create a provider snapshot and an off-server SQLite backup, pull the release
manually, then run `doctor` and `start`. That bootstrap has no earlier
`.voxhf-previous-release` record, so provider recovery is the rollback path for
that one deployment. All later upgrades can use the managed command below.

```bash
cd /opt/voxhf
infra/docker/voxhf-server.sh update
```

The command requires a clean Git checkout. It creates a pre-update database
backup, performs a fast-forward pull, rebuilds the stack, waits for health, and
records the previous commit and matching backup. If validation fails:

```bash
infra/docker/voxhf-server.sh rollback
```

Rollback is explicit because it resets tracked source files and restores the
pre-update database. The database is restored before the previous image is
rebuilt, so rollback also works when the older release did not include the
backup helper. Private `.env` values and Docker volumes are not stored in Git.
Read [CHANGELOG.md](../CHANGELOG.md) before updating and retain off-server
copies of important backups.

Useful daily commands:

```bash
infra/docker/voxhf-server.sh doctor
infra/docker/voxhf-server.sh logs
```

### Agent Version Policy

The relay advertises its own version as the recommended Local version by
default. `VOXHF_RELAY_RECOMMENDED_AGENT_VERSION` can override that warning.
Leave `VOXHF_RELAY_MINIMUM_AGENT_VERSION` empty while older agents remain
compatible. Set a minimum only for an incompatible protocol or important
security update and only after the matching Local artifact is published.

An agent below the configured minimum receives `agent-update-required`, is not
registered as an online device, and stops its reconnect loop until VoxHF is
updated and restarted. Recommended-only mismatches show a dismissible update
notice without interrupting a flight.

## Security Checklist

- Keep `VOXHF_ALLOWED_ORIGINS` limited to exact HTTPS origins.
- Use unique 32-byte hex tokens.
- Keep invite-only registration enabled; disable registration entirely when it
  is not needed.
- Restrict SSH, use key authentication, and keep the VPS updated.
- Expose only `80`, `443`, and the required SSH source range.
- Never publish `.env`, `config.json`, database files, or logs with tokens.
- Review admin/audit events and revoke lost browser sessions or agent tokens.
- Keep local VoxHF proxy ports private.
- Do not add voice recording or chat persistence without a separate privacy
  design and user consent.

See [Security](../SECURITY.md), [Privacy](PRIVACY.md), and
[Threat Model](THREAT_MODEL.md).
