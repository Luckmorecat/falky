# Phase 1 verification

The desktop targets the Falky server, OpenAPI, web client, and deployment files at
a117bb7e9d4bea3866dd5813cadcbd2d3f1f1d5d. The workflow has Linux, macOS, and Windows
native check, link, and test jobs. Linux also runs format and Clippy checks.
The desktop lockfile pins the full graph, including iced 0.14.0, wgpu 27.0.1,
reqwest 0.12.28, tokio-tungstenite 0.29.0, CPAL 0.17.3, LiveKit 0.12.1,
libwebrtc 0.4.2, and webrtc-sys 0.3.55.

On Linux, the locked build passed formatting, all-target checks, strict
Clippy, linking, and 93 workspace tests. An isolated unlocked Secret Service
fixture passed the opt-in concurrent keyring restore regression separately.
`actionlint` passed for the desktop workflow.

## Linux protocol and media spike

The probe used the unchanged Go backend, the deployed LiveKit 1.13.11 server
version, and Chromium 156 on Debian 13 x86-64. The candidate's QR was approved in
an independently enrolled browser. HTTPS and HTTP localhost worked with the
same scoped HTTP and WebSocket cookie authority. HTTP 127.0.0.1 exercised the
server-issued Secure cookies with a disposable fixture. Chromium refused
passkey enrollment at that IP hostname. The live probe stayed connected past
the server pong deadline and observed close code 4001 followed by HTTP 401
after logout.

The native and browser peers both entered the guarded RTC endpoint and
exchanged real RTP. The native probe received a 997 Hz browser microphone tone
through its custom 48 kHz mixer and sent a 697 Hz tone to the browser analyzer.
It observed camera, screen, and screen-audio publications while processing only
microphone audio. The Pulse sink monitor measured the browser tone and WebRTC
APM processed 381 forward and 381 reverse 10 ms blocks. The test used synthetic
audio and a null sink.

## Linux window and input spike

An iced daemon rendered native WGSL orbs on software Vulkan under Xvfb.
The observed idle redraw rate was about 14 frames per second and increased
during the speaking spotlight. Onest displayed Latin and Ukrainian text. The
bundled reaction font rendered all six reactions.

An isolated D-Bus StatusNotifier host exercised native X11 close-to-tray,
reopen, watcher loss, quit, and global push-to-talk press and release while
hidden. Weston exercised destruction and recreation of a native Wayland window
while the tray and daemon stayed live. A private D-Bus GlobalShortcuts fixture
confirmed activation, deactivation, and release on session close.

## Native application checks on Linux

The Xvfb application run used a fresh configuration directory and a disposable
Go server. A separately enrolled Chromium account approved the QR decoded
from the Falky window. The signed-in shell loaded the room strip and the
account tab showed the expected profile. Native chat posted through the Go
API and rendered a live message from another identity. After the live socket
was interrupted, the app fetched 101 missed messages over two after-pages and
refreshed a room renamed while offline. The live socket answered the Go
server's ping with pong. Disabling the approved account with the Go admin CLI
closed the native live socket with code 4001 and returned the app to a fresh
scannable QR with the session-ended notice.

An X11 clipboard PNG was uploaded and sent as a chat attachment. The native
client fetched its thumbnail with the session, opened the enlarged viewer,
and the same content URL returned 401 to a separate unauthenticated request.

The native Add image button opened the Debian XDG FileChooser 1.20.3 with the
GTK backend 1.15.3. The picker and a separate X11 XDND `text/uri-list` drop each
imported a different PNG. For each image, the upload and message post returned
201, the signed-in gallery read returned 200, and a separate anonymous read
returned 401. The app displayed the expected 420×250 WebP pixels for each message.
The isolated app's HOME, TMPDIR, and XDG directories contained no regular image
files before import, after display, or after exit. The picker returned
host-native file URIs. The host lacked a FUSE mount for document-portal exports,
so those exports remain unverified.

The documented `cargo run --locked -p falky-desktop` command opened a visible
Falky window on an isolated X11 display.

With the private LiveKit fixture, the native dock's Join action acquired a
voice grant, received HTTP 101 from the guarded RTC route, and displayed the
local voice tile. The X11 window-manager close hid the joined app. The
StatusNotifier tray restored the window while the same guarded RTC socket and
server-side participant remained active. Confirming Leave in the dock closed
the socket, removed the participant, and disabled the tray voice controls.
The room arrows and slash-to-chat shortcuts worked in the native window. Tray
Quit exited the app and released its D-Bus registration.

The CPAL 0.17.3 voice actor was separately exercised with that backend version,
a guarded LiveKit server, Chromium, and private Pulse devices. The browser
received the CPAL microphone tone, and the selected CPAL sink received the
browser microphone while excluding its screen-share audio. Two equally named
microphones resolved to distinct tone and silent inputs. A missing explicit
microphone left the active call listen-only, and a missing explicit speaker
left playback unavailable despite a working OS-default output. The fixture
also checked the mic and speaker tests, passive media badges, deafen attributes,
overlapping hold sources, failed room admission preserving the old call,
successful room switch, local leave, and admission 401.

## Audio device identity

CPAL 0.17.3 exposes the native CoreAudio UID and WASAPI endpoint ID for saved
choices. Linux saves a named virtual ALSA route directly. For a physical ALSA
card, Falky combines the PCM route with a hash of the sysfs device location,
hardware identity, and USB serial when available. Physical routes without a
verifiable identity are omitted from the explicit picker. Replacing a
serial-less device with an identical model in the same port retains the same
identity. A missing or unrecognized saved choice leaves that stream inactive
until the endpoint is available or the user makes a new choice.
Linux tests exercise simulated card renumbering, a replacement with a different
USB serial, identical models on distinct ports, and unverifiable hardware
routes. The audio regressions also cover malformed ALSA configuration, viable
PCM format selection including U24, and silence until a stream is validated.

## Platform verification pending

The macOS and Windows jobs are configured and await hosted execution. Native
audio hardware, physical acoustic echo cancellation, and the Wayland portal's
real permission UI still require testing. macOS and Windows runtime checks
are pending for audio, tray, global shortcuts, and notifications. The macOS
notification implementation posts a banner without room activation.

CPAL 0.17.3 leaves the COM allocation for a WASAPI endpoint ID unreleased after
copying the ID. The memory impact of repeated endpoint discovery and retries
still requires testing on Windows. [CPAL 0.17.3 source](https://docs.rs/crate/cpal/0.17.3/source/src/host/wasapi/device.rs)

Image uploads show an indeterminate `Uploading` status.
