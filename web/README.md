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

Every invocation first measures `about:blank`, closes that browser, and then
measures the mock app in a second fresh browser with identical launch/context
settings. Both runs warm up for 3 seconds and sample for 15 seconds at 1-second
intervals. `--warmup` and `--duration` apply to **each browser**; the default
invocation takes roughly 36 seconds plus startup and cleanup. Use `--warmup`,
`--duration` and `--interval` to change these durations (all in seconds).

The headline **app incremental PSS** is the app's idle median PSS minus the blank
tab's idle median PSS. The blank-tab median is reported separately as Chromium
overhead, alongside the full app-session total. A blank tab includes browser UI,
page-engine and graphics overhead that a browser with no tabs would miss. Fresh
sequential browsers prevent app caches from contaminating the baseline and avoid
changing shared-memory proportions by keeping two test browsers alive at once.
The difference estimates added RAM, including browser work caused by the app;
it cannot assign exact ownership to shared pages. Negative differences are
preserved, and an unavailable median on either side makes the increment `null`.

`--scenario` accepts `populated` (default), `quiet`, `entry`, or `remote-share`.
The app run waits for the selected UI, history and fonts. `--cycles N` adds
N settings open/close cycles after idle sampling, capturing both states.
Cycles run only in the app and are excluded from the matched idle comparison.
`--join-voice` joins simulated voice; `remote-share` also waits for Sam's synthetic
video to render. Without this flag all scenarios start outside voice. Entry
does not support settings cycles or joining voice. `--gpu` uses the existing
hardware-capable headless launch option; hardware acceleration depends on the host.

Each run prints a summary and writes a versioned JSON report plus a sibling CSV
under `profiles/` (ignored by Git), or to `--output PATH.json`. Reports include
browser version, workload, timestamps, raw samples and summary metrics. JSON
schema version 2 adds `blankBaseline` with its samples and summary, plus
`summary.chromiumOverheadPssBytes` and `summary.appIncrementalPssBytes`.
`summary.idleMedianBrowserPssBytes` remains the full app-session median. CSV rows
have a `workload` column (`blank` or `app`); app rows also report
`browserPssAboveBlankMedianBytes` relative to the blank idle median, including
interaction samples. Blank rows leave that delta empty. The
fixed environment is 1440×1000, English, dark theme, UTC, reduced motion, with
the development stats overlay disabled. Each invocation closes its browser and
mock server, including on failure, timeout, SIGINT or SIGTERM in either run.

The report measures main-page JavaScript heap, DOM nodes/documents/listeners,
and Chromium process RAM. On Linux it reads `/proc/<pid>/smaps_rollup` for the
processes reported by Chrome's browser CDP session: browser, renderers and utility
processes, excluding Node/Vite/mock and unrelated browsers. PSS apportions shared
pages; summed RSS double-counts them. Missing/unreadable/exited processes make
that sample's totals `null`, with errors and coverage retained in JSON. CSV uses
empty cells for unavailable values. These RAM metrics exclude GPU device memory;
JavaScript counters do not aggregate separate workers or frames.

The first sample follows UI readiness; it does not measure the navigation peak.
In each browser, GC is forced after warmup and at the end for a retained-memory
comparison. Idle and interaction samples use normal GC. The summary includes idle median heap/PSS,
sampled peaks and post-GC heap/node/listener deltas. Browser process snapshots
before creating and after closing each page provide additional context; the
blank-tab idle median is the reference used for incremental memory.
Sampling can miss brief peaks. Positive retained deltas can reflect caches or
lazy initialization, so repeat workloads and compare fresh runs with the same
Chromium version before diagnosing a leak or setting budgets.

This profiles the **mock development app**. Simulated media does not exercise
real codecs, audio processing or network transport, and these figures are not a
production footprint. Run `pnpm run profile:memory --help` for option bounds and
`pnpm run test:memory` to check scenario selection, report consistency and cleanup.

## Shared visitor colours in the mock

The mock app uses the same confirmed colour controller and public API as Go:
`PUT /api/me/colour` saves one palette, and `POST /api/visitor-colours` reads up to
100 explicit visitor IDs, including historical authors. Successful saves publish
`visitor.colour.changed` to every live tab. Per-visitor colour revisions are
independent of the simulator's control-state revision. Same-scenario reloads keep
assignments; resetting the fixture or restarting the process creates fresh state.

Use `GET /__mock/state` to find a visitor ID, then script a colour edit with
`POST /__mock/action` and `{ "type": "colour", "visitorId": "ID", "palette": "moss" }`.
The `faults` action accepts one-shot `colourSave: "fail"`, `colourDelayMs` (before
acceptance) and `colourResponseDelayMs` (after acceptance) to exercise failed saves
and response ordering. `liveDisconnected` remains available for missed-event
recovery without posting another message. The simulator still models one current
visitor plus scripted peers; two tabs share that visitor's session.

Capture Profile directly with the existing isolated screenshot utility:

```sh
pnpm run screenshot:mock --preset profile
pnpm run screenshot:mock --preset profile --viewport 390x844 --theme light --lang uk
```
