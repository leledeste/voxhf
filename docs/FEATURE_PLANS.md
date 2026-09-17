# Planned Flight And Communication Features

Design notes from the product discussions, updated on 2026-09-17.
These are future features and preserved decisions. Implemented baselines are
marked with their release version; use the User Guide for current operation.
The [Roadmap](ROADMAP.md) is the overview; this document preserves decisions,
alternatives, constraints, and open questions. A proposal is not a commitment
to a release date. Existing runtime behavior remains the source of truth.

## Private Chat Aliases

Current direction: friend names associated with VID, integrated with private
chat. See [Friends, Identity And Presence](#friends-identity-and-presence) for
the agreed flow and refresh settings. This supersedes the earlier proposal to
use a session-only callsign-to-alias map as the main identity mechanism.

Retained UI constraints: keep the real callsign visible beside the alias,
for example `Antonio · ITY123`; narrow tabs may truncate the alias, but the
conversation header should expose the full label. Never rewrite message
bodies or original sender/recipient metadata, or relabel historical messages
solely from today's callsign ownership. Initially leave Push labels unchanged.

Earlier interaction ideas remain alternatives, not additional required flows:
`Rename chat` in a custom tab context menu and an overflow button usable on
mobile, with Cancel/Save/Reset name. Preserve the native context menu in message
text, do not require long presses, and dismiss menus on Escape/outside click.
A 32-character trimmed, plain-text name with accented characters supported was
proposed. Empty-name/reset behavior and standalone session-only aliases for
non-friends still need a decision; resetting a label must not silently delete
a friend. These older ideas must not override the Add friend flow below.

## Friends, Identity And Presence

Planning only; not implemented. Decisions recorded on 2026-09-16.

### Identity And Data Source

- Identify a friend by IVAO VID, not callsign. Each user's chosen alias is
  private to their own address book, not a public name or a reciprocal friend
  request. A future callsign change must not lose the friend association.
- Candidate source, inspected during planning: the public
  [IVAO Whazzup feed](https://api.ivao.aero/v2/tracker/whazzup). Pilot entries
  expose `userId` (VID) and `callsign`, with a top-level `updatedAt` timestamp.
  The feed also separates ATC, observer, and follow-me clients. Verify the
  current schema and applicable API usage terms again before implementation.
- The feed supplies online session mappings, not a complete member directory
  or a guaranteed current callsign for an offline VID. A saved alias such as
  Antonio is user-entered, not a real name inferred from the feed.
- Callsign reuse must never transfer a friend's name to a different VID.
  Multiple sessions or conflicting mappings must be handled explicitly, not
  resolved by taking the first match. VID lookup is directory information,
  not authentication or proof of ownership.

### Add Friend From A Private Chat

1. `.chat ITY123` opens the existing private conversation normally.
2. Show `Add friend` in the conversation header, not as a history message.
3. On click, resolve the callsign against fresh presence data and open a custom
   dialog containing read-only callsign and VID, an editable `Name` field,
   and `Cancel` / `Add friend` actions.
4. Save only after confirmation of the name. Cancelling creates no contact.
5. Display `Antonio · ITY123`; replace the add action with `Edit name` or an
   equivalent compact menu. If the VID is already saved, use the existing
   contact instead of creating a duplicate.

Use an accessible dialog with focus handling, Enter/Escape support, and a layout
that works with the mobile keyboard. Render names as text, never HTML. Exclude
built-in filters and service identities such as SERVER from Add friend.
Missing, stale, or ambiguous identity data must produce an explanatory state,
not a guessed association. An old chat must not silently add the current user
of a recycled callsign as though they were the original correspondent.

### Online Friends And Chat Shortcuts

- Show friends' online status and current callsigns, for example
  `Antonio · ITY123 · Online`, with a one-click action to open the private chat.
- Support `.chat Antonio` by resolving the saved alias to VID and then its
  current online callsign. Keep `.chat CALLSIGN` working.
- Opening a chat never sends a message automatically. If the friend is offline
  or the mapping is not fresh enough, explain why it cannot be resolved; do not
  silently fall back to their last callsign.
- Duplicate names require a choice. Alias/callsign collisions also need
  explicit disambiguation rather than silently selecting a recipient.
- Keep existing conversations and drafts separate; do not merge histories or
  silently retarget an already open composer when somebody changes callsign.
  Check mapping freshness when opening from a friend shortcut. Define the
  remaining identity-change handling before implementing message submission.

### Shared Feed And Refresh Settings

| Mode | Default | Allowed intervals | Setting owner |
| --- | --- | --- | --- |
| Local-only | 30 seconds | 15 seconds, 30 seconds, 1 minute | Local user in Settings |
| Hosted or self-hosted relay | 15 seconds | 15 seconds, 30 seconds, 1 minute | Server administrator ("server master") |

- In local-only mode, one proxy fetches the feed for all of its browsers.
  Persist the interval in proxy configuration, not a separate browser setting.
- In remote mode, fetch once per relay deployment and share its in-memory
  presence cache across users. Do not fetch once per friend, user, device, or
  browser. Each self-hosted relay owns its own cache. Future multi-process
  hosting needs a single coordinated poller rather than one per worker.
- Remote users see the effective interval read-only with
  `Managed by your server administrator`. Keep the local preference separately
  so switching modes does not overwrite it. Define mode selection explicitly
  when local and remote browsers use the same agent; avoid duplicate pollers.
- Supply directory updates through validated, typed interfaces. The browser
  must not query IVAO directly. Chat submission still uses the local proxy and
  existing IVAO connection; the relay does not send IVAO messages itself.
- These are normal refresh intervals, not guaranteed real-time presence.
  IVAO's [Whazzup announcement](https://virtualsky.ivao.aero/ivao-introduces-a-refreshed-whazzup-api/)
  described a 15-second source refresh; it is not a verified request-rate
  allowance. Honor current service limits and server retry instructions.
- Suspend polling when the feature has no active consumers; define this
  lifecycle before implementation. Reuse the cache on clicks instead of
  issuing a separate download for each action. Prevent overlapping requests.
- On failures/rate limits, back off and respect `Retry-After` when provided.
  Treat stale or unavailable data as unknown, not proof that every friend went
  offline. Retain source/fetch timestamps; use conditional requests if supported.

### Storage, Boundaries And Open Decisions

Keep only necessary public presence fields in bounded memory: VID, callsign,
client/session identity where needed, and timestamps. This feature does not
require storing positions, routes, flight plans, or a historical online log.
Friend lists must remain private and isolated across accounts; the shared
public feed cache must not expose another user's contacts or chosen aliases.

Proposed storage: persistent account-scoped contacts for remote users and a
local private file for account-free use. This was discussed as the natural
extension of friends, but exact persistence, synchronization, migration between
modes, removal/export behavior, limits, and simultaneous-edit policy still need
confirmation. Persistence of contacts does not authorize persistent chat
history: chat remains bounded proxy-session memory. Never publish a save as
successful before its authoritative owner confirms it; retain input on failure.

Also settle the friends-list placement, offline ordering, case/accent handling
in alias matching, name validation, stale-data threshold, multi-session choices,
and how historical chat identity is captured when the feed is unavailable.
Do not automatically subscribe users to new friend-online Push notifications;
those were not requested.

### Implementation Checks

Cover add/cancel/edit/duplicate-VID flows, alias collisions, unknown/offline and
reused callsigns, multiple sessions, identity changes with an open draft, stale
feeds, network failures and rate limits, polling defaults/permissions and
mode transitions, and one shared fetch with multiple users/browsers. Test
account isolation, local operation without an account, typed protocol validation,
and desktop/mobile dialog behavior. Do not alter voice routing or recording.

## Chat Tab Ordering

Implemented in 0.1.2-beta.4: mouse drag-and-drop and a 400 ms touch
hold followed by dragging on the tab strip, with earlier/later arrow buttons
in Settings > Chat as an accessible alternative. Quick swipes keep normal
scrolling; drag mode shows the source and insertion edge and scrolls at strip
edges. X, multi-touch, cancellation, and standby must not reorder. Live arrivals
update the model without replacing touched tab nodes until the gesture ends.
Built-in filters and private tabs share one order; new private tabs append,
and reopened tabs retain their place. Reordering does not change the active
conversation, recipient, draft, unread state, or history.

All is always available; Frequency, For you, and System may be hidden from
Settings. A private tab's X means hide, never delete. Settings can show it
again; `.chat CALLSIGN` explicitly reopens it. New received messages reveal
hidden peers without changing the active conversation; replaying old history
does not. Closing the active private tab opens For you, or All if For you is
hidden. Delete on a focused private tab is the keyboard equivalent of X.

The user explicitly requested persistence across proxy restarts. Browser-local
preferences store order and visibility separately for local mode and each
remote relay/account/agent scope, including up to 200 private-tab identifiers
and hide timestamp watermarks. They survive refresh/restart but are not shared
across browsers. Message bodies and drafts are never stored with the layout.
If browser storage fails, changes still work in memory and Settings explains
that they will not survive refresh. See the
[user guide](USER_GUIDE.md#organize-chat-tabs) for operating details.

### Weather Tab Reuse

Implemented in 0.1.2-beta.4: one METAR and one TAF tab reuse the existing shortcut
model without treating weather as private messages. Explicit successful command
requests reopen and select their tab in its saved position; results append to
bounded session history. X never clears the reports. A late response reveals
the tab with unread state but does not select it. Route weather requests stay
panel-only. There is no per-request tab, destructive close, or persistent
weather history. See [weather tabs](USER_GUIDE.md#metar-and-taf-chat-tabs).

## Per-Conversation Drafts

Implemented in 0.1.2-beta.4: page-memory drafts per private callsign
and per public recipient mode, isolated by remote agent and account. Closing
tabs and transport reconnects preserve them; refresh clears them. History
filters do not create separate drafts and COM changes do not retarget the
UNICOM composer. Only the submitted draft clears, including when `.chat`
opens another conversation. Custom cancellation and synchronous send failure
retain input; there is no end-to-end delivery acknowledgement.
See [Unsent Drafts](USER_GUIDE.md#unsent-drafts) for operation and limitations.

Future decisions: refresh survival, proxy-session synchronization with
simultaneous editing, and drafts per explicitly chosen custom destination.
Do not assume account persistence or cross-device draft replacement. No
automatic sending, permanent message storage, or credential autofill.

## Addressed Messages And For You Filter

Implemented in 0.1.2-beta.4: subtle highlighting in normal chat plus
a For you filter replacing the aggregate Private tab. Settings > Chat can hide
the filter; there is no separate highlight switch.

- Highlight incoming public messages addressed to the active callsign with a
  pale amber background, an amber border and a `For you` label, distinct from
  teal outgoing messages.
  No flashing; do not rely on color alone. Avoid highlighting every private
  message identically, since private messages already have a clear destination.
- Reuse the notification callsign-prefix rule with proper callsign boundaries,
  so `RYR12` does not match `RYR123`. Do not silently broaden matching to every
  mention anywhere in a message. Preserve existing frequency visibility rules.
- The `For you` filter combines received private messages and addressed public
  messages, respecting frequency visibility. Sent replies remain in All and
  the individual private conversation, not in For you. It uses recovered history
  without notification permission. Closing the active private tab opens For you
  without deleting messages. Filtering does not change the send destination or
  create a separate draft. Do not call the view `Clearances`.
- Highlighting is a view of the active callsign, not a recorded arrival-time
  classification. Callsign changes recalculate visible highlights, including
  recovered history. Messages arriving before the callsign becomes known are
  evaluated when connection status supplies it. The same rule applies to which
  public messages appear in For you; received private history remains included.

## ATC Radio Names

The requested name is the spoken radio designation, not the operator's real
name. User examples: `EBBU_CTR — Brussels Control`, `EDDS_TWR — Stuttgart Tower`,
and `SBAZ_CTR — Amazonico Center`. These are examples, not a verified global map.

- Keep the station-selection dropdown unchanged: callsign and frequency only.
- Display the radio name for the connected position elsewhere in the radio
  panel, preferably as a secondary line while retaining callsign/frequency.
  Replacing the selected label was discussed, but final placement is not fixed.
- The current station model contains callsign, frequency, coordinates, and voice
  destination, but no radio-name field. Investigate data already delivered by
  Altitude, then documented IVAO data sources; do not infer names from suffixes
  or scrape WebEye merely because it displays them.
- Candidate source: [IVAO API documentation](https://api.ivao.aero/docs), which
  lists `GET /v2/ATCPositions/{callsign}`. The exact field, availability, access
  requirements, and reuse terms remain unverified; a schema fetch returned 403.
  Seeing a name in WebEye is not proof of unrestricted API access.
- Reuse fetched data within appropriate cache limits. Missing data must leave
  the existing callsign/frequency usable, without guessed names or blocked audio.

## ATC Contact Log

Accepted purpose: an easily copied list of controllers for flight reports such
as World Tour PIREPs. Suggested labels: `ATC log`, `Controllers contacted`, and
`Copy callsigns`; avoid `Contacted by`, which implies the opposite direction.

### Final Contact Rule

1. Associate the aircraft with the actual selected/connected ATC position.
2. Observe an outgoing voice transmission on that position from either Altitude
   or the webapp. Joining, keepalives, readiness, and local microphone tests do
   not count. Do not depend only on browser PTT events.
3. After that transmission, receive voice audio on the same position.
4. Add the position to the contact list, without duplicate callsigns.

The user explicitly accepts that the subsequent audio may be addressed to
someone else. Speaker identification, speech recognition, and proof that the
controller heard the pilot are not required. Audio received before the first
TX does not qualify. On position change, cancel the previous pending contact;
audio on the next position must never confirm the previous one. A new session
must not inherit pending TX/RX state from an old voice session.

This supersedes earlier proposals to count RX alone, count TX alone, or require
a manual confirmation tick. Manual add/remove remains a proposed correction
mechanism, including text-only contacts, rather than the normal qualification.

### Display And Scope

- No visible contact or connection timestamps: the user considers them
  unnecessary. Event ordering is sufficient; internal timestamps are optional,
  not a requested feature.
- Copy plain callsigns in first-qualifying-contact order, for example
  `LIML_TWR, LIMM_CTR, EBBU_CTR`. Returning to a controller must not duplicate it.
- Candidate placement: flight/cosciale tools with quick access near the radios,
  rather than a permanently expanded block. Layout is not yet decided.
- Define per-flight boundaries before implementation so multiple legs with the
  same running proxy do not silently share a report. Proposed storage is bounded
  proxy memory synchronized to browsers; reset/export behavior is still open.
  Do not introduce server-persisted flight history by default.

### Technical Checks

The existing proxy sees native Altitude TX and recognizes TS2 voice packet
classes. Web TX has a separate outgoing send path and needs an equivalent
event. Reuse these observations without recording audio or changing routing.
Server identity alone is insufficient: several positions share one TS2 server.
Validate position/channel association, especially same-server changes and stale
packets; uncertain association must not credit the previous controller.

Test native/browser TX, RX-before-TX, TX-then-RX, local monitor-only audio,
same-server/cross-server changes, reconnects, duplicate contacts, and copying.

## Live RX Speaker Identification

Accepted as future research, independent of the ATC contact rule above.

- Show `RX · EBBU_CTR` or `RX · RYR123` during a transmission, with a short
  inactivity grace period to avoid packet-by-packet flicker. Handle simultaneous
  speakers explicitly rather than assigning all audio to the most recent one.
- Fall back to ordinary RX when identity is missing or uncertain. The speaker's
  nickname/callsign is distinct from the tuned position's spoken radio name.
- VoxHF currently decodes audio without extracting a speaker or maintaining a
  participant directory. The [Wireshark TS2 dissector](https://github.com/wireshark/wireshark/blob/master/epan/dissectors/packet-teamspeak2.c)
  describes participant IDs, channel IDs, nicknames, and participant events.
  That does not yet prove which voice-packet field identifies the sender in
  Altitude traffic: a client ID could identify the receiving session.
- First verify the mapping with two known participants speaking alternately,
  then with channel changes, departures, reconnects, and overlapping speakers.
  Keep server/session-scoped participant state bounded and memory-only; clear
  stale identity mappings. Never infer the speaker from COM selection alone.
- No recording, transcription, raw credential logging, or modifications to the
  established audio path. Unknown metadata must not interrupt playback.

## Stale Data Indication

Accepted idea: a discreet warning when the UI is showing retained data after
updates stop, such as `Connection interrupted — showing last received data`.
Show update age when useful, not counters next to every unchanged field.

Separate an unchanged value from a stale source: a frequency unchanged for an
hour is not inherently stale. Base the warning on connection health and expected
updates. Distinguish relay connectivity from local-agent/Altitude availability.
For weather, separate report issue time from retrieval time: a new request does
not guarantee a newly issued report. Do not add automatic weather polling.

Open decisions: thresholds per data source, placement, and recovery behavior.

## Custom Checklists And Sharing

Accepted direction: customizable sections/items with tick boxes, account-based
templates for remote users, and an importable file for local-only operation.

- Separate reusable templates from the current flight's tick state. Editing or
  sharing a template must not disclose a user's flight progress or clear an
  active checklist without an explicit action.
- Proposed common exchange format: `*.voxhf-checklist.json`, containing title,
  sections, and items, not tokens, private flight data, or completed ticks.
  Import creates an editable copy; later author edits do not silently change it.
  Validate file schema, version, sizes, and plain-text content; no executable
  code, HTML, or automatic external resource fetching.
- Account users could save templates to their own profile. This introduces real
  server persistence and requires authorization, privacy documentation, and
  inclusion in account deletion. Local users must retain import/export without
  an account. Exact local template storage remains to be chosen.
- File sharing is the proposed first step. Shareable links can follow after
  deciding visibility, revocation, and access controls; no public gallery is
  assumed. Tick-state synchronization/lifetime also remains open.
- These are user-maintained aids, not replacements for aircraft procedures.
  Automatic aircraft detection and automatic flight-phase completion are not
  part of the first implementation.

## VoxHF Preflight Check

Discussed proposal, not an aircraft checklist and not yet prioritized.

- Present proxy reachability, Altitude connection, confirmed IVAO session, FPL
  availability, browser RX activation, microphone selection/permission, and
  notification permission/subscription as separate checks.
- Distinguish `configured`, `connected`, and `tested`. Neither Web TX ready nor
  microphone permission proves another pilot can hear you; Push permission
  alone does not prove delivery, and a running audio context is not audible RX
  confirmation.
- Optional active tests require explicit user action. Never send an automatic
  transmission to IVAO or silently enable microphone capture. The status view
  must help diagnose missing prerequisites, not promise everything works.

## Other Related Proposals

- **Browser RX mute (0.1.2-beta.4):** a compact speaker icon beside
  Radios silences only the current page, without disabling TX or Push. Muted
  state is red with a diagonal slash; tooltip and accessible label describe
  mute/unmute. No extra row is added to the radio panel. It stops
  queued RX sources and discards incoming PCM while muted; no replay on unmute.
  The context is not suspended and iOS activation/recovery stays intact. RX
  activity remains visible, test/monitor playback is muted too, and refresh
  defaults to audible RX. No stored preference or cross-device synchronization.
- **IFR/VFR cosciale:** structured clearance fields plus free notes, prefilled
  from available FPL departure, destination, alternate, route, and cruise level;
  choose initial mode from flight rules and allow correction. Current-session
  lifetime was requested. Interpretation of shorthand to fill fields is a
  proposed expansion, not permission to overwrite user notes silently. A sandbox
  prototype was suggested before touching production; mixed flight rules and
  FPL changes need explicit behavior.

Installer/tray, configuration migration, and server-help details remain in the
[installation plan](ROADMAP.md#installation-and-operator-experience-plan).
Navigation/route progress, activity statistics, and airport maps remain separate
roadmap items with unresolved data/licensing choices. Official Voice UNICOM and
public frequency listening retain their existing [research notes](VOICE_RESEARCH.md).

## Suggested Sequence And Verification

The agreed sequence is to finish chat organization and publish its beta, then
work on the ATC contact log before the larger friends/aliases feature.
Drafts, addressed-message highlighting, RX mute, and chat organization are
included in 0.1.2-beta.4. Cosciale/checklists remain larger future work.
Radio-name data access and TS2 speaker identity can be researched independently.

Before implementation, settle each feature's state owner, retention/reset rules,
device synchronization, and ambiguous/offline behavior. Preserve local-only use,
typed remote boundaries, memory-only chat/audio policy, and working voice routing.
Frontend work requires desktop and mobile review; native voice attribution and
TX/RX event rules require live tests in addition to automated coverage.
