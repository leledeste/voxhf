# VoxHF User Guide

This guide covers the operational webapp. Install the local agent first by
following [Local Installation](INSTALL_LOCAL.md), or obtain the app and relay
addresses from the operator of a trusted VoxHF server.

## Before A Flight

1. Start VoxHF on the same PC as IVAO Altitude.
2. Confirm that PilotUI uses the IPv4 address printed by VoxHF as its
   **Simulator Address**.
3. Connect Altitude normally and file or load the flight plan.
4. Open `http://localhost:3000` locally, or sign in to the hosted HTTPS app on
   another device.
5. Check the top bar:
   - **Link** is online;
   - **FPL** shows departure and destination;
   - **Callsign** matches the active IVAO callsign.
6. On iPhone or iPad, tap the visible **Tap to activate RX** prompt once after
   loading the app.

VoxHF does not replace Altitude. Keep Altitude connected on the simulator PC
for the entire session.

## Workspace At A Glance

| Area | Purpose |
| --- | --- |
| Top bar | Proxy/IVAO state, local or remote mode, flight plan, callsign, RX activity, theme, and Settings |
| Radios | Tune COM1/COM2, select detected stations, receive voice, and start browser TX |
| Transponder | Set the four-digit squawk, choose STBY/ALT, and send IDENT |
| Communications | Read and send frequency, broadcast, private, and system messages; run commands; use the three-minute timer |
| Route weather | Request and interpret departure/destination METAR and TAF |

The layout adapts to short tablet landscape and narrow phone screens. Route
weather remains scrollable even when it moves below the communications panel.
Use **Light/Dark** in the top bar to switch theme; the browser remembers the
choice. A hosted server may also show a dismissible update notice when its
recommended Local version is newer.

## Radios And Stations

### Tune COM1 Or COM2

Use either method:

- type a complete frequency such as `126.805` in the radio's **Frequency**
  field; or
- choose a station from the radio's **Station** list.

Detected stations are ordered by distance when both the aircraft and station
positions are available. `_OBS` positions are excluded. UNICOM `122.800` is
always available even when no controller advertises it.

The local agent validates the complete VHF value before sending a tuning
command to PilotCore. A partial value remains only in the browser field.

### Which Frequency Messages Are Visible

VoxHF always displays UNICOM `122.800` text. Other incoming frequency messages
are displayed only when their frequency is currently tuned on COM1 or COM2.
This matches the useful Altitude chat view and prevents unrelated frequencies
from filling **All** and **Frequency**.

This display filter does not affect private messages, callsign notifications,
station discovery, or voice routing. Messages you send remain visible.

## Voice Receive (RX)

RX is enabled by default. When decoded voice reaches the browser, the **RX**
indicator in the top bar lights up. More than one connected browser can listen
at the same time.

Desktop browsers normally start playback without another action. Safari on a
newly loaded iPhone or iPad document requires a trusted user gesture before it
allows audible Web Audio. VoxHF therefore shows **Tap to activate RX** over the
radio panel only on iOS/iPadOS. Tap it once; the prompt disappears after audio
starts. It may return if the operating system suspends or closes the audio
context after standby.

To verify the browser output without waiting for a controller:

1. Open **Settings > Audio**.
2. Select **Test RX**.
3. Confirm that the test tone is audible and **Audio Output** is active.

If the desktop hears voice but a phone does not, use the troubleshooting steps
at the end of this guide before changing proxy audio parameters.

## Browser Transmit (Web TX)

VoxHF can use a desktop, tablet, or phone microphone to transmit on COM1 or
COM2. This also allows a phone to act as the microphone for a simulator PC.

Before the first browser TX:

1. Join the intended voice channel in Altitude.
2. Wait for **Web TX ready**. If it remains waiting, press Altitude's real PTT
   once so VoxHF can observe a valid TS2 transmit session.
3. Select **TX COM1** or **TX COM2** and allow microphone permission.
4. Hold the control while speaking; release it to stop. The button shows
   **ON AIR** during the active transmission.

Use **Settings > Audio > Monitor TX** to inspect microphone capture without
transmitting to IVAO. The Settings page also shows microphone permission, TX
sample rate, and readiness.

TX stops when the button is released or when the browser, relay, agent, pairing,
or selected device disconnects. VoxHF also applies a maximum remote TX duration.
Live voice still requires real-flight regression testing: use another listener
to confirm audio quality after any audio configuration change.

## Transponder

- Enter exactly four octal digits (`0` through `7`) in **Squawk**. Example:
  `7000`.
- Select **STBY** or **ALT** to set the transponder mode.
- Select **ID** only when instructed by ATC. The visual IDENT state is
  momentary, but the command is sent once.

The latest mode and code are restored in the browser after a refresh without
blindly resending the previous command.

## Messages

### Read And Filter

The tabs above the message area are:

- **All**: every message relevant to the current browser view;
- **Frequency**: relevant COM/UNICOM frequency messages;
- **Private**: all private conversations;
- **System**: local status, weather-request acknowledgements, and server/system
  messages.

