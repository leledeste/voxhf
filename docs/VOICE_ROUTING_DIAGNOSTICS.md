# TS2 Routing Validation

The old shared-address proxy let periodic FSD VOICE replies change its global
TS2 target while the pilot stayed on one channel. It also presented different
servers to Altitude as the same local address. Traces of SBAZ/SBBR and SKBS/SKED
showed existing UDP traffic being forwarded between regions without a new login.
Neither ignoring old DNS callbacks nor hiding the Ready/Not ready indicator
solved this. A browser COM filter was previously rejected because its state
can lag behind Altitude's selection.

The implemented correction gives every regional server a distinct stable local
loopback endpoint, shared by that server's channels. Discovery cannot change an
existing route. Only observed login traffic selects the browser RX/TX route;
old-route keepalives cannot select it. Endpoints are advertised only after both
TCP and UDP listeners bind. This does not decode or reconstruct login payloads.

`npm.cmd run ts2:test` tests DNS ordering, route isolation, cross-server return,
same-server changes, reconnects, stale callbacks, FSD ordering, endpoint failure,
and actual local loopback transports. `npm.cmd run voice-route:test` verifies
trace parity/privacy. Automated results do not establish audible RX/TX quality.

## Beta Validation Status

For 0.1.2-beta.3, live testing confirmed initial joins, same-server channel
changes with audible browser RX/TX, and stable Web TX readiness. A subsequent
LFLL_TWR -> DAAA_NW_CTR -> LFLL_TWR -> DAAA_NW_CTR trace confirmed switches
between two distinct regional servers and return to the previous server.
Periodic discovery did not retarget the active connection; readiness resets
coincided with actual voice connection changes.

A further live test switched from 118.700 MHz on the eu-west-2 server to
127.525 MHz on sa-east-1 and back. The tester confirmed audible browser RX
and successful TX heard by the other party on both frequencies, with no
repeated indicator flicker. The trace confirms regional server changes and
readiness recovery only at the actual switches. Cross-server browser audio
is therefore live-validated for this tested sequence, not merely inferred
from the Ready indicator.

The tester also confirmed successful TX before and after an explicit IVAO
disconnect, a wait of a few seconds, and reconnect, without ever closing the
proxy. The receiving party heard the renewed transmission clearly. This
validates TX recovery across an IVAO session restart with the same proxy
process. RX was confirmed in the channel tests above, but was not separately
reported after this disconnect/reconnect sequence.

The Windows loopback smoke test passes with automatically selected or loopback
source addresses. An explicitly LAN-bound UDP source failed a separate probe.
The live traces used a loopback source successfully. If another Altitude setup
binds its voice socket to a LAN address, investigate compatibility; do
not change the firewall or interface settings to work around it. A printed
`Ready: derived TS2 session acquired` is not server confirmation or an RX test.

## Capture Two Controlled Sequences

Do this outside an important flight. No VPS update is needed. Stop the existing
proxy, fully close PilotCore/Altitude to clear old shared-address destinations,
and use the updated local source folder. Run in PowerShell:

```powershell
cd C:\Users\YourName\VoxHF
node .\proxy.js --trace-voice-routing
```

1. Start the proxy before connecting Altitude. Confirm `[ROUTE] ... enabled`.
2. Join an available controller and remain on it for about 60 seconds. Expect
   `[TS2] Endpoint <host> -> 127.x.x.x:8767` and an active-server line. Discovery
   replies must not cause UDP closes or readiness resets. Confirm actual RX in
   Altitude and the browser; merely displaying a tuned COM is insufficient.
3. If practical, change manually to a station on another TS2 hostname, wait
   until Altitude reports the channel connected, then return to the first.
   Note the selected station and approximate elapsed time at each change.
   Also test a same-server channel change and an IVAO disconnect/reconnect.
4. Do not generate unnecessary transmissions on operational frequencies.
   Only test TX with a cooperating listener/controller when appropriate.
5. Share the `[ROUTE]` lines and the action timeline, plus whether RX/TX failed.
   Do not share the full console, pairing codes, account tokens, or config.json.
6. Stop the proxy when finished. Next time use the normal launcher without the
   diagnostic flag. The flag does not persist in configuration.

Other stations can replace the named examples. Include their names and which
channel Altitude actually showed; the COM display alone is not proof of a voice
connection. Connecting to another frequency may affect the flight: coordinate
the test rather than leaving an assigned controller unexpectedly.

## What The Trace Contains

- Relative time since startup, FSD VOICE queries/replies, and hostname changes.
- Observed COM updates (context only, not authoritative channel selection).
- TCP open/close and UDP route creation/cleanup, with process-local stream IDs.
- For UDP creation, `port` is Altitude's source port, not the destination port.
- At most 24 distinct metadata shapes per stream: direction, byte count,
  TS2 class/subtype, or a validated PilotCore frame's type when available.
- `hints` lists only ATC names already learned from VOICE replies and found in
  the first 4096 bytes of a non-voice chunk. A hint is not a decoded join command.

The trace prints no packet body, hex/ascii dump, session-header identifier,
password, token, pilot identity, chat text, or audio. Known TS2 voice datagrams
are skipped. It creates no files and sends nothing to the relay or browsers.
The flag suppresses the older `voiceDiagnostics` raw logging for that process
without editing config.json. Other normal console messages remain present.

Output stops after 10 minutes or 1200 event lines (plus one limit notice);
station matching is bounded to 128 learned ATC names. Timing, de-duplication,
chunk boundaries, limits, and opaque payloads mean an absent hint does not prove
that no channel change happened. Restart explicitly if another trace is needed.

## Acceptance And Failure Reporting

Require real initial joins, same-server and cross-server changes, return to the
first server, native Altitude RX/TX, browser RX/TX, and reconnect recovery. One
brief Not ready period during a real reconnect is expected; repeating changes
caused only by discovery are not. Verify local and remote browsers; the relay
and hosted files do not need an update for this local-agent change.

If an endpoint is printed but no UDP login follows, record the selected station
and share the bounded trace. This may indicate incompatible client binding or
cached destinations, not a browser autoplay problem. Do not publish config,
pairing codes, raw packets, session bytes, or audio. Keep any uncompleted checks
explicit in the beta validation status; do not claim full validation until all
of the live checks pass.
