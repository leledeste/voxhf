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

Browser voice currently covers TS2 ATC channels. Official IVAO Voice UNICOM is
not yet supported in VoxHF; use Altitude for UNICOM voice. UNICOM text and the
three-minute reminder remain available.

RX is enabled by default. When decoded voice reaches the browser, the **RX**
indicator in the top bar lights up. More than one connected browser can listen
at the same time.

Select the **speaker icon** beside the Radios title to silence this page when
listening through Altitude instead. The icon turns red with a diagonal slash;
select it again to unmute. Its tooltip and accessible label describe the action,
and the top-bar Audio caption becomes **Muted**. RX activity remains visible. Browser TX, radio
tuning, chat, Push notifications, Altitude audio, and other browser devices are
unaffected. The choice lasts only for this page: refreshing restores audible RX.
Audio received while muted is discarded, not replayed when unmuting. RX test
tones and received monitor playback are also silent until you unmute.

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

If the page is muted, select the crossed-out speaker before testing. Unmuting can also
provide the trusted gesture needed by iOS; it does not bypass browser policy.

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
- **For you**: received private messages and public messages beginning with your
  active callsign, subject to the same frequency visibility rules;
- **System**: local status, weather-request acknowledgements, and server/system
  messages.

An incoming private message creates a callsign tab. Closing that tab with its
`X` hides the conversation tab but does not delete its messages from **All**;
received messages also remain in **For you**. Closing the active private tab
opens **For you**, or **All** if For you is hidden. Opening the callsign again restores the retained conversation,
including sent replies. To reply privately, open that callsign tab or explicitly
choose the recipient: **For you** is only a history filter, not a send destination.

Incoming frequency and broadcast messages beginning with your active callsign
receive a subtle amber accent and a **For you** label, distinct from your teal
outgoing messages. Matching ignores case and leading whitespace, but requires
the complete callsign: `RYR12` does not
match `RYR123`. Mentions later in the text, sent messages, and private messages
do not receive this extra highlight. Frequency visibility rules still apply.
This works without notification permission, including recovered history; if
your active callsign changes, the highlights are recalculated for that callsign.

### Organize Chat Tabs

Drag tabs with a mouse to change their order, including the built-in filters.
On touch screens, hold a tab still for about **400 ms** until it is highlighted,
then drag it to the insertion marker and release. A quick tap still selects;
swiping before the hold completes scrolls normally. Holding near an edge while
dragging scrolls the strip. The X is excluded, and multi-finger/cancelled gestures
do not reorder. **Settings > Chat** also provides up/down arrows for touch and
keyboard users to move a tab earlier/later in the strip. New private tabs
appear at the end; reopening a hidden tab retains its previous place.

Settings lets you hide **Frequency**, **For you**, and **System**; **All** always
remains available. Hiding the active filter returns to All without changing the
public recipient or draft. Moving tabs never changes the active conversation,
recipient, draft, unread count, or message reading position.

The **X** on a private tab only hides it: it does not delete any messages or
its unsent draft. You can also press Delete while the private tab has keyboard
focus. Reopen it with `.chat CALLSIGN` or **Show** in Settings > Chat. A new
incoming private message makes it reappear without selecting it. Old recovered
history does not undo hiding; a newer received message recovered after an
absence can reveal it. Closing a tab does not disable its Push notifications.

Order and visibility are saved in this browser and survive page refresh,
browser reopening, and proxy restart. Local mode and each remote
relay/account/selected-agent combination have separate preferences; they do
not synchronize to another browser or device. Up to 200 private-tab identifiers
are retained, without message contents or drafts. Clearing site data removes
these preferences. If browser storage is unavailable, Settings warns that the
layout only lasts for the current page.

This does not extend message or draft retention: a proxy restart still clears
session history, and a page refresh still clears unsent drafts. A saved private
tab can therefore reopen with no messages after a proxy restart.

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

### Unsent Drafts

Each private callsign has its own draft. UNICOM / frequency, Broadcast, and
Custom each have a separate draft too. Switching between All, Frequency,
For you, and System changes the history filter, not the current recipient or
its draft. Closing a private tab keeps its draft for when you reopen that
callsign. Returning from a private tab also restores the previous public
recipient choice. Changing COM frequencies does not retarget the composer:
UNICOM / frequency still sends to `122.800`.

For example, write a traffic report without sending it, open a private callsign
tab and start a reply, then return to All: the traffic report is still there.
Submitting one draft does not clear the others. Cancelling Custom or trying to
send while the transport is unavailable keeps the text. Custom asks for the
destination at send time; it is one draft for that selector mode, not a separate
draft for every destination entered in the prompt.

Drafts stay in memory in the current browser page, isolated by selected remote
agent and account. Reconnecting the same agent keeps them, but refreshing or
closing the page clears them. They are not synchronized across devices or stored
by the proxy, relay, or account. This differs from session history below.
A submitted draft clears when the browser passes it to its connection, not
after confirmation from IVAO; a later delivery error does not restore it.

### Session History

Chat follows new messages while you are at or near the bottom. Scroll up to
read earlier messages without being pulled back down by incoming traffic;
scroll to the bottom to resume following. Selecting a different chat tab opens
its latest messages.

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

Both METAR and TAF interpretation support wind in knots or metres per second.
For example, `12007MPS` is wind from 120 degrees at 7 m/s (about 14 kt);
gusts are converted separately. Visibility `1 1/2SM` remains one and a half
statute miles, `M1/4SM` means less than a quarter mile, and `0000` means less
than 50 metres. Corrected METAR/SPECI and amended/corrected TAF headers are
recognized. Unknown groups remain under **Not interpreted**; supplementary
`RMK` text stays together under **Remarks**.

For an airport outside the flight plan, use `.metar`, `.taf`, or `.atis` in the
message box.

### METAR And TAF Chat Tabs

A successful `.metar ICAO` (or `.wx ICAO`) request opens/selects the single
**METAR** tab; `.taf ICAO` does the same for **TAF**. New reports append to that
tab's retained session history, including reports for different airports.
Closing with X only hides the tab. The next explicit request reopens it in its
saved position without deleting earlier reports or creating another tab.

If you close the tab or select another chat while waiting, the reply makes the
weather tab visible and marks it unread but never switches your active chat.
Old recovered history respects saved hiding, as with other tabs. Both local
and remote weather replies are system messages, visible in All/System and their
weather tab, not private messages in For you. The weather composer accepts
commands rather than sending ordinary text to the METAR/TAF service identity.

Requests made with **Route weather** card buttons remain in that panel and do
not select a chat. No automatic weather polling or additional permanent history
is introduced; stopping the proxy still clears its bounded session history.

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
- **Chat**: reorder tabs and show/hide filters and conversations; layout is
  saved in this browser, not synchronized to other devices.
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
| Private-tab `X` appears to remove messages | Open **All** for the full history or **For you** for received private messages; `X` closes only that peer tab. |
| METAR/TAF is cut off on a phone | Scroll the Route weather panel/page; use the command form as a fallback. |

For repeatable diagnostics and automated tests, use
[Development](DEVELOPMENT.md). Report security issues through
[SECURITY.md](../SECURITY.md), not a public issue.
