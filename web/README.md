# Frontend workshops

Install the pnpm version pinned in `web/package.json` (from the repository root):

```sh
npm install --global "$(node -p 'require("./web/package.json").packageManager')"
```

From `web/`, install the locked dependencies with `pnpm install --frozen-lockfile`.

- `pnpm run storybook` starts the component workshop at http://localhost:6006.
- `pnpm run build-storybook` creates a static workshop in `storybook-static/` (ignored by Git).
- `pnpm run dev` keeps the existing full-screen playground at http://localhost:5173/design.html. It includes entry, room, chat, sharing, and access-message scenarios.
- `pnpm run dev:mock` starts the app with simulated services for complete user flows; use the printed URL.

Storybook is local development tooling. It uses Falky's Onest font and production styles. Its toolbar switches light/dark appearance and Ukrainian/English text without writing app preferences. No backend or device permissions are needed.

The initial catalog contains Icon (all glyphs), Orb (palettes, idle, simulated speech, still), Message (informational screens and long text), Button (primary, secondary, join), IconButton (sizes and pressed states), Toggle, and Segmented. Interactive stories show their actions and current values in the canvas; static state stories can be adjusted through Controls where applicable. The full-screen playground remains separate.

To add an example, create `stories/Name.stories.tsx`, import a pure production component from `src/ui`, and export a typed `Meta` plus named `StoryObj` examples. Add `tags: ['autodocs']` for a component reference page. Read `t` from `src/strings` inside render functions for toolbar-aware labels. Keep state and event feedback local to the story; never import the app controller, store, preference adapters or voice session. The preview deliberately uses its own Vite config, so it cannot inherit backend proxies or initialize application adapters.

There is no Storybook test runner, interaction-test suite, visual regression service, or CI gate. The build command produces an optional local artifact; it does not publish anything.

## Memory profiling

`pnpm run profile:memory` reuses the Playwright browser options and isolated mock
launcher. Install Chromium once with `pnpm exec playwright install chromium`, or
set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium` to use an existing
browser. No Go, LiveKit, or extra profiling package is required.

```sh
pnpm run profile:memory --scenario populated
pnpm run profile:memory --scenario quiet --duration 30 --interval 1 --cycles 10 --output profiles/quiet.json
pnpm run profile:memory --scenario remote-share --join-voice
pnpm run profile:memory --scenario entry
```

`--scenario` accepts `populated` (default), `quiet`, `entry`, or `remote-share`.
The command waits for the selected UI, history and fonts, warms up for 3 seconds,
then samples for 15 seconds at 1-second intervals. Use `--warmup`, `--duration`
and `--interval` to change these durations (all in seconds). `--cycles N` adds
N settings open/close cycles after idle sampling, capturing both states.
`--join-voice` joins simulated voice; `remote-share` also waits for Sam's synthetic
video to render. Without this flag all scenarios start outside voice. Entry
does not support settings cycles or joining voice. `--gpu` uses the existing
hardware-capable headless launch option; hardware acceleration depends on the host.

Each run prints a summary and writes a versioned JSON report plus a sibling CSV
under `profiles/` (ignored by Git), or to `--output PATH.json`. Reports include
browser version, workload, timestamps, raw samples and summary metrics. The
fixed environment is 1440×1000, English, dark theme, UTC, reduced motion, with
the development stats overlay disabled. Each invocation closes its browser and
mock server, including on failure, timeout, SIGINT or SIGTERM.

The report measures main-page JavaScript heap, DOM nodes/documents/listeners,
and Chromium process RAM. On Linux it reads `/proc/<pid>/smaps_rollup` for the
processes reported by Chrome's browser CDP session: browser, renderers and utility
processes, excluding Node/Vite/mock and unrelated browsers. PSS apportions shared
pages; summed RSS double-counts them. Missing/unreadable/exited processes make
that sample's totals `null`, with errors and coverage retained in JSON. CSV uses
empty cells for unavailable values. These RAM metrics exclude GPU device memory;
JavaScript counters do not aggregate separate workers or frames.

The first sample follows UI readiness; it does not measure the navigation peak.
GC is forced after warmup and at the end for a retained-memory comparison. Idle
and interaction samples use normal GC. The summary includes idle median heap/PSS,
sampled peaks and post-GC heap/node/listener deltas. Browser process snapshots
before creating and after closing the page provide context for browser overhead.
Sampling can miss brief peaks. Positive retained deltas can reflect caches or
lazy initialization, so repeat workloads and compare fresh runs with the same
Chromium version before diagnosing a leak or setting budgets.

This profiles the **mock development app**. Simulated media does not exercise
real codecs, audio processing or network transport, and these figures are not a
production footprint. Run `pnpm run profile:memory --help` for option bounds and
`pnpm run test:memory` to check scenario selection, report consistency and cleanup.
