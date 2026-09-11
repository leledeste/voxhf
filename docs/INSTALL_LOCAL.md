# Install The VoxHF Local Agent

The Local package runs on the same Windows PC as IVAO Altitude. It contains the
local Node.js agent and operational webapp, but not the relay, accounts, SQLite,
Docker, or server administration. Git is not required for the release ZIP.

After installation, use the [User Guide](USER_GUIDE.md) for every workspace
feature and example.

## Requirements

- Windows 10 or 11.
- IVAO Altitude/PilotUI and PilotCore.
- Node.js 24 or newer (24 LTS recommended).
- ffmpeg with Speex encoding and decoding support.

Install missing tools with Winget:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
```

If the active Node.js version is older than 24, use
`winget upgrade OpenJS.NodeJS.LTS`. The launcher displays the appropriate
install/upgrade command and stops; it does not run Winget automatically.
The Winget package follows the available LTS, while Node.js 24 remains the
tested baseline. If Winget is unavailable or cannot match the existing Node
installation, use the [official installer](https://nodejs.org) or your existing
Node version manager. Close and reopen VoxHF after installing or updating.

Open a new PowerShell window and verify them:

```powershell
node --version
ffmpeg -hide_banner -encoders | findstr speex
ffmpeg -hide_banner -decoders | findstr speex
```

The Node version must be 24 or newer and both ffmpeg searches must list Speex.

## Install From The Release ZIP

1. Download `voxhf-local-<version>.zip` from the
   [latest release](https://github.com/leledeste/voxhf/releases/latest).
2. Extract the complete archive to a normal user folder, for example
   `C:\Users\YourName\VoxHF`. Do not run it from inside the ZIP.
3. Double-click `start.bat`.
4. On the first launch, the script installs the exact locked runtime packages
   and creates `config.json` with the tested local defaults.
5. Keep the VoxHF console open. It prints the local URLs and the IPv4 address
   that PilotUI must use.
6. Start PilotUI. Set its **Simulator Address** to that printed IPv4 address,
   then connect Altitude normally.
7. Open [http://localhost:3000](http://localhost:3000).
8. Confirm **Link: Online**, the correct callsign, and the flight-plan airports.

If Windows Firewall asks about Node.js, allow it only on the private network
used by the simulator. Do not forward or publish VoxHF's local ports.

TS2 voice servers use distinct loopback addresses on port `8767`, created by
VoxHF as they are announced. Do not enter these addresses in PilotUI or add
firewall/hosts-file rules for them: PilotUI still uses the printed simulator
IPv4 address. After upgrading from the shared-address voice proxy, close and
reopen PilotCore/Altitude as well as VoxHF to clear old voice destinations.
Live compatibility testing for this unreleased routing change is described in
[Voice Routing Diagnostics](VOICE_ROUTING_DIAGNOSTICS.md).

`config.json` contains private settings and, in remote mode, an agent token.
Never publish it. The `.voxhf-local` folder holds notification credentials and
subscriptions; keep it private as well.

## Install From Source

Use this path for development or when a release ZIP is not available:

```powershell
git clone https://github.com/leledeste/voxhf.git
cd voxhf
npm.cmd ci
npm.cmd run setup -- local
npm.cmd start
```

Normal pilots should prefer the Local ZIP because it excludes server-only
dependencies and tooling.

## Connect To An Existing Server

Local-only mode needs no account. Remote mode lets trusted browsers and phones
reach the same local agent through an HTTPS/WSS server.

Ask the server operator for:

- the hosted app URL, such as `https://app.example.com`;
- the relay URL, such as `wss://relay.example.com`;
- a one-time registration invite when registration is invite-only.

Then:

1. Open the hosted app's `/register` page.
2. Enter the invite, create the account, and save the **agent token** shown
   once. It is not the account password or server admin token.
3. In the extracted VoxHF Local folder, run:

   ```powershell
   npm.cmd run setup -- agent
   ```

