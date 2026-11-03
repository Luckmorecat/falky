# LiveKit spike

Does the LiveKit version we pin behave the way the voice and occupancy design
assumes, and how should one host carry media when UDP is blocked?

Run on 2026-11-03 against `livekit/livekit-server:v1.13.11` in Docker
(`--dev`, API key `devkey`, secret `secret`), on the development machine. Every
answer below cites what showed it: a run of a throwaway program, a log line, or
the LiveKit source at the pinned version. Source paths are relative to the Go
module cache: `livekit-server@v1.13.11`, `server-sdk-go/v2@v2.19.0`, and
`protocol` at two versions. Sending webhooks and checking grants is the
server's copy, `protocol@v1.53.1-0.20261023175527-46332a036e25`; verifying
webhooks is the SDK's copy, `protocol@v1.51.1-0.20260910121219-271d9cde3897`.
The files cited below differ between the two only in locking and in
agent-related additions.

## Summary

| Claim | Result |
| --- | --- |
| Webhooks are signed and verifiable with the Go SDK; join, leave and room end fire | Confirmed |
| Grants limit publishing to microphone, screen share and screen-share audio; a camera is refused | Confirmed |
| A second connection with the same identity replaces the first | Confirmed, within one room only (workaround below) |
| A participant updates its own attributes and others see it | Confirmed; use attribute `deafened` |
| LiveKit refreshes the token during a long session | Confirmed |
| `RemoveParticipant` disconnects and fires `participant_left` | Confirmed; the held token stays valid, and token expiry never ends voice (below) |
| Listing participants for the 30 s refresh is cheap | Confirmed |
| UDP strategy for one host behind Caddy | ICE over TCP on 7881 plus UDP on 7882; no TURN for now |
| Versions to pin | Server `v1.13.11`, Go SDK `v2.19.0` |

Every behaviour asked about was confirmed. One design assumption next to them
is refuted: an expiring token does not end a voice session, because LiveKit
keeps refreshing it. After the access link is replaced, voice ends only when
the server removes the participants, including after a crash between replacing
the link and removing them (link rotation).

Two confirmations carry a condition the server has to cover, and one
assumption about the development machine needs a workaround in tests:

- Identity replacement is per room, so moving a visitor between rooms stays
  the server's job (voice join).
- Removing a participant does not revoke its token, and every join hands the
  client a fresh one, so nothing short of replacing LiveKit's API key keeps a
  modified client out of voice (link rotation, webhook intake).
- On this machine a container cannot reach a server on the host through the
  Docker bridge. Tests that need LiveKit to call the server run LiveKit with
  `--network host` (occupancy integration tests).

## How it was run

- LiveKit: `docker run livekit/livekit-server:v1.13.11 --dev --config
  livekit.yaml --node-ip 127.0.0.1 --bind 0.0.0.0`, with `rtc.tcp_port: 7881`,
  `rtc.udp_port: 7882` (one UDP port for all participants), and a `webhook`
  block pointing at the receiver below. `--dev` binds `127.0.0.1` unless
  `--bind` says otherwise.
- A throwaway Go program (kept outside the repository) using
  `server-sdk-go/v2` v2.19.0 for participants and `RoomServiceClient`, and
  `protocol/webhook` for a webhook receiver on port 9999. One subcommand per
  claim below.
- Headless Chromium 152 with `livekit-client` 2.23.0 from jsDelivr and fake
  media devices: one page joins a publisher and a subscriber to the same room
  and reports the selected ICE candidate pairs and received audio bytes. The Go
  SDK cannot test ICE over TCP: it builds its peer connections with pion's
  default UDP-only network types (`server-sdk-go/v2@v2.19.0/transport.go`).
- `lk` from `livekit/livekit-cli:v2.19.3`, run with
  `docker run --rm --network host`.

## Webhooks

**Confirmed.**

