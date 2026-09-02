# Self-Host VoxHF On A VPS

This guide starts with a fresh Ubuntu VPS and ends with a working landing site,
operational webapp, authenticated relay, admin account, pilot account, backup,
and connected Local agent.

The VPS never connects to IVAO. The local agent remains on the Altitude PC and
opens an outbound WSS connection to the relay.

```text
Browser or phone
       |
       | HTTPS + WSS (ports 443/80)
       v
Caddy on the VPS
  +-- landing site
  +-- operational webapp
  +-- authenticated relay
       ^
       | outbound WSS
       |
Local VoxHF agent on the Altitude PC
```

Never expose local ports `4827`, `6809`, `8767`, or `3000` to the internet.

## 1. Decide The Deployment Names

You need one domain and three DNS names. This guide uses:

| Purpose | Example |
| --- | --- |
| Public landing site | `example.com` |
| Operational app | `app.example.com` |
| Relay and admin API | `relay.example.com` |

You also need:

- an Ubuntu 22.04, 24.04, or 26.04 64-bit VPS with a public IP;
- root or `sudo` access;
- TCP ports 80 and 443 reachable;
- an email address for TLS certificate notices;
- enough space for Docker images, the SQLite volume, logs, and backups.

One small VPS is sufficient for a private or small-community deployment.

VoxHF supports two access models:

| Model | Use it for | Authentication |
| --- | --- | --- |
| Accounts | Multiple pilots or normal hosted use | Invite-only accounts, personal agent tokens, and browser sessions |
| Private token | One owner or a short private test | One shared relay token plus browser pairing |

Use **Accounts** unless the relay is strictly personal and temporary.

## 2. Create DNS Records

At the DNS provider, create `A` records for the base, `app`, and `relay` names
pointing to the VPS IPv4 address. Create matching `AAAA` records only if IPv6 is
configured and reachable on the VPS.

Example:

```text
example.com        A      203.0.113.10
app.example.com    A      203.0.113.10
relay.example.com  A      203.0.113.10
```

Wait until each name resolves to the VPS before starting Caddy:

```bash
getent hosts example.com
getent hosts app.example.com
getent hosts relay.example.com
```

Caddy obtains public TLS certificates automatically, so incorrect or
unpropagated DNS is the most common first-start failure.

## 3. Update The VPS And Configure The Firewall

Connect over SSH, then update the operating system:

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y ca-certificates curl git ufw
```

Allow the real SSH port before enabling UFW. If it is the default port:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

If SSH uses another port, allow that exact port instead of `OpenSSH`. The VoxHF
Compose file publishes only 80 and 443; the relay's internal port 8787 is not
published. Docker documents additional firewall behavior in
[Packet filtering and firewalls](https://docs.docker.com/engine/network/packet-filtering-firewalls/).

Reboot when the OS reports that one is required, then reconnect:

```bash
sudo reboot
```

## 4. Install Docker Engine And Compose

Use Docker's official Ubuntu repository. Remove conflicting distribution
packages first; this does not delete existing `/var/lib/docker` data:

```bash
sudo apt remove -y docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

Add the repository:

```bash
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
```

Install and verify Docker:

```bash
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
sudo docker compose version
```

