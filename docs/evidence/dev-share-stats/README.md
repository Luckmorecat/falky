# Development screen-share statistics

These screenshots show the implemented UI in Chromium, with the existing design
fixture supplying people and rooms. An animated canvas supplies the video; the
small overlay in the lower-left corner is the new bitrate graph. Its values come
from real local WebRTC traffic, not fixture bitrate samples.

The sending view uses two simultaneous loopback connections: H.264 on the primary
sender and VP8 on a compatibility sender, registered on a LiveKit `LocalVideoTrack`.
The receiving view uses a `RemoteVideoTrack` for the VP8 connection. This exercises
actual browser RTP reports and the adapter's aggregation, but does not prove
mixed-browser fallback negotiation through a deployed LiveKit server.

| Before | Sending H.264 + VP8 |
| --- | --- |
| ![Before: no statistics overlay](before.png) | ![Actual combined upload and 60-second graph](sending.png) |

| Receiving VP8 | Fullscreen |
| --- | --- |
| ![Actual received video bitrate](receiving.png) | ![Statistics remain visible in fullscreen](fullscreen.png) |

The graph starts empty and fills with measured samples; a new selected share
starts a fresh graph. The number is video RTP payload Mbps, excluding audio and
network headers. Missing statistics produce gaps, not zero-valued samples.

| Narrow viewport | Production gate |
| --- | --- |
| ![Overlay at a 390-pixel viewport](mobile.png) | ![Production-mode UI without diagnostic overlay](production.png) |

The production image uses the real UI compiled in production mode with a test
track. Browser requests were intercepted locally; this is not a screenshot of
the deployed site. The screenshots remain representative of the appearance with
diagnostics enabled or disabled.

Diagnostics are now controlled solely by the build-time `VITE_DEV_STATS` flag,
independently of hostname. Only the literal `true` enables both the overlay and
its statistics polling; false, missing, and malformed values disable both.
Local Vite development defaults true via `web/.env.development` and accepts an
explicit `VITE_DEV_STATS=false` override. Production builds and Docker's build
argument default off. The reusable web image workflow takes a default-false
`dev_stats` input; the deployment caller passes true only for `master`, and false
for production tags. Changing the switch requires rebuilding the static client.

The updated browser check compiles the real UI three times and intercepts requests
locally under both `falky.lunari.win` and `dev.falky.lunari.win`. Both hosts give
the same results, confirming that hostname detection is gone:

| Build-time `VITE_DEV_STATS` | Overlay | Statistics calls in 2.4 seconds |
| --- | --- | --- |
| `true` | Visible | 3 |
| `false` | Absent | 0 |
| Unset | Absent | 0 |

Verification: the initial implementation passed `make check`. The flag revision
passes `make check-web` (78 tests, schema consistency, TypeScript and production
build), actionlint, 57 deployment tests and shell syntax checks on the updated
master with selective image publishing. Vite configuration
checks verify the local default and explicit false override. Browser checks cover
sending/receiving codec labels, fullscreen,
narrow viewport containment, and stopping statistics polling after sharing ends.
Unit tests cover exact bitrate arithmetic, fallback accounting, inactive senders,
counter resets, unavailable data, graph gaps, track replacement, and asynchronous
cleanup. Standards and specification reviews reported no actionable findings.
