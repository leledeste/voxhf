# Privacy Architecture

This document describes VoxHF's technical privacy defaults. The official
hosted beta publishes its user-facing policy at
[voxhf.com/privacy](https://voxhf.com/privacy). Independent server operators
must publish terms appropriate to their own deployment.

VoxHF should be designed so remote access can work without storing IVAO traffic, voice audio, or chat history on a central server.

## Data Minimization

The relay should collect only the data needed to authenticate users, pair devices, route live sessions, and protect the service from abuse.

## Data The Relay Stores For Accounts

- Username and display name. VoxHF does not currently request email addresses.
- Hashed authentication/session identifiers.
- Paired device metadata, such as device name and creation time.
- Paired-browser records, stored as hashed browser ids and agent ids.
- Session creation, last-use, expiry, and revocation timestamps.

Optional persistence is disabled by default:

- `VOXHF_RELAY_STORE_SESSION_METADATA=true` stores session IP and user-agent.
- `VOXHF_RELAY_PERSIST_AUDIT=true` stores bounded admin, agent, and pairing
  audit events without message or audio payloads.

An operator who opts into the public server directory also stores and
publishes the server name, operator, region, access policy, app/relay URLs,
description, privacy/source links, declared version, registration status, and
last heartbeat time. The heartbeat token is stored as a hash. Heartbeats do
not include users, account data, messages, radio state, audio, or IVAO traffic.

## Data The Relay Should Not Store

- IVAO credentials.
- Altitude credentials.
- Voice audio recordings.
- Raw TS2 packets.
- Raw FSD packets.
- Chat history.
- Full message contents.
- Full authentication tokens.
- Pairing and registration invite codes after use or expiry.

## Retention Targets

Suggested defaults:

- Account records: until account deletion.
- Device records: until device revocation or account deletion.
- Active session records: deleted when no longer needed.
- Audit events: disabled by default; 7 days when enabled unless configured.
- Registration invites: in memory, one use, 24 hours by default.
- Pairing codes: in memory, 10 minutes by default.
- Preview paired-browser records: until browser revocation or manual relay store deletion.
- SQLite backups and pre-restore database copies: 30 days by default.
- Raw remote payloads: not persisted.

Self-hosted operators can choose different retention, but they should document it.

## User Controls

Remote mode should eventually provide:

- Delete account.
- Revoke device.
- Revoke all sessions.
- Export account/device metadata.
- Disable remote access from the local agent.

## Self-Hosted Responsibility

When someone self-hosts a relay, they become responsible for their own deployment, logs, backups, users, and privacy obligations.

The project should provide safe defaults, but operators still need to configure hosting, backups, access control, and retention responsibly.

A public directory listing is not a VoxHF audit or endorsement. Independent
operators may modify the software and their data practices cannot be verified
by the directory. Users must review the operator's privacy and source links
before registering.

## Official Relay Responsibility

An operator offering a hosted service should publish:

- a Privacy Policy and Terms of Use;
- retention and infrastructure-provider information;
- a privacy, security, and account-deletion contact for that deployment.

## Design Defaults

- Remote access disabled by default in the local agent.
- No public exposure of the local proxy.
- Parsed local FSD events sent to the browser should omit raw protocol lines.
- No chat or audio storage on the relay.
- Remote RX and TX audio forwarding should remain live-only and should not be cached or replayed.
- Short-lived pairing.
- Revocable devices.
- Audit persistence disabled by default. When enabled, events store bounded
  metadata such as event type, user id, agent id, pairing id, and timestamp,
  never chat text, voice audio, raw FSD, or raw TS2 data. IP storage remains a
  separate opt-in choice.
- Clear UI indication when a remote session is active.