4. Enter the relay URL, agent token, and a recognizable simulator-PC name.
5. Restart VoxHF with `start.bat`.
6. Confirm the console reports the remote agent connection.
7. Sign in to the hosted app from each trusted device. The local
   `http://localhost:3000` workspace remains available independently.

The wizard updates these fields in the existing `config.json`:

```json
{
  "remoteAgentEnabled": true,
  "remoteRelayUrl": "wss://relay.example.com",
  "remoteRelayToken": "your-personal-agent-token",
  "remoteDeviceId": "my-simulator-pc",
  "remoteDeviceName": "Simulator PC"
}
```

Keep `remoteDeviceId` stable after pairing. `remoteDeviceName` is only the
friendly label shown in the app. The agent makes an outbound encrypted
connection; it does not expose PilotUI, PilotCore, FSD, TS2, or the local
webapp to the relay.

Connecting to a third-party server means trusting its operator with account
data and live relayed traffic. Read that deployment's privacy notice before
registering.

## First Functional Check

After local or remote installation:

1. Tune a harmless COM value from VoxHF and confirm Altitude reflects it.
2. Use **Settings > Audio > Test RX**.
3. Send a private message to your own callsign from Altitude and confirm it
   appears in VoxHF.
4. Request `.metar` for a valid ICAO airport.
5. Refresh the page and confirm the current proxy session's chat returns.
6. If using remote mode, repeat the checks from a second trusted device.

See [User Guide > Notifications](USER_GUIDE.md#notifications) for notification
triggers, iPhone/iPad installation, and the end-to-end Push test.

## Update

When moving from Node.js 20 or 22, stop VoxHF, install Node.js 24 LTS, and open
a new terminal. Confirm `node --version` before restarting. If reusing an
existing installation folder, run `npm.cmd ci` there to reinstall the locked
dependencies for the new runtime; this is especially important for source
installations containing the native SQLite binding. Configuration and private
notification state are not removed by `npm.cmd ci`.

To check and stage a published Local update:

```powershell
npm.cmd run update:check
npm.cmd run update:stage
```

The updater verifies release metadata, ZIP size, and SHA-256, then extracts a
new sibling folder. It copies `config.json` and private notification state but
does not overwrite the running installation.

Windows extraction uses the built-in Windows PowerShell Archive module. It
also works when npm is launched from PowerShell 7: the updater isolates the
child process's module search path without changing your shell, system settings,
or execution policy. No extra Archive module installation is required on a
standard supported Windows installation.

1. Stop the old proxy.
2. Start `start.bat` from the staged folder.
3. Repeat the functional check above.
4. Keep the old folder until the new version has passed a real flight test.

The release ZIP is checksum-verified but is not a signed Windows binary.
Manual download and extraction into a new folder remains supported.

## Remove Or Reset

To remove VoxHF, stop the proxy and delete its extracted folder. VoxHF does not
install a Windows service.

To reset only the configuration, stop VoxHF, move `config.json` somewhere safe,
and start again. To remove notification credentials and subscriptions as well,
also remove the private `.voxhf-local` folder. This is irreversible for those
device subscriptions, so disable notifications in the app first when possible.

## Installation Troubleshooting

| Error | Resolution |
| --- | --- |
| `Node.js was not found` | Install Node.js, open a new terminal, and run `node --version`. |
| `ffmpeg was not found in PATH` | Install ffmpeg, open a new terminal, and verify the Speex encoder/decoder commands. |
| `npm ci` fails on first launch | Check internet access and the npm error; do not copy a partial `node_modules` from another version. |
| Browser shows `Proxy unavailable` | Keep `start.bat` running and check whether another process uses port 3000. |
| Altitude does not connect | Re-enter the exact IPv4 printed by VoxHF as PilotUI's Simulator Address. |
| Remote agent is rejected | Recheck the relay URL and rotate/re-enter the personal agent token if necessary. |

For application behavior after the connection succeeds, continue with the
[User Guide troubleshooting table](USER_GUIDE.md#troubleshooting).