An incoming private message creates a callsign tab. Closing that tab with its
`X` hides the conversation tab but does not delete its messages from **All** or
**Private**. Opening the callsign again restores the same current-session
conversation.

### Send A Message

Choose a recipient, type the text, then select **Send**:

- **UNICOM / frequency** sends to UNICOM `122.800`;
- **Broadcast** sends to `*`;
- **Custom...** accepts a callsign, controller position, or frequency such as
  `EDGG_CTR` or `122.800`;
- a private callsign tab locks the recipient to that callsign.

Examples:

```text
LPPR Traffic, A359 lining up and taking off runway 17
WZZ2807, contact EPRZ_TWR on 126.805, good day
```

Only messages actually addressed to the selected recipient are sent. The
browser never receives a raw FSD command tunnel.

### Session History

The local proxy keeps up to 200 recent typed chat events in memory. It sends
that history to every connected local or remote browser after a refresh,
reconnect, or device change. Notification permission is not required.

Restarting or stopping the proxy clears the history. The relay and SQLite
database do not persist it.

## Commands

Start typing `.` in the message box to open command completion. It shows the
canonical weather, chat, COM, XPDR, and IDENT forms. The parser also accepts
the direct-message command and aliases shown below.

| Command | Result | Example |
| --- | --- | --- |
| `.metar ICAO` (`.wx`) | Request a METAR | `.metar LIMC` |
| `.taf ICAO` | Request a TAF | `.taf LIRF` |
| `.atis CALLSIGN` | Request controller ATIS | `.atis LIRF_TWR` |
| `.msg CALLSIGN text` (`.m`) | Send one private message | `.msg EPRZ_TWR radio check` |
| `.chat CALLSIGN [text]` | Open a private tab and optionally send text | `.chat EPRZ_TWR good evening` |
| `.c1 frequency` | Tune COM1 | `.c1 126.805` |
| `.c2 frequency` | Tune COM2 | `.c2 122.800` |
| `.x code` (`.sq`) | Set squawk | `.x 7000` |
| `.xpdr` (`.xp`) | Toggle STBY/ALT | `.xpdr` |
| `.ident` (`.id`) | Send IDENT | `.ident` |

METAR, TAF, and ATIS requests are generated as structured browser actions and
translated to FSD only by the local agent.

## Route Weather

When a flight plan is detected, the top bar shows only the departure and
destination, while **Route weather** creates one card for each airport.

Use the card controls to request METAR or TAF. Results are shared through the
local agent, so another connected browser sees the same current weather state.
Select **Interpret** to expand the built-in plain-language explanation. Treat
the raw report as authoritative; the interpretation is a convenience and may
not cover every aviation-weather abbreviation or edge case.

For an airport outside the flight plan, use `.metar`, `.taf`, or `.atis` in the
message box.

## Three-Minute Timer

Select **Start 3:00** above the message filters when the minimum connected time
for a reportable leg begins. Every browser connected to the same proxy shows
the same countdown. Select **Cancel M:SS** to stop it.

The local proxy owns the timer, so it continues if a browser is refreshed,
closed, or suspended. At expiry VoxHF adds a system message and notifies every
subscribed device:

```text
Timer expired - CALLSIGN
You can now disconnect and report the leg.
```

The timer does not send an IVAO text or voice report. Restarting the proxy
cancels it.

## Notifications

Notifications are enabled separately on every browser device in **Settings >
Notifications**. Chat recovery works independently and remains available when
notifications are disabled.

### Standard Triggers

An enabled device receives Push notifications for:

- incoming private messages;
- public messages whose text begins with the active callsign, such as
  `WZZ2807, Contact EPRZ_TWR on 126.805, good day` or
  `WZZ2807, switch to UNICOM 122.800, good day`;
- a confirmed IVAO disconnection still unresolved after ten seconds, unless
  two fresh position updates show the aircraft stationary at no more than five
  knots;
- expiry of the manually started three-minute timer.

Missing or stale speed data fails safe: the disconnect alert is sent. If the
proxy temporarily loses internet access, it retries while IVAO remains
disconnected, for up to 30 minutes.

IVAO `SERVER` welcome messages received during the first two seconds of a
confirmed connection remain in chat but do not trigger Push. Later server
messages remain eligible because they may announce maintenance or a restart.

For an end-to-end private-message test, send a private message to your own
active callsign through Altitude. VoxHF recognizes that self-addressed test
without notifying for normal outgoing private messages.

### Optional Per-Device Alerts

- **IVAO Online Confirmation** sends `IVAO online - CALLSIGN` after a confirmed
  connection. It is useful for checking that Push remains configured.
- **PC / Proxy Offline Alert** is available in remote mode. During a confirmed
  IVAO session it warns when the relay loses the local agent after the default
  30-second grace period: `The local VoxHF proxy is no longer reachable.`

