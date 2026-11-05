# Web client

`web/` is the browser client: one Vite app in React and TypeScript
([ADR 0001](adr/0001-light-monorepo.md)). In production Caddy serves its build
(`web/Dockerfile`), so the page, the API and LiveKit's signalling share one
origin. `docs/design/prototype.html` is the design prototype it was built from.

## What it does

Everything the server offers, plus what a browser can add alone, without
server changes: choosing devices, a volume for each participant, unread counts,
event sounds and notifications. Attachments, push-to-talk and showing who is
connected are left out: the first needs the server, the second cannot work
while another window has the focus, and the third the
[glossary](../GLOSSARY.md) rules out.

## Where things live

| Path | Holds |
|---|---|
| `src/api/` | The contract's generated types (`make generate-web`), requests, and the live-update connection with its reconnecting |
| `src/chat/timeline.ts` | Chat rules with no UI: merging by ID, unread, the feed's layout, links |
| `src/voice/session.ts` | One visitor's voice over LiveKit: joining and moving, mute, deafen, screen share, level meters |
| `src/app/controller.ts` | Ties the above to the state in `store.ts`; every action the UI takes goes through here |
| `src/fx/` | The orbs' shader and colours, the blocks' sizes, the animation clock |
| `src/ui/` | The screens |
| `src/runtime/` | Real browser capabilities, bootstrap and preference namespace; real voice stays in `src/voice/session.ts` |
| `src/mock/`, `mock/` | Development-only browser/media adapters and Node HTTP/WebSocket/control service |
| `smoke/`, `scripts/check-runtime.ts` | Local Chromium acceptance and production adapter/bundle boundary checks |
| `src/strings.ts` | Every word of the interface, in each language |

One shader on one WebGL context draws every orb (`src/fx/orbRenderer.ts`) and
goes around React, so talking causes no renders. Falky runs next to games, so a
silent orb is redrawn 15 times a second at most, at 512 pixels at most, and only
a voice gets every frame. "Fewer effects" in the settings, or the system's
reduced motion, stops the colours moving and redraws only for a change in voice.
Without WebGL an orb is a plain gradient.

Interface words live in `src/strings.ts` in Ukrainian and English. They are read
when rendering, so never keep one in a constant outside a render or a call.

`/design.html` on the dev server shows the real screens with made-up data and no
server, for working on how they look. It is not part of the production build.

## Screen share diagnostics

`VITE_DEV_STATS` is the build-time switch for the overlay and its polling. Only
`VITE_DEV_STATS=true` enables diagnostics, regardless of hostname; missing, false,
or malformed values disable them. The static frontend must be rebuilt to change
this setting; changing the running Caddy container's environment has no effect.

Local Vite development defaults on through `web/.env.development`. Run
`VITE_DEV_STATS=false npm run dev` from `web/` to turn it off locally. Production
builds default off; `VITE_DEV_STATS=true npm run build` explicitly enables them.
Docker builds default off through `ARG VITE_DEV_STATS=false`; opt in with
`docker build --build-arg VITE_DEV_STATS=true -t falky-caddy web`.

The reusable web image workflow's boolean `dev_stats` input defaults false and
passes the Docker build argument. The deployment workflow sets it true only for
`master` development builds; tagged production builds pass false.

The current rate uses video RTP byte deltas and their report timestamps, in Mbps.
Your own share totals primary and compatibility senders; a remote share measures
the receiver. Codec labels come from media RTP reports with traffic in the measured
interval, not the saved codec preference. Audio, repair streams, and transport
headers are excluded. A dash means measuring or unavailable; a valid zero is shown
as zero. The graph keeps only the last 60 seconds in memory, leaving gaps where
measurements are unavailable. Changing or stopping the share clears diagnostics.

`src/voice/shareStats.ts` isolates the use of LiveKit's internal
`LocalVideoTrack.simulcastCodecs` map to discover backup senders. Recheck that
adapter when upgrading LiveKit; the public primary-track stats method alone does
not include compatibility upload.

## Running it locally

Use mock mode for frontend work and agent-driven browser checks without services
or hardware. Use the full stack below for real backend, voice and screen-capture
integration. Both run the same `/` application, controller, HTTP client and live
WebSocket connection. `/design.html` remains a separate visual sandbox.

### Frontend only, with deterministic mocks

```sh
cd web
npm ci
npm run dev:mock
```

Open the printed **Mock app** URL. One Node process starts Vite and an in-memory
HTTP/WebSocket service on allocated loopback ports. It starts as Alex in Lounge,
with scripted participants and enough history to exercise pagination. No Go,
LiveKit, Docker, database, capture device or browser permission is needed.

Select a scenario at startup or in the URL:

```sh
npm run dev:mock -- --scenario entry
npm run dev:mock -- --port 5174 --api-port 8081 --scenario remote-share
```

| Scenario | Starting state |
|---|---|
| `populated` | Entered visitor, three rooms, peers and chat history (default) |
| `entry` | Normal name-entry screen with a valid mock access link |
| `quiet` | Entered visitor, empty rooms and histories |
| `remote-share` | Populated rooms; join Lounge to see Sam's synthetic share |

