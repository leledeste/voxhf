# Privacy Architecture

This document describes the data handled by the VoxHF software. A public
server operator must publish a user-facing Privacy Policy for that deployment;
the project templates are not a substitute for operator-specific legal text.

## Data Flow Summary

- The local agent processes IVAO/PilotCore/FSD/TS2 state on the simulator PC
  and remains the source of truth.
- A local browser talks directly to that agent.
- In remote mode, a trusted relay routes authenticated parsed state, commands,
  messages, and live audio between the selected browser and agent.
- The relay does not connect to IVAO and does not need IVAO credentials.

## Relay Data Stored In SQLite

Account mode stores only the control-plane records needed to operate the
service:

- username and display name; VoxHF does not request an email address;
- password hashes, hashed agent tokens, and hashed session identifiers;
- account status, timestamps, and legal-document acceptance versions;
- known agent/device and paired-browser records;
- server-side browser and admin session records;
- optional admin passkey public credentials/counters and hashed recovery codes;
- optional bounded audit events when the operator enables persistence.

Session IP address and user-agent metadata are stored only when
`VOXHF_RELAY_STORE_SESSION_METADATA=true`. Audit persistence is stored only
when `VOXHF_RELAY_PERSIST_AUDIT=true`. Both are disabled by default.

## Data The Relay Does Not Persist

- IVAO or Altitude credentials;
- raw FSD, TS2, or PilotCore traffic;
- voice audio or recordings;
- chat history or full message contents;
- full passwords, agent tokens, session tokens, or cookies;
- active pairing, registration-invite, or password-recovery codes in plaintext;
- normal Web Push subscriptions, encryption keys, or VAPID credentials;
- flight position, flight plan, weather, radio, XPDR, or high-frequency audio
  state as database records.

Live relayed state and audio necessarily exist in process/network memory while
being routed, then are discarded.

### PC/Proxy Offline Watchdog Exception

When a remote browser explicitly enables this alert, the local proxy may give
the relay a short-lived one-use Push request containing that device's Push
endpoint and an alert already encrypted and signed by the proxy. The relay:

- keeps it only in process memory;
- never receives the local VAPID private key;
- never writes the endpoint or request to SQLite, logs, audits, or backups;
- deletes it after delivery, disarm, replacement, expiry, or restart.

The signature expires within 15 minutes. A malicious relay could replay only
the same opaque alert before expiry; it could not read, change, or sign another
notification.

## Data Stored By The Local Agent

Memory-only for the current proxy process:

- up to 200 recent typed chat events for browser refresh/reconnect recovery;
- current flight, radio, weather, notification-retry, and three-minute timer
  state;
- live audio buffers and codec process state.

Private local files:

- `config.json` for local and optional relay configuration/agent token;
- `.voxhf-local/notifications.json` for VAPID credentials and subscribed
  browser devices.

Stopping the proxy clears memory-only history and timers. Notification
credentials remain until the user disables/removes them or deletes the private
state. Audio is never recorded.

## Browser Chat Preferences

The operational webapp stores chat-tab order and visibility in browser local
storage, separated by local mode or remote relay/account/agent identity. This
includes up to 200 private callsign-tab identifiers per scope and timestamps
used to avoid reopening hidden tabs when old history is recovered. No message
bodies, drafts, or audio are stored with these preferences, and they are not
uploaded or synchronized to other browsers. They remain until site data is
cleared; proxy restart does not remove them. Browser storage is local to that
browser profile, not encrypted account storage. Drafts remain page-memory only.

## Default Lifetimes

| Data | Default lifetime |
| --- | --- |
| Account and device records | Until revocation/deletion by the user/operator |
| Pilot browser session | Up to 30 days, subject to logout/revocation |
| Admin session | 12-hour absolute and 30-minute idle limits |
| Registration invite | Memory-only, one use, 24 hours |
| Browser pairing code | Memory-only, one use, 10 minutes |
| Password-recovery code | Hashed, one use, 30 minutes |
| Audit rows | Disabled; seven days when enabled |
| SQLite backups/pre-restore copies | 30 days in managed backup storage |
| Agent-offline Push ticket | Memory-only, refreshed while armed; expires within 15 minutes and is one-use |
| Local chat history | Current proxy process only, maximum 200 events |

Operators may change configurable lifetimes and backup retention, but must
document their actual policy.

## User And Operator Controls

Logged-in pilots can:

- list browser sessions and revoke other devices;
- log out and change their password;
- rotate the personal agent token;
- disable notifications and the optional offline watchdog per device;
- stop remote access from the local agent.

The server owner can disable/enable/delete accounts, revoke pairings and
sessions, rotate/revoke agent tokens, and issue one-use password-recovery codes.
Account deletion removes the relay account records governed by the deployment;
external backups then follow that operator's retention schedule.

VoxHF does not currently provide a self-service data-export workflow. An
operator receiving an access or deletion request must use the deployment's
admin and backup procedures and applicable policy.

## Operator Responsibilities

Anyone operating a relay is responsible for its infrastructure, access
control, logs, backups, legal basis, notices, retention, user support, and
incident response. Before accepting other users, publish deployment-specific
Terms and Privacy pages that identify the operator and hosting providers.

Connecting to a third-party relay means trusting its operator with account
metadata and live relayed traffic. Self-hosting reduces that dependency but
does not remove the need to secure the VPS and local PC.

Installation and legal-page steps are in [Self-Hosting](SELF_HOSTING.md).
