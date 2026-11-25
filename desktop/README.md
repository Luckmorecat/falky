# Falky desktop

Falky is a native Rust client for an existing Falky server. Enter the server origin, then approve the displayed QR request from an already signed-in Falky account. The app remembers one origin. Use a reachable HTTPS origin for approval from a different device. Plain HTTP is available for local development at localhost and 127.0.0.1.

## Build and run

Install the current stable Rust toolchain with Cargo. The locked workspace was verified with Rust 1.100.0 on Linux x86-64. The workspace and its Linux dependency metadata declare Rust 1.90 or later.

- **Linux** needs Clang 21 or newer, pkg-config, and the GLib, ALSA, D-Bus, Wayland, X11, XCB, and XKB development libraries. Ubuntu 24.04 package names and the Clang setup appear in the [desktop workflow](../.github/workflows/desktop.yml). Enable a Secret Service provider such as GNOME Keyring to retain sign-in across restarts. A StatusNotifier host supplies the tray. A notification daemon and, on Wayland, a GlobalShortcuts portal supply the corresponding system features.
- **macOS** needs Xcode command line tools. Global push-to-talk needs the app's Accessibility permission.
- **Windows** needs a Rust MSVC toolchain and the Visual Studio C++ Build Tools with a Windows SDK.

Run these commands from the repository root. Select the installed Clang compiler on Linux as shown in the workflow.

    cd desktop
    cargo +stable build --locked --workspace
    cargo +stable run --locked -p falky-desktop

When global push-to-talk is available, use Ctrl+Shift+F9 or the binding reported by the Wayland compositor. The editable in-app binding is Space by default. The dock mic button can also be held while push-to-talk is enabled. While in voice, closing the window hides it if the tray is available. Use the tray to restore the window or quit.

Use `/` or Enter to open and focus chat and the left and right arrow keys to navigate rooms. These shortcuts apply when an editor or dialog does not hold keyboard focus.

Falky remembers your selected microphone and speakers by device ID. If a selection becomes unavailable, reconnect the device, choose another one, or choose System default to use the device selected by the OS.

## Checks

    cd desktop
    cargo +stable fmt --all -- --check
    cargo +stable check --workspace --all-targets --locked
    cargo +stable test --workspace --locked
    cargo +stable clippy --workspace --all-targets --locked -- -D warnings

See [Phase 1 verification](docs/phase1-verification.md) for runtime evidence and platform limits.
