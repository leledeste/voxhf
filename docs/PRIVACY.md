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
- Browser Push subscriptions or Push encryption keys. Subscription commands
  pass through the relay only to the selected local agent. If a user explicitly
  enables the agent-offline watchdog, the relay temporarily holds a Push
  endpoint and a short-lived request already encrypted and signed by that
  agent. It remains in memory only and is deleted after use, disarm, replacement,
  expiry, or relay restart. Its signature expires within 15 minutes; a modified
  relay could replay only that same opaque alert before expiry, not read or
  alter it.

## Data Kept By The Local Agent

- Up to 200 recent typed chat events in memory for the current proxy session,
  so a browser refresh or reconnect can recover the conversation.
- Web Push VAPID credentials and enabled-device subscriptions in
  `.voxhf-local/notifications.json`.

Chat history is cleared when the local proxy stops. Notification state remains
local to the simulator PC until a device is disabled or the private local state
file is removed.

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
- Agent-offline Push tickets: memory-only, at most 20 minutes, normally
  refreshed every 5 minutes, and one-use after the offline grace period.

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