Signing (the server's `protocol/webhook/resource_url_notifier.go`, `send`):

- `POST` with `Content-Type: application/webhook+json`; the body is the
  protojson `WebhookEvent`.
- Header `Authorization: <JWT>`, without a `Bearer` prefix. The JWT is an
  access token signed HS256 with the API secret named by the webhook
  `api_key`: `iss` is the API key, the `sha256` claim is the base64 SHA-256 of
  the body, and it is valid for 5 minutes. Verification allows 1 minute of
  clock skew (`protocol/auth/verifier.go`, `tokenLeeway`).

Verifying with the Go SDK:

```go
provider := auth.NewSimpleKeyProvider(apiKey, apiSecret) // github.com/livekit/protocol/auth
event, err := webhook.ReceiveWebhookEvent(r, provider)  // github.com/livekit/protocol/webhook
```

`ReceiveWebhookEvent` reads and closes the body itself, so nothing may read the
body first. The receiver answered `401` for each forged request and `200` for
the control:

```
no Authorization header             -> 401  authorization header could not be found
signed with a wrong secret          -> 401  token signature is invalid: signature is invalid
unknown API key                     -> 401  API secret could not be found
valid token, tampered body          -> 401  could not verify authenticity of message
valid token, matching body (control) -> 200
```

Events seen (receiver log, abridged):

```
room_started       room=spike-dup
participant_joined room=spike-dup identity=v-dup sid=PA_hEkRvX33WBhh state=ACTIVE
participant_left   room=spike-dup identity=v-dup sid=PA_hEkRvX33WBhh state=DISCONNECTED
participant_joined room=spike-dup identity=v-dup sid=PA_4Ux4cASNNnkB state=ACTIVE
track_published    room=spike-grants identity=v-grants source=MICROPHONE
track_unpublished  room=spike-grants identity=v-grants source=MICROPHONE
room_finished      room=spike-dup            (about 20 s after the room emptied)
```

`participant_connection_aborted` also exists (`protocol/webhook/consts.go`) and
fires when a connection fails before it reaches state `ACTIVE`
(`livekit-server/pkg/telemetry/events.go`); the spike did not trigger it.
`participant_joined` arrived within 10 ms of the client connecting, and
`participant_left` within 1 ms of it leaving. No event fires when a
participant's attributes or metadata change.

What webhook intake should know:

- Each event carries `id` (`EV_…`) and `created_at` (Unix seconds).
- Delivery is per room through one queue each, so events for one room arrive
  in order. Failed deliveries are retried, and events are dropped when a queue
  falls behind (`resource_url_notifier.go`, `QueueNotify`), which the periodic
  refresh heals. Events for different rooms are not ordered relative to each
  other: when a visitor moves rooms, `participant_joined` for the new room may
  arrive before `participant_left` for the old one.
- Key occupancy by participant SID, not only identity. When a second tab takes
  over, LiveKit sends `participant_left` for the old SID and
  `participant_joined` for the new one with the same identity.
- `room.num_participants` in event payloads is stale (it read 0 on joins); do
  not use it.
- A signed event can be replayed until its JWT expires (5 minutes plus
  leeway). Keying by SID makes a replayed `participant_left` harmless, but a
  replayed `participant_joined` after its `participant_left` brings the
  participant back until the next refresh removes it. Rejecting event `id`s
  already seen in the last few minutes closes that; the internal listener being
  unreachable from outside is what limits who can replay at all.

## Publish sources

**Confirmed.** A token with `canPublishSources: [microphone, screen_share,
screen_share_audio]` published all three, and a camera was refused.

Grant used (Go, `protocol/auth`):

```go
g := &auth.VideoGrant{RoomJoin: true, Room: room}
g.SetCanPublish(true)
g.SetCanSubscribe(true)
g.SetCanPublishData(false)
g.SetCanUpdateOwnMetadata(true)
g.SetCanPublishSources([]livekit.TrackSource{
	livekit.TrackSource_MICROPHONE,
	livekit.TrackSource_SCREEN_SHARE,
	livekit.TrackSource_SCREEN_SHARE_AUDIO,
})
```

Go client:

```
publish MICROPHONE: OK sid=TR_AMYYT2QuKLMtaL after 0s
publish SCREEN_SHARE: OK sid=TR_VSikuCVMjfEFUs after 0s
publish SCREEN_SHARE_AUDIO: OK sid=TR_AsgHug8WvDcN35 after 0s
publish CAMERA: REFUSED after 10.001s: timed out publishing track
server permission for v-grants: can_subscribe:true can_publish:true can_publish_sources:MICROPHONE can_publish_sources:SCREEN_SHARE can_publish_sources:SCREEN_SHARE_AUDIO can_update_metadata:true
```

`OK` means the server answered the add-track request with a published-track
response. No media was written to the screen share track, so it is absent
from the listing and from `track_published` webhooks; the two audio tracks
appear in both.

Server log: `WARN rtc/participant.go:1406 no permission to publish track
{"participant": "v-grants", "kind": "VIDEO"}`. The server answers with a
`NOT_ALLOWED` request response. The browser SDK fails at once with
`failed to publish track, insufficient permissions`; the Go SDK ignores that
response and times out after 10 s.

`canPublishData` falls back to `canPublish` when left unset
(`protocol/auth/grants.go`, `GetCanPublishData`), so the token sets it to
`false` explicitly: chat goes over HTTP, and nothing else needs
data messages.

## Same identity, second connection

**Confirmed, within one room.** A second connection with the same identity in
the same room drops the first with reason `DUPLICATE_IDENTITY`:

```
[tab1] connected room=spike-dup identity=v-dup sid=PA_hEkRvX33WBhh
[tab1] disconnected reason="duplicate identity"
[tab2] connected room=spike-dup identity=v-dup sid=PA_4Ux4cASNNnkB
```

The same identity in another room does not drop the first. LiveKit identities
are unique per room only:

```
[tab3-other-room] connected room=spike-dup-2 identity=v-dup sid=PA_GrneEs8KD4Ns
other room: tab2 NOT dropped (state=connected); identity is unique per room only
```

So "a visitor is a participant in at most one room" holds only because the
server removes the visitor from its previous room when it issues a token for
another one. `RemoveParticipant` for an identity that is not in the room
returns Twirp `not_found` (`participant does not exist`); treat that as
success.

## Deafened through attributes

**Confirmed.** With `canUpdateOwnMetadata`, a participant's
`SetAttributes`/`SetMetadata` reached the other participant within about 50 ms:

```
[observer] attributes changed v-spk map[deafened:true] (all=map[deafened:true])
[observer] attributes changed v-spk map[deafened:false] (all=map[deafened:false])
[observer] metadata changed v-spk "" -> "{\"deafened\":true}"
```

Without the grant the update is refused and others see nothing (server log:
`could not update metadata … "error": "update own metadata not allowed"`; the
observer saw no change within 3 s). The browser run confirmed the same from
`livekit-client`: the subscriber read `{"deafened":"true"}` from the
publisher's attributes.

**Use the attribute `deafened`, values `"true"` and `"false"`; absent means
not deafened.** Attributes are a string map merged key by key, with a per-key
change event (`ParticipantEvent.AttributesChanged` in `livekit-client`), while
metadata is one string that each write replaces whole. In the browser:
`room.localParticipant.setAttributes({ deafened: 'true' })`. Muted needs no
attribute: it is the microphone track's mute state.

Attributes also appear in `ListParticipants` and in webhook payloads. The
server must not pass them on: visitors outside a room see names only.

## Token refresh

**Confirmed.** LiveKit sends each participant a fresh token on join and
every 5 minutes, valid for the longer of 10 minutes and the original token's
remaining time, with the same grants (`livekit-server/pkg/service/roommanager.go`:
`tokenRefreshInterval = 5 * time.Minute`, `tokenDefaultTTL = 10 * time.Minute`,
`refreshToken`). The SDKs keep it and use it when they reconnect.

Run: a 15 s token, then 85 s of waiting (past expiry plus the 1 minute
leeway):

```
token TTL 15s; waiting 1m25s so it expires past the 1 min leeway
still connected after expiry: state=connected
fresh join with the expired original token REFUSED: … token is expired
[refresh] reconnecting
[refresh] reconnected
```

The server logged the reconnect with the refreshed token's expiry, join time
plus 10 minutes:

```
21:02:33.130Z participantID=PA_jq8n664BbrrD Reconnect=false TokenExpiresAt=2026-11-03T21:02:48Z
21:03:58.145Z participantID=PA_jq8n664BbrrD Reconnect=true  TokenExpiresAt=2026-11-03T21:12:33Z
```

A token of about 10 minutes therefore only bounds how long a client may wait
before connecting; it does not end a long session. The same mechanism means a
client in voice always holds a token valid for up to 10 more minutes, and the
refresh at join hands a new one to every connection (see the next section).

## Removing a participant

**Confirmed.** `RemoveParticipant` returned in 1 ms; the client was
disconnected with `PARTICIPANT_REMOVED` and `participant_left` fired:

```
RemoveParticipant returned after 1ms
client disconnected after 1ms reason="removed by server" raw=PARTICIPANT_REMOVED
WEBHOOK participant_left room=spike-remove identity=v-rm sid=PA_YbLukP93U8dH state=DISCONNECTED
```

Removal does not revoke the token. Rejoining with the same, unexpired token
one second later succeeded:

```
[rejoin] connected room=spike-remove identity=v-rm sid=PA_Eo9jxcQn4bAj
rejoin with the same token after removal SUCCEEDED
```

The LiveKit SDKs do not reconnect after `PARTICIPANT_REMOVED`, so an unmodified
client stays out, and removal empties voice within milliseconds. A modified
client can rejoin with the token it holds, after the access link is replaced or
after it was moved to another room. Each rejoin hands it a fresh 10-minute
token (LiveKit refreshes on join, `rtcSessionWorker` in
`livekit-server/pkg/service/roommanager.go`), so it can keep doing so
indefinitely.

This is a limitation, not something the server can close. The server can
remove such a client again when `participant_joined` arrives for an
identity that is not a visitor with current access, or for a room other than
the one it last issued that visitor a token for, and the 30 s refresh can apply
the same check. That shortens each stay to the webhook's delay, or up to 30 s
when the webhook is lost, but does not stop the client rejoining. Only
replacing LiveKit's API key and secret, which needs a LiveKit restart, makes
the tokens it holds invalid; refreshed tokens are signed with the first
configured key pair (`refreshToken`). Lowering the participant's permissions
with `UpdateParticipant` before removing it does not help either: LiveKit then
sends a token with the lower grants (`OnClaimsChanged` in `roommanager.go`),
but a modified client can keep its earlier token, and each join renews
whatever grants the token it joins with carries.

## Listing participants

**Confirmed, cheap.** With 11 rooms and 20 participants on the local server:

```
round 0: ListRooms 11 rooms in 749µs; ListParticipants x11 = 20 participants in 1.93ms (175µs/room)
round 1: ListRooms 11 rooms in 123µs; ListParticipants x11 = 20 participants in 1.152ms (105µs/room)
round 2: ListRooms 11 rooms in 98µs; ListParticipants x11 = 20 participants in 922µs (84µs/room)
ListParticipants of unknown room: participants=0 err=<nil>
```

`ListRooms` returns only rooms that exist in LiveKit right now (a room is
created on first join and closed after its empty timeout) with
`num_participants`. `ListParticipants` for a room LiveKit does not know
returns an empty list without error. Every 30 s, one `ListParticipants` per
room the server knows, or `ListRooms` followed by `ListParticipants` for rooms
with participants, costs about 1 ms for a server of this size. Idle LiveKit
used 35–65 MiB of memory.

## UDP strategy, ports and paths

**ICE over TCP on 7881 and UDP on 7882; no TURN for now.**

Evidence, browser (Chromium, `livekit-client` 2.23.0), selected candidate
pairs:

- UDP port published (control): `local udp prflx` → `remote udp 127.0.0.1:7882
  host`, 50 494 audio bytes received in 6 s.
- UDP port not published (UDP unreachable): `local tcp prflx active` →
  `remote tcp 127.0.0.1:7881 host`, 52 032 audio bytes received in 6 s. The
  whole run, joins and publishing included, took 8.5 s.

LiveKit offers both candidates on every connection and the browser picks the
one that works; no client setting is involved. This covers networks that
block UDP but allow outbound TCP to port 7881. It does not cover networks that
allow only 443; there the client fails to connect media.

Why no TURN yet: LiveKit's embedded TURN/TLS always advertises
`turns:<turn.domain>:443?transport=tcp`, whatever `turn.tls_port` says
(`livekit-server/pkg/service/roommanager.go`, `iceServersForParticipant`; the
sample config's comment that `tls_port` is advertised does not match the
code). On one IP, Caddy already owns 443, so TURN/TLS needs either an L4 proxy
that routes 443 by SNI (a Caddy build with the layer4 module, with
`turn.external_tls: true` and `turn.proxy_protocol: true`) or a second IP.
TURN over UDP (3478) does not help when UDP is blocked. If the test on the real
host shows visitors on 443-only networks, that is the next step. This path was
read from source, not exercised.

Ports to publish from the LiveKit container: `7881/tcp` (ICE over TCP) and
`7882/udp` (all UDP media on one port). Port 7880 stays on the Compose network:
Caddy proxies the signalling to it, and the server calls its API there.

Signalling and API share port 7880 (`livekit-server/pkg/service/server.go`,
`rtcservice.go`). Probes against it:

```
/rtc/validate                          -> 200
/rtc/v1/validate                       -> 400 (needs the join request the SDK sends)
/twirp/livekit.RoomService/ListRooms   -> 401 permissions denied (no token, and with a visitor's join token)
/                                      -> 200 (LiveKit health)
/whip/v1                               -> 200
```

- Proxy to LiveKit: `/rtc` and `/rtc/*` only, as plain HTTP that also allows
  WebSocket upgrades. `/rtc` and `/rtc/v1` are the WebSocket signalling
  connections; `/rtc/validate` and `/rtc/v1/validate` are ordinary `GET`
  requests the SDK makes after a failed connection (`rtcservice.go`,
  `v0Validate`, `v1Validate`), so an upgrade-only rule would break them.
  `livekit-client` 2.23.0 connects to `<url>/rtc/v1` and falls back to
  `<url>/rtc`.
- Never expose: `/twirp/*` (server API), `/whip/*` (ingest), `/agent`, `/`,
  and `/debug/*` (registered in dev mode).
- The LiveKit URL handed to clients is the public origin, `wss://<host>`; the
  SDK appends `/rtc`.

For Compose:

- Keep LiveKit on the bridge network and set `rtc.node_ip` to the host's public
  address (or `rtc.use_external_ip: true`), so its candidates name an address
  clients can reach. Locally `--node-ip 127.0.0.1` with published ports
  worked.
- API secrets shorter than 32 characters make LiveKit log an error outside dev
  mode (`livekit-server/pkg/config/config.go`).
- Rooms close after `empty_timeout` (default 300 s) or `departure_timeout`
  (default 20 s after the last participant leaves), which is when
  `room_finished` fires.

## Versions

| Component | Pin | Released |
| --- | --- | --- |
| LiveKit server image | `livekit/livekit-server:v1.13.11` (`sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20`) | 2026-10-25 |
| Go SDK | `github.com/livekit/server-sdk-go/v2 v2.19.0` (brings `github.com/livekit/protocol v1.51.1-0.20260910121219-271d9cde3897`; needs Go ≥ 1.26.8) | 2026-10-08 |
| `lk` CLI image, tests only | `livekit/livekit-cli:v2.19.3` (`sha256:cb460d18fb001c81fb3b6c9bf8fee487e64fb64124f3495086823ac5cd0b7a81`) | 2026-11-03 |
| Browser SDK used here | `livekit-client` 2.23.0 | 2026-10-16 |

Each is the newest release in its line on the day of the spike. All
results above come from these versions.

## Test setup on this machine

- A container on the default bridge cannot reach a server on the host:
  `wget http://host.docker.internal:9999/webhook` from the LiveKit container
  (`--add-host=host.docker.internal:host-gateway`, resolving to `172.17.0.1`)
  timed out, and no webhook arrived. With `--network host` and the webhook URL
  `http://127.0.0.1:9999/webhook`, every webhook above arrived. Integration
  tests that need webhooks run LiveKit with `--network host` and
  `--bind 127.0.0.1`.
- `lk` runs from its image with `--network host`.
  `lk load-test --audio-publishers 5 --duration 20s` connected and published
  five audio tracks against the local server; LiveKit used 1.8 % CPU. The
  five-participant measurement that counts runs on the target host.
