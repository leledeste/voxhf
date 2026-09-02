# Relay Administration Reference

This document describes the current account-mode admin surface. Installation,
domains, and daily server commands are in [Self-Hosting](SELF_HOSTING.md).

## Identity Boundary

Pilot and administrator identities are separate even though they use one
SQLite database:

- pilot accounts authenticate the operational webapp and control only their
  own agents, pairings, and browser sessions;
- the owner account authenticates `/admin` and manages relay users and access;
- an agent token authenticates one relay user and never grants administration;
- `VOXHF_RELAY_ADMIN_TOKEN` is only a bootstrap/break-glass credential.

Every admin API authorizes the server-side owner session. Hiding or showing an
action in the browser does not grant permission.

## First Owner And Recovery

On a new SQLite/account deployment, open `/admin` and use the configured admin
token to create the first owner. Daily access then uses the owner username,
password, and an HttpOnly server-side session.

Keep the token in a password manager. Break-glass recovery uses it to reset the
owner password, revoke existing admin sessions, and clear passkey MFA so a lost
authenticator cannot permanently lock out the deployment.

## Admin Areas

- **Overview**: health, version, counts, connected agents, and warnings.
- **Users**: create, disable, enable, delete, rotate/revoke agent tokens, and
  create one-use password-recovery codes.
- **Access**: one-use registration invites and browser pairings.
- **Devices**: known local agents and online state.
- **Sessions**: owner sessions with individual or other-session revocation.
- **Security**: password, passkeys, and recovery codes.
- **System**: auth mode, database, origin, privacy, and version information.
- **Audit**: bounded events when persistence is enabled.

Tokens, invites, password-recovery codes, and MFA recovery codes are displayed
only at creation. Store or deliver them securely; the server keeps hashes where
persistence is required.

## Owner Sessions And Passwords

Admin sessions use an opaque cookie with `HttpOnly`, `SameSite=Strict`, an
admin path, and `Secure` over HTTPS. SQLite stores only a hash of the token plus
creation, activity, expiry, and revocation timestamps. Default limits are 12
hours absolute and 30 minutes idle.

Normal password changes require the current password. Authentication and
recovery attempts are rate-limited in memory for the supported single-process
relay model.

## Optional Passkey MFA

Adding the first passkey enables MFA for the owner; removing the last disables
it. VoxHF stores the credential public key, counter, name, and timestamps, not
Face ID, Touch ID, Windows Hello, or other biometric data.

Recovery codes are random, one-use, shown once, and stored as hashes. A passkey
is bound to the final relay hostname/RP ID. Validate it with
[Admin MFA Validation](MFA_TESTING.md) before depending on it.

## Privacy And Audit

IP/user-agent session metadata is stored only when
`VOXHF_RELAY_STORE_SESSION_METADATA=true`. Persistent audit events are stored
only when `VOXHF_RELAY_PERSIST_AUDIT=true` and follow the configured retention.

Audit events never contain passwords, full tokens/cookies, codes, chat text,
voice, raw FSD/TS2, or Push endpoints. See [Privacy Architecture](PRIVACY.md).

## Recovery Checklist

Before opening a deployment to other users, verify:

1. owner password login and logout;
2. admin session listing/revocation;
3. break-glass owner recovery using the stored admin token;
4. invite creation and pilot registration;
5. pilot password recovery and session revocation;
6. agent-token rotation followed by Local-agent reconnection;
7. optional passkey login and one-use recovery code;
8. database backup and restore.
