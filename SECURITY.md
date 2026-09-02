# Security Policy

This policy covers the VoxHF local agent, webapp, relay, account/admin services,
release packages, and self-hosting configuration.

## Supported Versions

VoxHF is pre-1.0. Security fixes target the latest public release.

| Version | Supported |
| --- | --- |
| Latest `0.1.x` release | Yes |
| Older releases | No |

## Report A Vulnerability

Do not open a public issue for a suspected vulnerability. Use a private GitHub
security advisory when available, or contact the maintainer privately first.

Include:

- affected component and version/commit;
- reproducible steps or a proof of concept;
- expected impact;
- whether tokens, cookies, credentials, audio, messages, position, or personal
  data may be exposed;
- any immediate containment already performed.

Do not include live user secrets or unnecessary personal data in the report.

## Secure Deployment Baseline

- Keep local ports `4827`, `6809`, `8767`, and `3000` private. Never port-forward
  them or bind them to a public interface for remote access.
- Use an authenticated HTTPS/WSS relay for remote browsers.
- Restrict `VOXHF_ALLOWED_ORIGINS` to exact trusted HTTPS origins.
- Use unique generated relay, agent, and admin secrets; never reuse them.
- Keep `.env`, `config.json`, `.voxhf-local`, SQLite databases, cookies, logs,
  and backups private.
- Keep invite-only registration enabled unless open registration is a deliberate
  and reviewed operating decision.
- Disable legacy agent query-token compatibility after all agents use
  `Authorization` header authentication.
- Patch the OS, Docker, Node.js, npm dependencies, ffmpeg, and browsers.
- Test backup restoration and account/admin recovery before inviting users.
- Publish deployment-specific Terms and Privacy documents.

The complete server checklist and commands are in
[Self-Hosting](docs/SELF_HOSTING.md#security-checklist-before-inviting-users).

## Implemented Trust Boundaries

- The local agent is the source of truth and validates actions again before
  touching PilotCore, FSD, TS2, radio, XPDR, or TX state.
- Remote traffic uses a versioned typed protocol with source restrictions,
  allowlisted message types, size limits, and validation at both relay and
  agent boundaries. No raw FSD, TS2, or PilotCore tunnel is exposed.
- Browser WebSockets require an allowed `Origin`; agents authenticate separately.
- Account and admin identities/sessions are separate. Browser sessions use
  opaque HttpOnly, Secure, SameSite cookies; stored secrets are hashed.
- Pairing and invite codes are memory-only, expiring, rate-limited, and one-use.
- TX requires an explicit browser action and stops on browser, relay, agent,
  pairing, selected-device, or timeout failure.
- ffmpeg is started without a shell, receives fixed argument arrays, and handles
  streamed data rather than peer-selected file paths.
- Audio is live-only and never stored in SQLite.
- The optional agent-offline watchdog accepts only short-lived sealed Push
  requests created by the authenticated local agent and keeps them in relay
  memory only.

Detailed protocol and failure behavior is in the
[Technical Paper](docs/TECHNICAL_PAPER.md); threats and residual trust are in
the [Threat Model](docs/THREAT_MODEL.md).

## Logging And Stored Security Data

Logs and audit events may record bounded event types, identifiers, timestamps,
outcomes, and delivery counts. They must not contain passwords, full tokens,
cookies, pairing/invite/recovery codes, Push endpoints, authorization headers,
chat text, voice audio, or raw FSD/TS2 payloads.

Persistent audit data and session IP/user-agent metadata are disabled by
default and are separate operator choices. See
[Privacy Architecture](docs/PRIVACY.md).

## Dependency And Release Security

Run before publication:

```powershell
npm.cmd audit
npm.cmd run verify
npm.cmd run release:prepare
npm.cmd run release:verify
```

Release packages use locked dependencies and SHA-256 manifests, but the Local
ZIP is not yet a signed Windows binary. Dependency and license decisions are in
[Dependency Policy](docs/DEPENDENCY_POLICY.md).

The dated internal baseline is recorded in
[Security Audit](docs/SECURITY_AUDIT.md). It does not replace independent
security review.
