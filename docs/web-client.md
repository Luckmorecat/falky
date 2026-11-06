# Web client

`web/` is the browser client: one Vite app in React and TypeScript
([ADR 0001](adr/0001-light-monorepo.md)). In production Caddy serves its build
(`web/Dockerfile`), so the page, the API and LiveKit's signalling share one
origin.

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

For frontend mock scenarios, browser checks, and screenshots, use the
[frontend-sandbox skill](../.agents/skills/frontend-sandbox/SKILL.md).

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
