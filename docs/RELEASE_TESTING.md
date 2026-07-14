# Release Installation Test

This checklist validates the downloadable artifacts independently from the
developer checkout. Automated checks run first:

```powershell
npm.cmd run release:prepare
npm.cmd run release:verify
npm.cmd run release:test
```

`release:test` extracts every ZIP into a temporary directory, installs the
declared dependencies, and runs package-specific smoke tests.

## Clean Windows PC

Use a second PC, Windows Sandbox, or a clean virtual machine. Do not clone the
repository and do not copy `node_modules` from the development PC.

1. Download `voxhf-local-<version>.zip` and `SHA256SUMS.txt`.
2. Compare `Get-FileHash .\voxhf-local-<version>.zip -Algorithm SHA256` with
   the published checksum.
3. Follow only `docs/INSTALL_LOCAL.md` from the extracted package.
4. Record whether Node.js, ffmpeg, setup, and startup instructions are enough
   without additional knowledge.
5. Connect Altitude and verify initial COM/XPDR state.
6. Verify COM1/COM2 tuning, station dropdowns, private and frequency messages,
   commands, route weather, RX, and TX.
7. Restart Windows, then verify startup and retained configuration.
8. If remote mode is used, verify PC plus phone simultaneously and reconnect
   after browser standby.
9. Stop VoxHF and remove the extracted folder to confirm clean removal.

The package passes only when no file from the source checkout is needed and no
private token, `.env`, `config.json`, database, dump, or log exists in the ZIP.

## Other Packages

- Hosted Webapp: deploy only its extracted `webapp` folder to a test HTTPS host.
- Server: deploy only the Server ZIP to a clean Linux VM with Docker Compose.
- Full Source: run `npm ci`, `npm run verify`, and `npm run release:prepare` from
  the extracted archive.
