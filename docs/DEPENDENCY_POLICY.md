# Dependency And License Policy

Status: active policy

VoxHF should stay easy to audit and redistribute. New dependencies are
allowed only when they clearly reduce project risk or complexity, and their
licenses must be compatible with VoxHF's MIT license.

## Goals

- Keep the source repository redistributable under MIT.
- Prefer small, mature, actively maintained packages.
- Prefer permissive open-source licenses.
- Avoid dependencies that force VoxHF itself to change license.
- Keep external tools, especially FFmpeg, clearly documented when they are not
  bundled.
- Make license review part of normal development before a dependency is added.

## Allowed Licenses

These licenses are acceptable by default:

- MIT
- Apache-2.0
- BSD-2-Clause
- BSD-3-Clause
- ISC
- 0BSD
- Unlicense / public domain, after checking project provenance

Other permissive open-source licenses can be accepted case by case, but must be
documented in [Third-Party Notices](THIRD_PARTY_NOTICES.md).

## Licenses Requiring Explicit Review

These licenses are not automatically forbidden, but they require an explicit
decision before use:

- LGPL
- MPL-2.0
- EPL
- CC0 for code dependencies
- Dual-licensed packages
- Packages with generated binaries or bundled native libraries

If one of these is accepted, the reason and obligations must be documented.

## Disallowed Licenses For Runtime Dependencies

These are not allowed for normal runtime dependencies unless the project makes a
conscious licensing change:

- GPL
- AGPL
- SSPL
- Commons Clause
- Business Source License
- Licenses marked "source available" but not OSI/open-source compatible
- Packages with missing, unknown, custom, or unclear licenses

The main concern is avoiding copyleft or non-open terms that would surprise
users who self-host, redistribute, or inspect VoxHF.

## Current Dependency Baseline

Runtime npm dependencies:

- `ws`: WebSocket server/client support, MIT license.
- `@simplewebauthn/server` and `@simplewebauthn/browser`: optional admin
  passkey MFA, MIT license. Cryptographic WebAuthn verification remains in the
  maintained upstream package rather than project-specific code.

External tools:

- `ffmpeg`: used as a system executable, not bundled in the repository.
  FFmpeg licensing depends on the exact build installed by the user.

Database dependency:

- SQLite itself is public domain.
- SQLite wrapper: `better-sqlite3`, MIT license.
- `better-sqlite3` uses a native binding, so Windows and Linux installs must
  stay covered by CI before release.
- The project Node.js engine baseline is Node 20 or newer because current
  `better-sqlite3` versions require that line or newer.
- The installed dependency tree was reviewed from `package-lock.json` when
  `better-sqlite3` was added. Runtime licenses are permissive, and `npm audit`
  was clean after updating `ws` to a non-vulnerable release.
- `node:sqlite` was reviewed as a future no-dependency option, but it should
  not be the first implementation target while it is still marked release
  candidate in the Node.js documentation and would require a higher Node.js
  baseline.

Development-only packaging dependencies:

- `yazl` and `yauzl`, both MIT licensed, create and verify ZIP release
  artifacts. They are excluded from Local and Server runtime lockfiles.

## Review Process For New Dependencies

Before adding a new dependency:

1. Check the package license in `package-lock.json`, package metadata, and the
   upstream repository.
2. Check whether the package ships native binaries or downloads binaries at
   install/runtime.
3. Check maintenance status, release history, and issue activity.
4. Check whether the dependency is needed at runtime or only for development.
5. Add the dependency and license to
   [Third-Party Notices](THIRD_PARTY_NOTICES.md).
6. Add or update tests that prove the new dependency is actually wired
   correctly.

The dependency should not be added if the same outcome can be achieved with a
small amount of clear standard-library code.

## Automated Checks

The current repository has a small built-in verification command:

```bash
npm run verify
```

This command checks installed npm package license expressions from
`package-lock.json` against the allowed/blocked license policy. It is not a
replacement for human dependency review, but it fails CI when a package has a
missing, blocked, or unreviewed license expression.

## FFmpeg Policy

VoxHF currently calls `ffmpeg` from the system `PATH` and does not bundle
FFmpeg binaries. This keeps redistribution simple.

If a future release bundles FFmpeg:

- The exact build and license mode must be documented.
- License files and notices from that build must be included.
- Source/build references required by that build must be provided.
- `docs/THIRD_PARTY_NOTICES.md` must be updated before release.

## Database Policy

SQLite is acceptable as the default self-host database because VoxHF's
database work should be low-frequency control-plane data: users, tokens,
pairings, revocations, and audit events.

The database must not store:

- IVAO credentials.
- Raw IVAO/FSD traffic.
- Voice audio.
- High-frequency packet/audio state.
- Chat history by default.

If VoxHF later serves a large public relay, PostgreSQL can be added as an
optional production database, but SQLite should remain the simple self-host
default.
