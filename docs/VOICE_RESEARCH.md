# Voice Integration Research

This note preserves the evidence, open questions, and product decisions needed
for two related projects:

1. native access to IVAO Voice UNICOM from the VoxHF browser workspace;
2. a managed live listening page for IVAO frequencies, conceptually similar to
   `listen.vatsim.net`.

It records investigation rather than released behavior. User-facing behavior
remains documented in the [User Guide](USER_GUIDE.md), and planned work remains
summarized in the [Roadmap](ROADMAP.md).

## 1. IVAO Voice UNICOM

### Objective

Let a VoxHF browser receive and transmit on the official IVAO Voice UNICOM
service at `122.800`, while IVAO continues to own propagation, attenuation,
terrain effects, blocking, and collision behavior. VoxHF must not create a
parallel UNICOM network or implement a separate propagation engine.

This is distinct from automatic or synthesized UNICOM reports. The objective is
manual live voice controlled by the pilot.

### Confirmed Service Behavior

IVAO documentation confirms that Voice UNICOM:

- operates on `122.800`;
- was released for Altitude 1.12 on 11 November 2022;
- is separate from the legacy TS2 ATC voice path;
- determines reception using relative distance, relative altitude, and
  terrain/obstacles;
- applies attenuation and models reflection/diffraction;
- can produce asymmetric reachability between stations;
- applies blocking/collision behavior per receiver.

The server, not VoxHF, should remain responsible for those radio effects.

### Evidence From The Installed Altitude Client

The inspected installation uses Altitude/PilotCore `1.13.0.33`. Existing local
PilotCore logs repeatedly show this sequence:

```text
Received IVAO Use Voice: 1
Setting COM 1 = 122800
IVAOVoice: connecting to 145.239.4.81:6900
IVAOVoice: Connected
```

The observed service endpoint was UDP `145.239.4.81:6900`. The IP address must
not be hard-coded in VoxHF: it may be assigned dynamically or change after an
IVAO infrastructure update.

Static inspection of the installed PilotCore executable found:

- separate `IVAOAudioProtocol` and `TS2AudioProtocol` implementations;
- an Asio UDP transport;
- Opus and Speex codec dependencies;
- an 8 kHz mono audio pipeline split into 20 ms frames;
- MessagePack support elsewhere in PilotCore;
- a pinned public signature key and explicit server-signature validation;
- explicit errors for invalid payload size, invalid server signature, packet
  decryption failure, connection timeout, and acknowledgement timeout;
- local radio attenuation values such as `Radio VHF1 RX attenuation -74 dB`;
- local PilotUI events for voice connection, TX, RX, and emitting stations.

The strongest current hypothesis is that TS2 uses Speex and IVAO Voice uses
Opus. MessagePack may carry Voice control messages. Both hypotheses require a
live packet capture before implementation.

### Current VoxHF Gap

VoxHF currently rewrites FSD `VOICE` replies and proxies legacy TS2 TCP/UDP on
port `8767`. That path does not observe the UDP `6900` IVAO Voice session.

A transparent UDP forwarder alone is unlikely to expose usable PCM. PilotCore
validates the server signature and reports encrypted payloads, so a forwarding
proxy can observe timing and packet boundaries but probably cannot decode RX or
replace TX without owning the authenticated Voice session.

### Preferred Implementation Direction

The preferred outcome is a first-class implementation of the official IVAO
Voice client protocol inside the local agent:

- keep signature verification and encrypted transport intact;
- let VoxHF own one official Voice session;
- disable PilotCore's duplicate IVAO Voice connection for that session;
- retain the existing TS2 path for ATC until IVAO retires it;
- route only official Voice UNICOM RX/TX through the new module;
- reuse the existing browser PCM transport, iOS activation behavior, PTT
  ownership, relay validation, and disconnect safety boundaries;
- never send Voice credentials, session keys, raw packets, or audio recordings
  to the relay or persistent storage.

