---
name: frontend-sandbox
description: Use when testing Falky UI changes in a browser, controlling mock scenarios or faults, capturing UI screenshots, or attaching screenshot evidence to a PR. Reuses the local mock server and screenshot utility without the full backend stack.
---

# Frontend sandbox

Run the commands below from the repository’s `web/` directory. Install dependencies with `npm ci` when needed.

## Choose the flow

- For UI changes and browser interaction, use `npm run dev:mock`. Open the printed
  **Mock app** URL; ports are allocated per run. Keep the process running for the
  session and stop your instance when finished.
- For a screenshot, use `npm run screenshot:mock -- --preset room`. It owns the
  mock server and headless browser, captures the preset, and shuts both down.
  Use this command directly instead of assembling another capture harness.
- For real API integration, microphone audio, codecs, screen capture, or LiveKit
  behavior, follow [the full-stack setup](../../../docs/web-client.md#full-go--livekit-stack)
  and use `npm run dev`.

Mock mode runs the shared `/` app, controller, and HTTP/WebSocket clients. Keep
frontend changes on that shared path so they also work with Go. `/design.html`
is a visual sandbox; use the mock app to verify complete user flows. Simulated
media can verify UI states, but provides no evidence of real media transport.

## Capture and inspect UI changes

Read `npm run screenshot:mock -- --help` for available presets and options. Select
the preset that exposes the changed UI; include a narrow viewport when changing
responsive layout. For preset/scenario combinations, capture behavior, or GPU
setup details, read [the screenshot reference](references/sandbox.md#screenshots).
For example:

```sh
npm run screenshot:mock -- --preset chat --viewport 390x844 --theme light --lang uk
npm run screenshot:mock -- --preset screen-share --gpu
```

If Chromium is missing, install it with `npx playwright install chromium`, or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an installed Chromium executable.
`--gpu` requests acceleration; use the printed renderer to determine whether the
host actually used hardware or a software fallback.

Open the resulting PNG and inspect the changed UI before reporting visual
verification. Command success alone only confirms a capture was produced.
Keep captures in `screenshots/` relative to `web/` (ignored by Git), or `/tmp`.
When PR evidence is requested, upload the image as an attachment:

```sh
gh pr edit <number> --attach 'screenshots/chat.png#Chat at mobile width'
```

Verify the PR contains a GitHub attachment URL. Keep generated screenshots out
of commits; PR attachments are independent of repository history.

## Control a running mock

Use the printed **Mock controls** URL (`GET /__mock`) to discover scenarios,
actions, faults, and endpoints. Read `GET /__mock/state` for current room IDs;
send changes to `POST /__mock/action` and select/reset fixtures with
`POST /__mock/reset`. Read [the mock guide](references/sandbox.md#mock-server)
for payload examples and persistence/reset behavior; types live in
`mock/protocol.ts`.

For custom browser checks, reuse `smoke/launcher.ts` and `smoke/browser.ts`.
Wait for the relevant UI or media readiness, rather than network idle: mock state
polling continues while the page is open. Close owned browsers and launchers in
`finally` blocks.

## Verify changes to the sandbox

When changing the sandbox utilities themselves, use the relevant scripts in
`web/package.json`: `test:mock` for simulator behavior, `test:browser` for user
flows, and `test:screenshot` for capture tooling. When changing adapter selection,
Vite configuration, or production boundaries, run `test:runtime` to verify that
normal development selects real adapters and production builds exclude mocks.
For browser prerequisites and suite coverage, read [the check reference](references/sandbox.md#checks).

For architecture or screen-share diagnostics, read the corresponding section of
[the web client guide](../../../docs/web-client.md).
