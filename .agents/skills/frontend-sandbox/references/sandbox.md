# Sandbox reference

Run commands from the repository’s `web/` directory unless a command explicitly
changes directory.

## Mock server

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

## Screenshots

From `web/`, install Chromium once with `npx playwright install chromium`, then:

```sh
npm run screenshot:mock -- --preset room --output /tmp/falky.png
npm run screenshot:mock -- --preset screen-share --gpu --output /tmp/share.png
npm run screenshot:mock -- --preset chat --viewport 390x844 --theme light --lang uk --output /tmp/chat-mobile.png
```

Each invocation starts its own mock on allocated loopback ports, opens headless
Chromium, waits for the selected UI and fonts, writes a PNG and closes both browser
and server. Cleanup also runs on capture failure, timeout, Ctrl-C and SIGTERM.
Existing dev servers are untouched. The absolute image path is printed to stdout
after cleanup; progress/errors go to stderr. No interactive browser setup is needed.

| Preset | Captured UI |
|---|---|
| `room` | Populated Lounge, outside voice (default) |
| `chat` | Chat drawer explicitly opened |
| `voice` | Joined Lounge with simulated participants |
| `screen-share` | Joined Lounge displaying Sam's animated synthetic screen |
| `settings` | Settings panel open |
| `entry` | Name-entry screen with a valid mock link |

Defaults are 1440×1000, dark theme, English, UTC and device scale 1. Use
`--viewport WIDTHxHEIGHT`, `--theme dark|light`, `--lang en|uk` and `--full-page`
to override capture settings. Output defaults to `screenshots/<preset>.png`
(ignored by Git); parent directories are created and an existing image is replaced.
CSS animations are disabled for capture and reduced motion is requested;
synthetic speaking/video content remains a snapshot, not a pixel-identical baseline.

`--scenario` can select any mock fixture. Without `--preset`, it captures that
fixture's starting screen (`entry` selects the entry preset). The entry scenario
and entry preset must be used together. Other presets use `populated`, except
`screen-share`, which uses `remote-share`. When combined with a different non-entry
scenario, the screen-share preset starts the local visitor's synthetic share.

`--gpu` requests hardware acceleration using full headless Chromium and its
[`--enable-gpu` flag](https://chromium.googlesource.com/chromium/src.git/+/main/docs/gpu/using-gpu-hardware-in-headless-chrome.md).
It keeps Chromium's driver autodetection; it does not guarantee hardware rendering
on hosts without compatible GPU/display drivers. It prints the WebGL renderer to
stderr so hardware versus software rendering can be inspected. On Linux, autodetection normally
needs a working X display and `DISPLAY`. Without `--gpu`, the command uses the same
default headless launch as the smoke suite. Both respect
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` for an existing browser. Use
`npm run screenshot:mock -- --help` for all options and `npm run test:screenshot`
to verify captures and cleanup locally.

## Checks

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
