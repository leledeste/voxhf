# Local Installation

`voxhf-local` is the lightweight Windows package for normal pilots. It contains
the local agent and browser UI, but not the relay, SQLite, Docker, or admin
panel. Git is not required.

## Requirements

- Windows 10 or 11.
- IVAO Altitude/PilotUI and PilotCore.
- Node.js 20 or newer.
- ffmpeg with Speex encoding and decoding support.

Install the external requirements when needed:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
```

Open a new terminal after installation and verify:

```powershell
node --version
ffmpeg -hide_banner -encoders | findstr speex
ffmpeg -hide_banner -decoders | findstr speex
```

## Install And Start

1. Extract the complete `voxhf-local-<version>.zip` archive to a normal user
   folder, for example `C:\Users\YourName\VoxHF`.
2. Double-click `start.bat`.
3. On first launch, VoxHF installs its small npm dependency set and opens the
   setup wizard.
4. Choose the local-only or remote-agent setup and keep automatic IP detection
   unless there is a specific reason to select an interface manually.
5. Start PilotUI and enter the IPv4 address printed by VoxHF as the Simulator
   Address.
6. Open `http://localhost:3000`.

`config.json` contains private local settings and agent credentials. Back it up
before replacing the installation folder and never publish it.

## Connect To A Remote Server

Local mode needs no account and stays at `http://localhost:3000`. To use a
server hosted by another person, ask its operator for:

- the hosted app address, such as `https://app.example.com`;
- the relay address, such as `wss://relay.example.com`;
- a one-time registration code when registration is invite-only.

Then:

1. Open the hosted app's `/register` page and create your own account.
2. Save the agent token shown after registration. It is displayed only once
   and is different from the server's admin or deployment tokens.
3. In the extracted Local folder, run:

   ```powershell
   npm.cmd run setup -- agent
   ```

4. Enter the relay address, agent token, and a recognizable simulator-PC name.
5. Restart VoxHF with `start.bat` and confirm that the console reports the
   remote agent as connected.
6. Sign in to the hosted app with the same account from each trusted browser or
   phone. The local page remains available independently.

The equivalent manual `config.json` settings are:

```json
{
  "remoteAgentEnabled": true,
  "remoteRelayUrl": "wss://relay.example.com",
  "remoteRelayToken": "your-personal-agent-token",
  "remoteDeviceId": "my-simulator-pc",
  "remoteDeviceName": "Simulator PC"
}
```

Update these fields inside the existing file rather than replacing the complete
configuration. `remoteDeviceId` is the stable identifier for this simulator PC;
keep it unchanged after pairing. `remoteDeviceName` is only the friendly label
shown in the webapp.

The local agent makes an outbound encrypted WebSocket connection. It does not
expose PilotUI, PilotCore, FSD, or TS2 proxy ports to the server or internet.
Connecting to someone else's relay still means trusting that operator with the
server-side account and live relayed traffic. To change servers, run the agent
setup again with the new relay address and token.

## Update

Check and stage a published update:

```powershell
npm.cmd run update:check
npm.cmd run update:stage
```

The updater downloads release metadata over HTTPS, verifies the Local ZIP size
and SHA-256, extracts it into a new sibling folder, and copies only
`config.json`. It intentionally does not overwrite a running installation.
Stop VoxHF, start the staged folder, and keep the old folder until the new
version has passed a flight-session test.

The staged source ZIP is checksum-verified but is not yet a signed Windows
binary. Downloading the ZIP manually and following the same new-folder process
remains supported.

## Remove

Stop VoxHF and delete its extracted folder. VoxHF does not install a Windows
service or expose the local PilotUI/PilotCore proxy ports to the internet.