These steps follow Docker's current
[Ubuntu installation guide](https://docs.docker.com/engine/install/ubuntu/).
Commands below omit `sudo` when run as root; otherwise prefix Docker and the
operator script with `sudo` as appropriate.

## 5. Download VoxHF

The recommended server installation is a Git checkout because the managed
update and rollback commands use Git history:

```bash
cd /opt
sudo git clone https://github.com/leledeste/voxhf.git
sudo chown -R "$(id -u):$(id -g)" /opt/voxhf
cd /opt/voxhf
chmod +x infra/docker/voxhf-server.sh
```

For a fixed release, check out its tag before configuration:

```bash
git fetch --tags
git checkout v0.1.2-beta.1
```

To receive normal fast-forward updates, remain on the `main` branch instead.
The published `voxhf-server-<version>.zip` contains the same server components,
but ZIP deployments cannot use the Git-based `update` and `rollback` commands;
replace them with a new extracted Server package and take an off-server backup
before every manual upgrade.

## 6. Generate The Private Server Configuration

Run the interactive wizard:

```bash
cd /opt/voxhf
infra/docker/voxhf-server.sh setup
```

Enter:

1. the base domain without `https://`, for example `example.com`;
2. the certificate email address;
3. **Accounts** or **Private token**.

The wizard derives the `app` and `relay` names, validates the inputs, generates
independent cryptographic secrets, and writes `infra/docker/.env` with private
permissions. It does not modify DNS, firewall rules, or start the services.

Store the token printed by the wizard in a password manager:

- account mode prints the admin bootstrap/break-glass token;
- private-token mode prints the shared relay token.

Do not put `.env`, tokens, databases, or backups in Git.

### Configuration Files

Docker loads two environment files:

- `infra/docker/defaults.env`: tracked safe defaults, updated with the source;
- `infra/docker/.env`: private domains, secrets, and deliberate overrides,
  loaded last.

Do not copy every default into `.env`. Add a value there only when it is secret
or intentionally overrides the standard behavior. For unattended setup, copy
`infra/docker/.env.example` to `.env`, replace every placeholder, and set mode
values manually.

## 7. Provide Deployment-Specific Legal Pages

Do this before allowing other people to register. The repository contains
neutral templates, not a privacy policy or terms written for your hosted
service.

```bash
cd /opt/voxhf
mkdir -p infra/docker/private/legal
cp webapp/privacy.html infra/docker/private/legal/privacy.html
cp webapp/terms.html infra/docker/private/legal/terms.html
```

Edit both copies to identify the operator, contact method, hosting providers,
data processing, retention, user rights, and applicable terms. Then add:

```env
VOXHF_LEGAL_PRIVACY_FILE=./private/legal/privacy.html
VOXHF_LEGAL_TERMS_FILE=./private/legal/terms.html
VOXHF_LEGAL_TERMS_VERSION=1.0
VOXHF_LEGAL_PRIVACY_VERSION=1.0
VOXHF_LEGAL_EFFECTIVE_DATE=2026-08-05
```

Increment the relevant version when users must accept a material change. The
private directory is ignored by Git and excluded from release packages; back
it up separately.

## 8. Validate And Start The Server

```bash
cd /opt/voxhf
infra/docker/voxhf-server.sh doctor
infra/docker/voxhf-server.sh start
```

`doctor` checks Docker, Compose, `.env`, placeholders, and Compose syntax. If
the relay is already running it also checks HTTPS health. `start` builds both
services, starts them, displays container state, and waits for relay health.

Open:

```text
https://example.com
https://app.example.com
https://relay.example.com/health
https://relay.example.com/admin
```

The health response must include `"ok": true` and service `voxhf-relay`.
Inspect failures with:

```bash
infra/docker/voxhf-server.sh logs
```

Direct Compose inspection is also available:

```bash
docker compose -f infra/docker/docker-compose.yml --env-file infra/docker/.env ps
docker compose -f infra/docker/docker-compose.yml --env-file infra/docker/.env logs --tail=100
```

## 9. Create The Owner And First Pilot (Account Mode)

The wizard configures SQLite authentication, invite-only registration, and a
separate admin token.

1. Open `https://relay.example.com/admin`.
2. Use the admin token once to create the owner username and password.
3. Sign in as that owner for normal administration.
4. Open **Access** and create a one-time registration invite.
5. Privately send the invite to the pilot.
6. Open `https://app.example.com/register` and create the pilot account.
7. Save the personal agent token shown once after registration.

Tokens and recovery codes are stored as hashes and cannot be displayed again.
The owner can rotate/revoke an agent token, disable/enable/delete a user,
revoke pairings and sessions, create password-recovery codes, and inspect audit
events when persistence is enabled.

The admin token is only for bootstrap and break-glass recovery. Daily admin
access uses an HttpOnly session cookie. Keep the token offline in a password
manager.

### Optional Admin Passkey MFA

Open **Admin > Security**, verify the owner password, and add a passkey. Save
the one-use recovery codes shown once. Passkeys are bound to the relay hostname,
so configure the final domain before enrollment.

Removing the last passkey disables MFA. Break-glass recovery resets the owner
password, revokes admin sessions, and clears MFA. VoxHF stores public WebAuthn
credential data and counters, never biometric data.

Run the automated preflight and then the real-device matrix in
[Admin MFA Validation](MFA_TESTING.md):

```powershell
npm.cmd run relay:mfa:preflight -- https://relay.example.com
```

## 10. Connect The Altitude PC

Install VoxHF Local on the simulator PC first. In its folder run:

```powershell
npm.cmd run setup -- agent
```

Enter:

```text
Relay URL: wss://relay.example.com
Agent token: the personal token from registration
Device name: Simulator PC
```

Restart `start.bat`. The console should report the remote agent connection.
Sign in at `https://app.example.com` from a trusted browser and select that
agent if more than one is online.

After all local agents are current, add this private override and restart to
reject legacy WebSocket query tokens:

```env
VOXHF_RELAY_ALLOW_AGENT_QUERY_TOKEN=false
```

Use the [Local Installation](INSTALL_LOCAL.md) and [User Guide](USER_GUIDE.md)
for pilot-side setup, notifications, and functional checks.

## Private-Token Mode

This mode has no hosted pilot accounts or account-based admin panel. Put the
same `VOXHF_RELAY_TOKEN` in the local agent and in the browser's **Settings >
Remote** manual setup. The browser must also enter the short-lived pairing code
printed by the selected local agent.

For multiple isolated env users:

```env
VOXHF_RELAY_USERS=user1=hex-token-1,user2=hex-token-2
```

Manage them without hand-editing the list:

```bash
npm run relay:user -- add user1 --env infra/docker/.env
npm run relay:user -- rotate user1 --env infra/docker/.env
npm run relay:user -- remove user1 --env infra/docker/.env
npm run relay:user -- list --env infra/docker/.env
infra/docker/voxhf-server.sh start
```

## Authentication Modes And Migration

| Mode | Credential source | Use |
| --- | --- | --- |
| `env` | `.env` token(s) | Private-token deployment |
| `sqlite-fallback` | SQLite plus `.env` tokens | Temporary migration from env tokens |
| `sqlite` | Active hashed SQLite agent tokens | Account deployment |

New account installations can start directly in `sqlite`. Use
`sqlite-fallback` only while migrating an existing env-token installation:

1. switch to `sqlite-fallback`;
2. create/import the SQLite user and test its new agent token;
3. switch to `sqlite`;
4. remove obsolete env user tokens and restart.

Prefer the admin panel for normal account operations. Database CLI helpers are
documented in [Development](DEVELOPMENT.md).

## Backups And Restore

Back up three things:

- `infra/docker/.env` and private legal pages;
- the relay SQLite data through the supported backup command;
- Caddy data only if preserving the current certificate state matters.

Create a consistent live SQLite backup:

```bash
cd /opt/voxhf
infra/docker/voxhf-server.sh backup
```

Backups and SHA-256 metadata go to `infra/docker/backups/` by default. They are
ignored by Git. Copy important backups off the VPS. Recognized backup files are
removed after 30 days by default; override `VOXHF_BACKUP_HOST_DIR` or
`VOXHF_BACKUP_RETENTION_DAYS` in private `.env` when your documented policy
requires it.

Restore a named backup:

```bash
infra/docker/voxhf-server.sh restore voxhf-manual-TIMESTAMP.db
```

The command stops only the relay, verifies integrity/checksum, preserves the
current database as a pre-restore copy, restores, restarts, and checks health.
Test restoration before relying on any backup plan.

## Update And Roll Back

Before every update, read [CHANGELOG.md](../CHANGELOG.md), create a provider
snapshot when appropriate, and keep an off-server backup.

For a clean Git checkout on `main`:

```bash
cd /opt/voxhf
infra/docker/voxhf-server.sh update
```

The command creates a pre-update database backup, performs a fast-forward pull,
rebuilds the stack, waits for health, and records the previous commit/backup.
It refuses to overwrite tracked local changes.

If the new deployment fails validation:

```bash
infra/docker/voxhf-server.sh rollback
```

Rollback intentionally restores both the previous source commit and its
pre-update database. Private `.env` values and Docker volumes are not stored in
Git. The first adoption of this workflow has no earlier rollback record, so use
the provider snapshot for that one upgrade.

For OS and Docker security updates:

```bash
sudo apt update
sudo apt full-upgrade -y
sudo reboot
```

After reconnecting:

```bash
cd /opt/voxhf
infra/docker/voxhf-server.sh doctor
docker compose -f infra/docker/docker-compose.yml --env-file infra/docker/.env ps
```

The services use `restart: unless-stopped` and should return automatically.

## Agent Version Policy

The relay package version is the recommended Local version by default. Set
`VOXHF_RELAY_RECOMMENDED_AGENT_VERSION` only to override that warning. Leave
`VOXHF_RELAY_MINIMUM_AGENT_VERSION` empty while older agents are compatible.

Set a minimum only for a protocol incompatibility or important security fix,
and only after the matching Local artifact is published. Agents below it are
rejected; recommended-only mismatches show a dismissible notice.

## Privacy And Operations Defaults

- Account/session/token records needed for authentication are stored in
  SQLite; audio and chat are not.
- Session IP/user-agent metadata is disabled unless
  `VOXHF_RELAY_STORE_SESSION_METADATA=true`.
- Persistent audit events are disabled unless
  `VOXHF_RELAY_PERSIST_AUDIT=true`; enabled audit rows default to seven-day
  retention and never include message/audio payloads.
- The optional PC/proxy offline alert keeps sealed short-lived Push requests in
  process memory only. They are already encrypted and signed by the local
  proxy and never enter SQLite, logs, audits, or backups.
- The local proxy, not the relay, stores Web Push credentials, subscriptions,
  chat history, and timer state.

See [Privacy Architecture](PRIVACY.md) for the complete data inventory.

## Security Checklist Before Inviting Users

- DNS and HTTPS work for all three domains.
- Only the real SSH port, 80, and 443 are exposed.
- SSH uses keys and the VPS is patched.
- `.env`, tokens, databases, private legal pages, and backups are not public.
- `VOXHF_ALLOWED_ORIGINS` contains only exact trusted HTTPS origins.
- Registration is invite-only, or disabled when unused.
- Every supported local agent uses header authentication and legacy query-token
  compatibility is disabled.
- Deployment-specific Terms and Privacy pages are published.
- Backup and restore have both been tested and an off-server copy exists.
- Admin and pilot recovery procedures have been tested.
- Notifications, chat recovery, RX, and TX have been tested from every device
  class the deployment supports.
- No local VoxHF port is forwarded from the simulator PC.

See [Security Policy](../SECURITY.md) and the [Threat Model](THREAT_MODEL.md).

## Server Troubleshooting

| Symptom | Check |
| --- | --- |
| `doctor` reports placeholders | Edit `infra/docker/.env` and replace every example value. |
| TLS certificate fails | Confirm all DNS records resolve to the VPS and ports 80/443 are reachable. |
| `Permission denied` on the operator script | Run `chmod +x infra/docker/voxhf-server.sh`. |
| Relay health is unavailable | Run `infra/docker/voxhf-server.sh logs` and inspect Caddy/relay container state. |
| Browser WebSocket is rejected | Check the exact app origin in `VOXHF_ALLOWED_ORIGINS`, account/token state, and server clock. |
| Agent is rejected after token rotation | Update `config.json` on the simulator PC and restart the local agent. |
| Account registration is unavailable | Confirm SQLite auth and `VOXHF_RELAY_ENABLE_REGISTRATION=true`; invite-only registration also needs a fresh admin invite. |
| Passkey fails after a domain change | Passkeys are RP-ID/domain-bound; restore the original domain or enroll a new passkey through break-glass recovery. |
| Update refuses a dirty checkout | Preserve/commit intentional changes or deploy a clean release; never force the managed update over unknown edits. |
| Restore file is not found | Use the exact filename shown in the configured backup directory. |