The second option is distinct from an IVAO disconnect. It covers a closed
proxy, powered-off simulator PC, or lost PC network path. The confirmation
dialog explains that the relay temporarily holds a short-lived, one-use Push
request already encrypted and signed by the local proxy. It is memory-only and
does not give the relay the local VAPID private key.

### Enable Notifications On iPhone Or iPad

Apple Web Push requires iOS/iPadOS 16.4 or newer and an HTTPS webapp installed
on the Home Screen.

1. Open the hosted VoxHF app in Safari and sign in.
2. Select **Share > Add to Home Screen**. Keep **Open as Web App** enabled when
   offered.
3. Close the Safari tab and launch VoxHF from its Home Screen icon.
4. Wait until the agent and callsign are online.
5. Open **Settings > Notifications**.
6. Confirm **Device Support: Supported** and **Proxy: Ready**.
7. Select **Enable on This Device**, then **Allow** in the system prompt.
8. Confirm **Permission: granted**, **This Device: Enabled**, and at least one
   **Saved Device**.
9. Lock the screen and perform the self-private-message test.

If permission was denied, re-enable VoxHF in iOS **Settings > Notifications**.
Focus modes and Scheduled Summary can delay delivery. Repeat the procedure on
each device that should receive alerts.

Apple documents this platform requirement in
[Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

## Remote Access And Accounts

The local agent always remains on the Altitude PC. In remote mode it connects
outbound to the relay; no local IVAO-facing port is published.

After an invite-only registration:

1. save the agent token shown once;
2. configure it on the simulator PC with `npm.cmd run setup -- agent`;
3. restart the proxy;
4. sign in to the hosted app from each trusted browser;
5. select the intended simulator PC if the account has more than one agent;
6. enable notifications separately where required.

In **Settings > Remote**, a logged-in pilot can inspect the selected agent,
relay and pairing state, rotate the agent token, list browser sessions, log out
other devices, and change the account password. Rotating the agent token
requires updating `config.json` on the simulator PC before it can reconnect.

If the password is lost, ask the server owner for a one-use recovery code, open
the **Recover** tab on the hosted login page, and choose a new password. Recovery
revokes older browser sessions but does not rotate the agent token.

Manual-token relays use the relay token plus the short-lived pairing code
printed by the local agent. Use **Renew Pairing Code** if it expires and
**Forget Pairing** before handing a browser device to someone else.

A server may enforce a minimum Local version after a protocol or security
change. An agent below that minimum is not registered as online until it is
updated and restarted; a recommended-only mismatch does not interrupt the
flight.

## Settings Reference

- **Audio**: microphone, output and Web TX state, TX sample rate, RX test, and
  TX monitor.
- **Connection**: proxy, Altitude/FSD, simulator address, callsign, flight plan,
  voice server, and heartbeat.
- **Remote**: account/manual-relay login, selected agent, pairing, sessions,
  password, and token controls.
- **Notifications**: support, permission, saved subscriptions, enable/disable,
  online confirmation, and PC/proxy offline alert.
- **About**: version, license, source, and privacy summary.

Settings is a scroll-contained modal. Scrolling inside it must not move the
workspace behind it.

## End A Flight

1. Release browser PTT and confirm no **ON AIR** control remains active.
2. Stop or cancel any timer you no longer need.
3. Disconnect from IVAO normally.
4. A stationary disconnect at no more than five knots is intentionally silent;
   a moving or unknown-state disconnect remains eligible for an alert.
5. Close VoxHF or stop the proxy when finished. This clears current-session
   chat and timers but keeps device notification subscriptions for the next
   proxy session.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `Proxy unavailable` | Start `start.bat`; confirm port 3000 is not used by another process. |
| Altitude/FSD remains offline | Use the IPv4 printed by VoxHF as PilotUI's Simulator Address, then reconnect Altitude. |
| iPhone/iPad shows RX but is silent | Tap the RX activation prompt; then use **Settings > Audio > Test RX**. Return the app to foreground if iOS suspended it. |
| Desktop hears RX but mobile does not | Check the mobile prompt, system volume/output route, foreground state, and Test RX before restarting the proxy. |
| Web TX says waiting | Join a voice channel and press Altitude's real PTT once; then allow microphone permission. |
| No microphone permission prompt | Check the browser/site microphone permission and use **Monitor TX**. |
| Unrelated frequency chat is visible | Confirm the page loaded the latest `app.js`; refresh once after a webapp update. |
| Notifications say unsupported on iOS | Open the HTTPS app from its Home Screen icon, not a normal Safari tab. |
| Notification permission is denied | Re-enable VoxHF in the operating system's notification settings. |
| Remote agent is offline | Check the proxy console, relay URL/token, internet access, and **Settings > Remote > Check Remote**. |
| Private-tab `X` appears to remove messages | Open **All** or **Private**; the `X` closes only that peer tab. |
| METAR/TAF is cut off on a phone | Scroll the Route weather panel/page; use the command form as a fallback. |

For repeatable diagnostics and automated tests, use
[Development](DEVELOPMENT.md). Report security issues through
[SECURITY.md](../SECURITY.md), not a public issue.