Do not implement this by modifying the Altitude executable, bypassing its
signature checks, or placing normal IVAO credentials in the browser.

### Required Live Discovery

Before writing the production module, perform a capture restricted to UDP port
`6900` across these phases:

1. start capture before the IVAO connection;
2. connect with Voice enabled;
3. tune COM1 to `122.800`;
4. press and release the native PTT once without speech;
5. transmit a short spoken test when operationally appropriate;
6. receive another nearby pilot if available;
7. change between UNICOM and a TS2 ATC frequency;
8. disconnect normally;
9. repeat once after a forced Voice reconnect.

The capture must determine:

- how the Voice endpoint is discovered;
- handshake and key-exchange order;
- client and server acknowledgement messages;
- keepalive timing and reconnect behavior;
- session and callsign binding;
- packet types for position/frequency, PTT start, audio, PTT stop, attenuation,
  blocking, and disconnect;
- whether audio uses Opus and the exact profile/frame format;
- whether MessagePack belongs to the Voice transport;
- whether one authenticated session can receive both radios.

Do not retain or share a full FSD capture because it may contain authentication
material. Add a temporary local diagnostic that reports only whether the Voice
endpoint was present in the FSD stream, without logging the surrounding payload.

### Approval And Compatibility Gate

No public Voice protocol specification was found in IVAO's public API
documentation. Before shipping a third-party Voice client, request an official
integration path or written confirmation from IVAO Development Operations.
Protocol discovery can establish feasibility, but it does not itself grant
permission to operate a new client on the production network.

## 2. Public IVAO Frequency Listening

### Objective

Add a page to the VoxHF public site where a visitor can select an online IVAO
station and listen to its live operational frequency. The page should be
live-only, should not create recordings or transcripts, and should clearly show
whether a feed is official, community-provided, degraded, or unavailable.

### Why The VATSIM Example Is Different

The current `listen.vatsim.net` surface is an authenticated, centrally managed
service. Its interface exposes global listener limits, a kill switch, per-user
listen limits, and load protection tied to the number of online Audio for
VATSIM users. Audio for VATSIM is a centralized radio service that allows a
client to select receive transceivers rather than joining a legacy voice room.

IVAO ATC voice currently uses TS2 servers and one channel per controller
position. A normal pilot connection follows one active channel. A single normal
IVAO account is not a clean or scalable way to join many channels, and IVAO's
general connection rules normally prohibit multiple simultaneous network
connections except for defined staff or organizational-account cases.

IVAO also plans to retire TS2 in favor of its newer Voice Server platform.
Building a permanent public service around a farm of legacy TS2 clients would
therefore be fragile even if the account and privacy questions were resolved.

### Feasibility Options

#### A. Official IVAO Listener Integration — Recommended

Request one of the following from IVAO:

- a read-only Voice listener API;
- a server-side live feed for public ATC positions;
- organizational/service identities explicitly allowed to monitor multiple
  public frequencies;
- documentation for creating receive-only transceivers on the new Voice
  Server platform.

VoxHF would run a bounded number of regional ingest workers. Each source stream
would be received once, encoded once, and fanned out to browser listeners. A
browser listener must never create an additional TS2/Voice connection.

This is the only route that can offer predictable coverage without depending on
which VoxHF pilots happen to be online.

#### B. Opt-In Community Coverage — Feasible Prototype, Incomplete Coverage

A VoxHF user could explicitly donate the RX audio they are already receiving.
This cannot make an uncovered frequency available, but it can avoid duplicate
streams through a server-side lease:

```text
VoxHF agents already in a channel
              |
              v
    one elected primary source
       plus one warm standby
              |
              v
       live Opus contribution
              |
              v
      authenticated fan-out
              |
              v
         web listeners
```

For every `{TS2 server, channel}` key, the relay would:

1. accept opt-in source offers;
2. elect one healthy primary source based on latency and packet continuity;
3. keep at most one standby without forwarding duplicate audio;
4. switch sources after a short grace period if the primary leaves;
5. mark the station unavailable when no contributor remains;
6. discard audio immediately after live delivery.

The public page would display **Community feed** and an explicit coverage state.
It must never imply complete IVAO coverage.

This design still needs IVAO permission because it rebroadcasts the voices of
controllers and pilots who may not use VoxHF and did not individually opt into
the public stream.

#### C. Dedicated TS2 Bot Farm — Do Not Build Without IVAO Authorization

Joining every active controller channel would require many concurrent voice
sessions across several TS2 regions. Normal user accounts are unsuitable, the
number of connections scales with active positions, and the design would add
load to infrastructure that IVAO intends to retire.

Only consider this if IVAO supplies organizational accounts, connection limits,
and explicit public-streaming authorization. Even then it should be treated as
a temporary bridge to the new Voice Server platform.

#### D. Local Personal Monitor

VoxHF already lets a user's paired browsers hear the channel selected by that
user's Altitude session. This remains the correct private fallback and should
not be presented as a public listening service.

### Recommended Product Sequence

1. Write a short integration proposal for IVAO Development Operations covering
   purpose, live-only handling, expected audience, load limits, and takedown.
2. Ask whether the upcoming Voice Server platform can provide read-only
   transceivers or a managed listener feed.
3. Obtain explicit rules for public rebroadcasting, identity display, minors,
   retention, and incident response.
4. If IVAO authorizes only a prototype, build opt-in community coverage behind
   authenticated VoxHF accounts, not an anonymous public page.
5. Add one-source-per-channel election, a global kill switch, per-user limits,
   and regional load limits before widening access.
6. Move to an official server-side feed as soon as it exists; do not make the
   TS2 contribution protocol a permanent public API.

### Privacy, Safety, And Operations Gates

The listening service must not launch until all of these are resolved:

- written authorization to rebroadcast IVAO operational voice;
- a lawful and clearly published privacy basis;
- no private, exam, coordination, intercom, or password-protected channels;
- an allowlist built from confirmed public ATC positions;
- no recording, replay, download, transcription, or persistent audio cache;
- source and listener authentication during the initial release;
- per-user, per-station, and global concurrency limits;
- a global disable switch and immediate station-level takedown;
- abuse reporting and operator contact;
- bounded in-memory jitter buffers only;
- no IVAO credentials or TS2 session material in browsers, logs, or SQLite;
- clear labels for coverage source and availability;
- load shedding that protects the operational relay and IVAO services;
- a separate threat-model and privacy review before public exposure.

### Open Product Questions

- Should listening require an IVAO/VoxHF login or eventually allow anonymous
  access?
- Should a small safety delay be applied to the public stream?
- Is controller-only audio technically separable and desirable, or must the
  operational exchange remain complete?
- Which stations, regions, and languages should an initial pilot cover?
- Should contributors see and be able to revoke their active source lease?
- What status and attribution does IVAO require on the listening page?
- Can the service continue to exist after IVAO moves ATC voice away from TS2?

## Sources

- [IVAO Voice 2.0](https://voice.ivao.aero/)
- [IVAO Altitude changelog](https://virtualsky.ivao.aero/changelog/)
- [IVAO Voice UNICOM guide](https://storage.ivao.fr/training_public/VoiceUnicom_IVAOFR.pdf)
- [IVAO future voice plans](https://virtualsky.ivao.aero/plans-for-the-future/)
- [IVAO API documentation](https://api.ivao.aero/docs)
- [IVAO Rules and Regulations](https://ivao.aero/rulregs/default.asp)
- [Listen to VATSIM](https://listen.vatsim.net/)
- [Audio for VATSIM user guide](https://downloads.vacc-austria.org/Documents/VATSIM_AFV_User_Guide.pdf)

