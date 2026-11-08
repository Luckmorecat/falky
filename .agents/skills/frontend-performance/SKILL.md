---
name: frontend-performance
description: Use when collecting or comparing Falky loading metrics or INP with the JSON performance runner.
---

# Frontend performance

Produce JSON measurements and an assessment tied to the measured workload and
environment. Collect and assess reports; change application code only when the
request includes fixes.

## Choose the measurement

Run from the repository's `web/` directory. Use the locked frontend dependencies
and Playwright Chromium. An existing browser can be selected with
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. If an essential dependency or browser is
unavailable, report the missing prerequisite rather than substituting estimates.
Read `pnpm run profile:performance --help` for current options and bounds.

- Use the default isolated mock for reproducible local workloads. Its timings
  include development React, Vite and simulated services; production loading or
  compression claims require a production target.
- Use `--url` for an existing deployment or locally served production build.
  Authentication must already be available through `--storage-state` when
  required. The runner preserves existing preferences and does not automate login.
  For this mode, the report's Git revision describes the local checkout; establish
  the deployed revision separately when comparing application changes.
- Use the chat/settings flow to measure INP through keyboard and click input.
  It types and clears an unsent draft, without posting messages or joining voice.
  Use `--flow none` for loading-only measurements, including the entry fixture;
  an unavailable INP is expected there.

## Collect and compare

Choose the fixture, viewport, throttling and target to match the question. Run
profiles serially, separate from builds/tests. For before/after comparisons, keep
the workload, browser, environment, site content and preferences comparable.
Preserve the baseline and write the next measurement to a different path.

Example baseline and comparison, using the default three fresh browsers per run:

```sh
pnpm run profile:performance --output profiles/before.json
pnpm run profile:performance --compare profiles/before.json --output profiles/after.json
```

These commands own and close their mock server and browsers. JSON goes to stdout
and the output file; progress goes to stderr. Reports belong in ignored
`web/profiles/` or a requested artifact location. Existing JSON reports can be
assessed without rerunning the workload.

## Assess the evidence

Check the command's exit status and the report's `status`, `summary`, `runs` and
environment before drawing conclusions. A failed run has no new complete report;
an older file at the same path is not evidence of success. If expected metrics are
missing, explain the gap rather than treating `null` as zero.

Use comparison deltas when `comparison.compatible` is true. Otherwise report
the mismatched workload/environment and withhold an improvement/regression claim.
Collect matching runs when measurement is in scope; an existing-report assessment
can finish by identifying the missing evidence. Report medians, observed ranges,
measured/unavailable run counts and the JSON paths. Positive timing or CLS deltas
mean worse results; a percentage can be unavailable when its baseline is zero.

INP comes from `web-vitals` Event Timing entries over a finite lab observation
window. Scripted action windows are automation timings, not INP. The loading
snapshot precedes the flow; final CLS/INP can include interactions. Interpret
these as lab measurements, not whole-visit field INP or field p75 scores.
