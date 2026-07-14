# Third-Party Notices

VoxHF itself is licensed under the GNU Affero General Public License v3.0 only.
This file separately tracks third-party software and services referenced by the project.

Dependency rules for future additions are documented in
[Dependency And License Policy](DEPENDENCY_POLICY.md).

## Runtime Dependencies

Current npm runtime dependencies are intentionally small and use permissive
licenses.

### SimpleWebAuthn

- Packages: `@simplewebauthn/server` 13.3.1 and `@simplewebauthn/browser` 13.2.0
- Purpose: standards-based WebAuthn/passkey option generation, browser
  interaction, and cryptographic response verification for optional admin MFA.
- License: MIT
- Source: <https://github.com/MasterKale/SimpleWebAuthn>
- The browser bundle is served by the relay itself; the admin page does not load
  it from a CDN.

### ws

- Package: `ws`
- Version: 8.21.0
- Purpose: WebSocket server/client support for local and remote connections.
- License: MIT
- Installed through npm from <https://www.npmjs.com/package/ws>.

### better-sqlite3

- Package: `better-sqlite3`
- Version: 12.11.1
- Purpose: SQLite database access for relay token authentication, persisted browser pairings, and relay admin control-plane data.
- License: MIT
- Notes: uses a native binding; CI and release testing must cover Windows and Linux installs.
- Installed through npm from <https://www.npmjs.com/package/better-sqlite3>.

## Development Dependencies

### yazl and yauzl

- Packages: `yazl` 3.3.1 and `yauzl` 3.4.0.
- Purpose: create and inspect the ZIP files produced by release tooling.
- License: MIT.
- Distribution status: development-only; neither package is installed by
  VoxHF Local or VoxHF Server at runtime.

## External Tools

### FFmpeg

- Purpose: Audio decoding and encoding for IVAO voice RX/TX.
- Distribution status: not bundled in the source repository.
- VoxHF calls `ffmpeg` as an external executable from the system `PATH`.
- FFmpeg licensing depends on the exact build and enabled libraries. See <https://ffmpeg.org/legal.html>.
- Official download page: <https://ffmpeg.org/download.html>.

### Gyan FFmpeg Builds

- Purpose: recommended Windows build source for users who install FFmpeg manually or through `winget`.
- Distribution status: not bundled in the source repository.
- Build page: <https://www.gyan.dev/ffmpeg/builds/>.

If VoxHF later ships a portable release that includes FFmpeg binaries, that release must include the exact FFmpeg build license files, source/build references, and any additional notices required by that build.