Append `?scenario=entry` (or another name) to the app URL to select it. Changing
the scenario resets the instance; reloading the same scenario preserves changes.
Each instance models one visitor plus scripted peers. Run the default command
again for an independent instance with allocated ports, or assign distinct
`--port` and `--api-port` values. Cookies and preferences are scoped by instance;
two instances can safely use the same browser profile.

The printed **Mock controls** URL discovers scenarios, action names, fault keys
and endpoints. Set `MOCK_URL` to the printed app origin, then for example:

```sh
MOCK_URL=http://127.0.0.1:5174
curl "$MOCK_URL/__mock"
curl "$MOCK_URL/__mock/state"
curl -H 'Content-Type: application/json' -d '{"type":"faults","faults":{"send":"fail"}}' "$MOCK_URL/__mock/action"
curl -H 'Content-Type: application/json' -d '{"type":"faults","faults":{"liveDisconnected":true}}' "$MOCK_URL/__mock/action"
curl -H 'Content-Type: application/json' -d '{"type":"faults","faults":{"liveDisconnected":false}}' "$MOCK_URL/__mock/action"
curl -H 'Content-Type: application/json' -d '{"scenario":"populated"}' "$MOCK_URL/__mock/reset"
```

Use room IDs from `/__mock/state` to inject a message or replace scripted peers:

```sh
curl -H 'Content-Type: application/json' -d '{"type":"message","roomId":"ROOM_ID","authorName":"Sam","body":"Hello from the control API"}' "$MOCK_URL/__mock/action"
curl -H 'Content-Type: application/json' -d '{"type":"participants","roomId":"ROOM_ID","participants":[]}' "$MOCK_URL/__mock/action"
```

`mock/protocol.ts` defines typed payloads. Supported deterministic faults include
one-shot failed send (`send: "fail"`), committed send with lost response
(`send: "lost-response"`), one-shot `delayMs`, held `liveDisconnected`, `roomFull`
(destination room ID or `null`), `micDenied`, `shareFailure`, and
`voiceReconnecting`. `{"type":"name-conflict","active":true}` and
`{"type":"revoke"}` exercise the normal name and access errors. Boolean faults
remain active until cleared or reset; no random failures occur.

Reload preserves messages, the visitor and settings, and ends any synthetic
voice session. Explicit `POST /__mock/reset` with `{}` restores the selected
fixture, rotates the session and clears that instance's browser preferences,
including language, theme, read markers, devices and volume. Open pages observe
reset even after revocation or a live WebSocket outage. Restarting the command
starts a fresh instance; nothing is written to a mock database. Stop with Ctrl-C.

Voice controls, devices, microphone levels, permission outcomes and share settings
are simulated. Screen shares are animated canvas video streams through the real
preview UI. They do not capture a screen or microphone, send audio, encode a real
codec, exercise DSP, or measure RTP quality. Media diagnostics show unavailable
values; mock notification and sound actions are silent. For the optional stats
overlay in mock mode, start with `VITE_DEV_STATS=true npm run dev:mock`.

Mock adapters are selected only by the mock development launcher. Production
builds always use real adapters, including `--mode mock` with `FALKY_MOCK=1`.
The mock service is loopback-only by default and its `/rtc` route fails locally;
there is no fallback to Go or LiveKit.

### Full Go + LiveKit stack

Vite stands where Caddy stands, on `http://localhost:5173`. You need the server
(`mise install` gives Go) and `livekit-server`, for example from
`brew install livekit`.

A LiveKit config in a file of your choice, say `livekit.yaml`. On a Mac, media
only connects over loopback candidates:

```yaml
port: 7880
keys:
  devkey: devsecretdevsecretdevsecretdevsecret00
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: false
  enable_loopback_candidate: true
webhook:
  api_key: devkey
  urls:
    - http://127.0.0.1:9090/livekit/webhook
```

Then, each in its own terminal:

```sh
livekit-server --config livekit.yaml --node-ip 127.0.0.1 --bind 127.0.0.1
```

```sh
cd server
FALKY_PUBLIC_ORIGIN=http://localhost:5173 \
FALKY_LIVEKIT_API_KEY=devkey \
FALKY_LIVEKIT_API_SECRET=devsecretdevsecretdevsecretdevsecret00 \
go run ./cmd/falky serve
```

```sh
cd web
npm ci
npm run dev
```

Create a room and print the access link from `server/`:

```sh
go run ./cmd/falky room create Lounge
go run ./cmd/falky link show
```

A second person on the same machine needs another browser profile: the browser
is what makes someone a visitor.

## Checks

`make check-web` (part of `make check`) compares the generated types with the
contract, runs the unit tests and type-checks and builds the client.


The mock checks are local and require only Node. Install Chromium once, then run:

```sh
cd web
npx playwright install chromium
npm run test:mock
npm run test:browser
npm run test:runtime
```

On Linux, install missing browser system libraries with
`npx playwright install --with-deps chromium` if needed. An existing Chromium can
be used with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser`.
The smoke suite launches and stops its own isolated mock instances on allocated
ports; no existing dev server is required. It checks entry, messaging/retry,
catch-up, history/unread, settings, synthetic voice/share, failures, reload/reset,
and same-profile isolation. `test:runtime` inspects normal dev adapter/proxy
selection and emitted modules/assets from ordinary and mock-looking production
builds. Neither command installs or requires Go or LiveKit. No CI wiring is added.
