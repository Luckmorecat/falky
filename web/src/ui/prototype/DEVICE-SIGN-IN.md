# Device sign-in UI prototype

Question: how should another-device sign-in join Falky's passkey entrance and Account settings?

Three throwaway variants on the existing `/` entrance, selected with `?prototype=device-sign-in&variant=A|B|C`. Based on PR #66, with staging merged before implementation. No real authentication or persistent state.

## Design plan, reviewed before implementation

Tokens come from the current application: ground #161615, surface #232322, raised #2a2a29, foreground #ffffff, secondary rgba(255,255,255,.62), warning #ff8a66. Light mode uses the existing application tokens. Onest Variable carries all text: 450 body, 500 headings, tight heading tracking. Numeric codes use tabular Onest, not a separate monospace. Reuse Button, Icon, Orb, the dotted ground, borderless controls and superellipse corners.

A — Quiet entrance. Center aligned, familiar entrance extended by a device option; reveal one task at a time.

    brand                        prototype
                  orb
             Welcome back
              [Passkey]
           [Another device]
                Recover

B — Open handoff. Left aligned split composition; QR is immediately available alongside passkey sign-in. On mobile the device task precedes supporting content.

    brand                        prototype
    Your voice.           [Scan a QR | Link]
    Another device.              QR
    [Passkey]              waiting + expiry
    Recover                 other method

C — Guided steps. Left aligned sequential rail plus one active task. The sequence reflects actual sign-in progress, without decorating unrelated content with numbers.

    brand                        prototype
    1 Choose a method      Sign in to Falky
    2 Connect your device  [Passkey]
    3 Back to your rooms   [QR] [Link]

Review: rejected adding a new accent, display font, gradient backdrop, decorative security badges or a generic rounded card grid. Falky already has its identity in the orb and squircle geometry. Spend the structural variation on how the two devices meet and how much guidance is visible. Keep approval explicit; a scan does not prove proximity. A link's code belongs on the requesting browser and is entered only on the exact issuing session. Five-minute deadlines never renew on resend. Credential changes still require a passkey on the new browser.

## Run

From `web/`: `pnpm prototype:signin`.

Open http://127.0.0.1:5178/?prototype=device-sign-in&variant=A

Use the bottom arrows or keyboard left/right to switch layouts. Open Preview controls to choose either device, terminal states and light/dark appearance. Variant and scene URLs survive reload; transient interactions live only in memory. The QR fixture opens the local approval preview, never a real approval endpoint. Phone scanning requires a reachable development host; desktop preview controls are the reliable way to inspect both sides.

## Verdict

Pending user evaluation. A is the continuity-first recommendation; B tests immediate QR discovery; C tests whether explicit steps help explain the two-device handoff. No design has been promoted to production. All controls are simulations, including passkey and recovery handoffs.

## Capture and verification

Source: `origin/codex/device-approval-sign-in` at `50c3768`, then merge `origin/staging` at `84ab846`. Prototype branch: `codex/prototype-device-sign-in`.

TypeScript, production build, generated API freshness, 191 existing web tests, runtime boundary checks and screenshot-tool checks pass. Production output contains neither the prototype module nor its styles and QR fixture. A Chromium walkthrough covers QR approval, link/code approval, five-code lockout, cancellation, expiry/retry, unchanged resend deadlines, variant shortcuts and the input keyboard guard. All three variants were checked at 320, 390 and 1440 pixels across six representative screens, with no horizontal overflow or browser errors.

Capture with the existing screenshot utility, for example:

```sh
pnpm screenshot:mock --preset welcome --prototype-variant A --prototype-scene qr --viewport 390x844
```

Screenshots live in ignored `web/screenshots/`; the implementation PR carries the branch pointer and visual evidence. Keep the full experiment on this throwaway branch until a layout has been chosen.
