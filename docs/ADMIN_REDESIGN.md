# VoxHF Administration Redesign

Status: implemented baseline for the beta relay administration surface.

## Goals

The administration surface must be easier to use than a pasted bearer token
without weakening the relay trust boundary. It must remain suitable for a
single-owner private relay, while leaving a clear path to additional
administrators and MFA.

The redesign has five goals:

1. Use a normal owner login for daily administration.
2. Keep administration identities and sessions separate from pilot accounts.
3. Make destructive actions explicit, auditable, and easy to understand.
4. Keep small self-hosted installations simple: one Node process and one SQLite
   database remain enough.
5. Remove long-lived credentials from browser storage and WebSocket URLs.

## Trust Boundaries

VoxHF uses one SQLite database but two independent identity domains:

- Pilot accounts authenticate the hosted webapp and control their own agent.
- Admin accounts manage users, access, sessions, and relay configuration.

An authenticated pilot never becomes an administrator by gaining a role in
browser state. Admin APIs accept only an admin session or the explicitly scoped
break-glass token.

The local proxy and the relay remain separate trust domains. An agent token
authenticates one relay user; it does not grant administration access.

## Bootstrap And Recovery

`VOXHF_RELAY_ADMIN_TOKEN` becomes a bootstrap and break-glass credential:

- A new installation uses it once to create the first owner account.
- Daily access uses the owner username and password, with optional MFA.
- It can recover an owner who lost access, but recovery revokes existing admin
  sessions and is written to the audit log.
- It is never saved in browser local storage or session storage.

The CLI will provide the same bootstrap/recovery operations for installations
that do not expose the admin page publicly.

## Authentication

### Passwords

Passwords use the existing Node.js `scrypt` format with an independent random
salt. Password changes require the current password. Break-glass recovery does
not require the old password, but does require the configured admin token.

### Sessions

Admin sessions are server-side SQLite records. The browser receives only a
random opaque token in a cookie with these properties:

- `HttpOnly`
- `Secure` when HTTPS is used
- `SameSite=Strict`
- `Path=/admin`
- bounded idle and absolute expiry

The server stores only a SHA-256 hash of the random session token. Login,
password changes, MFA changes, recovery, and logout update or revoke sessions.

The session page lists creation time, last activity, expiry, and an optional
device label. IP address and user-agent storage continue to follow the relay's
privacy metadata setting.

### MFA

WebAuthn/passkeys are the optional second factor. The relay stores public
credentials, counters, names, and timestamps, not biometric data. User
verification is required for admin authentication.

Adding the first passkey opts the account into MFA; removing the last passkey
opts it out. VoxHF does not provide a setting that forces enrollment. Recovery
codes are random, one-use, shown once, and stored as hashes. Break-glass owner
recovery clears MFA as well as resetting the password and revoking sessions.

## Authorization

The first implementation has one `owner` role. The database keeps a role field
so a future `operator` role can be introduced without changing the session
format. Every admin API checks authorization on the server; the UI only reflects
those decisions.

Sensitive actions require recent password or MFA verification:

- deleting a user;
- rotating or revoking agent credentials;
- disabling MFA;
- changing another administrator;
- using recovery operations.

## Information Architecture

The admin page is an operational tool with a persistent side navigation:

- **Overview**: relay health, version, account counts, connected agents, and
  security warnings.
- **Users**: account status, creation and recent activity, with a focused user
  detail view.
- **Access**: registration invites, agent tokens, and browser pairings.
- **Devices**: known agents and their online state.
- **Sessions**: admin and pilot browser sessions with individual revocation.
- **Security**: passkeys, recovery codes, authentication events, and security
  configuration.
- **System**: auth mode, database, origins, privacy controls, and update state.
- **Audit**: structured administrative and security events when persistence is
  enabled.

Actions such as disable, delete, rotate, and revoke belong to the relevant
detail view or action menu. Tokens and invite codes are displayed once when
created.

## HTTP Contract

Unauthenticated endpoints:

- `GET /admin/api/auth/status`
- `POST /admin/api/auth/login`
- `POST /admin/api/auth/bootstrap`
- `POST /admin/api/auth/recover`
- `POST /admin/api/auth/mfa/passkey`
- `POST /admin/api/auth/mfa/recovery`

Session endpoints:

- `GET /admin/api/auth/me`
- `POST /admin/api/auth/logout`
- `POST /admin/api/auth/password`
- `GET /admin/api/sessions`
- `POST /admin/api/sessions/:id/revoke`
- `POST /admin/api/sessions/revoke-others`
- `GET /admin/api/mfa`
- `POST /admin/api/mfa/passkeys/options`
- `POST /admin/api/mfa/passkeys/complete`
- `POST /admin/api/mfa/passkeys/:id/remove`
- `POST /admin/api/mfa/recovery-codes/regenerate`
- `POST /admin/api/mfa/disable`

Existing user, device, pairing, invite, and audit endpoints remain under
`/admin/api/`. During migration they accept either an admin session or the
break-glass bearer token. The browser UI uses sessions only.

All state-changing requests require `application/json`. Browser requests with
an explicit untrusted `Origin` are rejected before authentication.

## Database Model

The first migration adds:

```text
admin_accounts
  id
  username
  display_name
  password_hash
  role
  created_at
  password_changed_at
  last_login_at
  disabled_at

admin_sessions
  id
  admin_id
  session_hash
  created_at
  last_seen_at
  expires_at
  revoked_at
  ip_address
  user_agent
```

The WebAuthn migration adds `admin_passkeys`, `admin_mfa_challenges`, and
`admin_recovery_codes`. Challenges are short-lived, bound to their purpose and
origin, consumed atomically, and never reused.

## Rate Limiting

Per-IP login and recovery throttles remain in memory for the single-process
deployment. This is intentionally sufficient for the current VPS model. A
multi-process or horizontally scaled relay must move authentication rate state
to an atomic shared store such as Valkey/Redis, or enforce it at the trusted
edge.

## Agent Credential Transport

The Node agent sends its credential with
`Authorization: Bearer <token>` during the WebSocket upgrade. Browser account
sessions already use an HttpOnly cookie. Manual browser-token mode will use an
HTTPS token exchange that issues a short-lived cookie before opening the
WebSocket.

Query-token compatibility will be guarded by a temporary configuration flag
and removed in a documented release. Tokens must not be placed in WebSocket
subprotocol names because infrastructure may log those values as well.

## Delivery Order

1. Owner schema, bootstrap, login, cookie sessions, password changes, and
   session revocation.
2. Replace the token-entry page with the new administration shell.
3. Add optional passkeys, recovery codes, and password confirmation for MFA
   management. (Complete.)
4. Move agent credentials out of WebSocket URLs. (Complete for Node agents;
   temporary query-token compatibility remains for older releases.)
5. Complete the audit view, pilot recovery tooling, and migration
   documentation. (Recovery and pilot session controls complete.)
6. Run a focused security audit before expanding beta access.
