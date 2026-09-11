# Dependency And License Policy

VoxHF is licensed under **AGPL-3.0-only**. Dependencies must permit source and
binary redistribution with an AGPL application, and every required notice or
source obligation must be satisfied in release packages.

## Selection Rules

Add a dependency only when it materially reduces risk or complexity compared
with clear standard-library code. Prefer packages that are:

- small, mature, maintained, and widely reviewed;
- available from a stable upstream source;
- explicit about license and redistribution terms;
- free of install-time downloads or bundled native binaries unless those are
  justified and tested;
- scoped to development rather than runtime when possible.

Permissive licenses such as MIT, Apache-2.0, BSD, ISC, and 0BSD are normally
acceptable. Copyleft, dual, source-available, custom, unclear, or binary-bundled
terms require explicit review. A dependency is rejected when its terms cannot
be satisfied together with VoxHF's AGPL distribution and network-source
obligations.

Do not describe AGPL, GPL, LGPL, MPL, or another copyleft license as inherently
disallowed. Compatibility depends on the exact version, linking/distribution
model, modifications, and combined-work obligations. Record the decision in
[Third-Party Notices](THIRD_PARTY_NOTICES.md).

## Current Baseline

Node.js 24 LTS is the tested runtime baseline (minimum Node.js 24). Docker
builds and CI use that major version. After changing Node.js major versions,
reinstall locked dependencies with `npm ci` so native modules match the runtime.
Docker operators rebuild the relay image; they do not need to install Node.js
on the host. See [Self-Hosting](SELF_HOSTING.md) for the deployment procedure.

Runtime npm dependencies:

| Package | Purpose | License/handling |
| --- | --- | --- |
| `ws` | WebSocket client/server | MIT |
| `web-push` | Local VAPID and Web Push delivery | MPL-2.0; used unmodified as a separate npm module and distributed with its notice/source metadata |
| `@simplewebauthn/server`, `@simplewebauthn/browser` | Optional admin passkey MFA | MIT |
| `better-sqlite3` | Relay SQLite binding | MIT; native binding covered by supported-platform install tests |

Development-only `yazl` and `yauzl` create and inspect ZIP artifacts. They are
MIT licensed and excluded from Local and Server runtime lockfiles.

SQLite is public domain. FFmpeg is an external executable discovered from the
system `PATH`; VoxHF does not bundle it. The exact FFmpeg build selected by the
user determines its license configuration.

The authoritative version and transitive-license inventory is
`package-lock.json`, not this prose summary.

## Review Checklist

Before adding or updating a package:

1. Inspect its declared license, license files, upstream repository, release
   history, and maintenance state.
2. Inspect the complete lockfile change and transitive dependencies.
3. Check for native code, bundled binaries, install scripts, runtime downloads,
   telemetry, or unexpected network access.
4. Decide whether it belongs in runtime or development dependencies.
5. Confirm AGPL-compatible redistribution and document any extra obligations.
6. Update [Third-Party Notices](THIRD_PARTY_NOTICES.md).
7. Add focused integration tests and run `npm.cmd run verify` plus
   `npm.cmd audit`.
8. Inspect every generated package to ensure only intended dependencies and
   notices are present.

The repository verification checks lockfile license expressions against the
reviewed allowlist. Automation is a guard, not a substitute for legal and
security review.

## FFmpeg Distribution

If a future release bundles FFmpeg, it must document the exact build options
and license mode, include required notices and source/build references, and
update the release/package verification before publication.

## Database Boundary

SQLite is for low-frequency control-plane data: accounts, hashed credentials,
pairings, sessions, devices, legal acceptance, and optional bounded audit
events. It must not contain IVAO credentials, raw FSD/TS2 traffic, voice audio,
chat history, or high-frequency flight/audio state.

A different database may be introduced for measured scale requirements, but
SQLite remains the simple self-host default while it meets the workload.
