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

`npm.cmd run fsd:test` also covers VOICE replies split at every byte boundary,
multiple records in one chunk, exact byte preservation, connection-local tails,
and oversized records. These deterministic tests do not require a live network;
the channel and RX/TX checks below still require Altitude.

`npm.cmd run ts2:test` delays DNS callbacks deliberately to cover out-of-order
results, A -> B -> A switches, repeated lookups, and resolution failures.
It also checks the target used for new TCP connections and UDP forwarding.
The routing tests also cover distinct server endpoints, discovery while joined,
A -> B -> A, stale packets/decoder exits, and ordered FSD replies while listeners
bind. The loopback smoke test uses real local TCP/UDP on an ephemeral port;
all other endpoints are simulated. None validates live IVAO audio quality.

Use [Voice Routing Diagnostics](VOICE_ROUTING_DIAGNOSTICS.md) for initial joins,
same-server changes, cross-server changes and reconnects. Its beta validation
status distinguishes completed live tests from remaining coverage. Verify actual
Altitude connectivity and browser RX/TX, not merely the Ready indicator; retain
explicit limitations for any beta released before full live coverage.

## Clean Windows PC

Use a second PC, Windows Sandbox, or a clean virtual machine. Do not clone the
repository and do not copy `node_modules` from the development PC.

1. Download `voxhf-local-<version>.zip` and `SHA256SUMS.txt`.
2. Compare `Get-FileHash .\voxhf-local-<version>.zip -Algorithm SHA256` with
   the published checksum.
3. Follow only `docs/INSTALL_LOCAL.md` and `docs/USER_GUIDE.md` from the
   extracted package.
4. Record whether Node.js, ffmpeg, setup, and startup instructions are enough
   without additional knowledge.
5. Connect Altitude and verify initial COM/XPDR state.
6. Verify COM1/COM2 tuning, station dropdowns, private and frequency messages,
   commands, route weather, RX, and TX. Confirm that UNICOM chat remains
   visible, traffic for both tuned COM frequencies is visible, and incoming
   traffic for a third untuned frequency is hidden from **All** and
   **Frequency**.
7. While several nearby controllers are advertised, including controllers on
   different regional TS2 servers when available, join and change voice
   channels. Confirm that voice remains connected and **Web TX ready** does not
   briefly fall back to the join-channel warning because an unrelated UDP flow
   was observed. Repeat after leaving and rejoining a channel.
   When practical, switch between stations on different voice-server hostnames
   and back to the first, then verify RX/TX still works. The automated DNS test
   covers delayed answers that cannot reliably be forced in a live session.
8. Restart Windows, then verify startup and retained configuration.
9. On an already signed-in iPhone or iPad, open or refresh the workspace and
   verify that **Tap to activate RX** appears over the radio panel. Tap it once,
   confirm that it disappears, and verify the next live RX transmission without
   opening Settings or pressing **Test RX**. Confirm that the prompt never
   appears on desktop, then verify PC plus mobile RX simultaneously. Repeat
   after browser standby: automatic recovery should remain silent when it
   succeeds, while a failed iOS recovery should show the prompt again.
10. Refresh both devices and verify that the current proxy session's chat is
   recovered even when notification permission is disabled on one of them.
   Scroll up in a long chat and receive another message: the reading position
   must remain stable. Scroll back to the bottom and verify new messages are
   followed automatically; selecting another tab should open its latest messages.
11. Enable notifications separately on supported test devices, send a real
    private message, lock the mobile screen, and verify delivery. Also verify a
    public message beginning with the active callsign when a controller test is
    available.
12. Enable the optional online confirmation and verify that only the subscribed
    device receives it after IVAO connects; confirm that startup SERVER welcome
    text remains in chat without generating message alerts.
13. Start the three-minute UNICOM reminder, refresh or suspend one browser, and
    verify synchronized state plus its in-app and Push expiry alerts.
14. Verify disconnect policy once while moving above five knots and once after
    two fresh stationary samples at five knots or less. The moving case should
    notify after ten seconds; the stationary case should remain silent.
15. In remote mode, explicitly enable **PC / Proxy Offline Alert**, close the
    proxy or shut down its PC while IVAO is connected, and verify delivery after
    heartbeat detection and the configured grace period. Reconnect within the
    grace period once to verify cancellation.
16. Stop VoxHF and remove the extracted folder to confirm clean removal.

The package passes only when no file from the source checkout is needed and no
private token, `.env`, `config.json`, database, dump, or log exists in the ZIP.

## Other Packages

Run `npm.cmd run server:test` from the source checkout to exercise managed
server updates with stubbed Docker/Git commands in a temporary directory.
It covers backup creation/verification failures, helper installation failures,
and successful update ordering without touching a deployment. A POSIX shell is
required; Windows without Git's shell reports a skip, while Linux CI requires
the test to run. Keep the real SQLite backup/restore tests as a separate check.

- Hosted Webapp: deploy only its extracted `webapp` folder to a test HTTPS host.
- Server: deploy only the Server ZIP to a clean Linux VM with Docker Compose.
- Full Source: run `npm ci`, `npm run verify`, and `npm run release:prepare` from
  the extracted archive.
