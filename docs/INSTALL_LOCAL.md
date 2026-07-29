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

## Notifications And Session History

Recent chat history is kept in the running local proxy and is restored after a
browser refresh or reconnect. Every local or remote device connected to the
same agent receives that shared current-session history. Recovery does not
depend on notification permission and the history is cleared when the proxy
process restarts.

To enable notifications, open Settings > Notifications on each device. On
iPhone and iPad, first add the hosted VoxHF app to the Home Screen, open that
installed app, then enable notifications from Settings. The local proxy stores
the browser push subscriptions and sends notifications for incoming private
messages and incoming public messages that begin with the active callsign. The
relay transports subscription commands live but does not store them or send the
push itself.

### Enable Notifications On iPhone Or iPad

Requirements:

- iOS or iPadOS 16.4 or newer.
- The HTTPS hosted VoxHF app connected to the local agent through its relay.
- VoxHF running on the Altitude PC with the active callsign detected.

Enable one Apple device at a time:

1. Open the hosted VoxHF app address in Safari and sign in.
2. Tap **Share**, scroll down, and choose **Add to Home Screen**. If Apple shows
   **Open as Web App**, keep it enabled, then tap **Add**.
3. Leave Safari and launch VoxHF from the new Home Screen icon. Notification
   permission cannot be enabled from a normal Safari tab.
4. Wait until VoxHF shows the agent and callsign as online.
5. Open **Settings > Notifications** inside VoxHF.
6. Confirm that **Device Support** says `Supported` and **Proxy** says `Ready`.
7. Tap **Enable on This Device**, then choose **Allow** in the iOS prompt.
8. Confirm that **Permission** says `granted`, **This Device** says `Enabled`,
   and **Saved Devices** is at least `1`.
9. Lock the screen and send a private message to the active callsign. A
   self-addressed private message sent through Altitude is suitable for this
   end-to-end check.

If delivery is disabled or delayed:

- Open the iOS **Settings** app, select **Notifications > VoxHF**, enable
  **Allow Notifications**, and allow **Lock Screen** delivery.
- Check whether a Focus mode or Scheduled Summary is delaying VoxHF.
- If VoxHF says **Add to Home Screen first**, close the Safari tab and open the
  Home Screen app.
- If VoxHF says **Proxy Offline** or **Waiting for proxy**, restore the local
  agent/relay connection before retrying.
- If permission remains denied, change it in iOS Settings; the webapp cannot
  override a system denial.

Repeat the procedure on every iPhone or iPad that should receive alerts.
Disabling notifications on one device does not disable chat recovery or the
other subscribed devices.

Apple documents the underlying requirements in
[Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/),
[Add a website icon to the Home Screen](https://support.apple.com/guide/iphone/bookmark-a-website-iph42ab2f3a7/ios),
and [Change notification settings](https://support.apple.com/guide/iphone/change-notification-settings-iph7c3d96bab/ios).

## Update

Check and stage a published update:

```powershell
npm.cmd run update:check
npm.cmd run update:stage
```

The updater downloads release metadata over HTTPS, verifies the Local ZIP size
and SHA-256, extracts it into a new sibling folder, and copies `config.json`
plus the private `.voxhf-local` notification state. It intentionally does not
overwrite a running installation. Stop VoxHF, start the staged folder, and keep
the old folder until the new version has passed a flight-session test.

The staged source ZIP is checksum-verified but is not yet a signed Windows
binary. Downloading the ZIP manually and following the same new-folder process
remains supported.

## Remove

Stop VoxHF and delete its extracted folder. VoxHF does not install a Windows
service or expose the local PilotUI/PilotCore proxy ports to the internet.
