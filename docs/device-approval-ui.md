# Device approval UI integration

The production UI supports QR approval and sign-in links through the existing
cookie-authenticated API. The welcome screen retains passkey and recovery entry.
Settings → Account creates links inline; Scan QR code opens a separate fullscreen
reader. Camera capture begins on **Use camera**. Detection only previews a request;
approval and denial require explicit actions. Back and Done return to Account and
focus the enabled Scan action after account loading and modal transitions finish.

## Baseline API audit

Audited revision: `28a0b84d91f85ad5c0abefd8dca61243e9c2bc24`
([backend PR #66](https://github.com/Luckmorecat/falky/pull/66)). The protocol is
[OpenAPI](../api/openapi.yaml), with security policy in
[ADR 0005](adr/0005-device-approval-authentication.md). This integration changes no
backend code, public schema, deadlines or security policy. Review found no concrete
exploitable backend vulnerability; that conclusion is limited to the inspected
implementation/tests and local walkthrough, not a penetration or deployment audit.
Baseline identity and HTTP race suites passed before implementation.

The following properties are supported by the baseline implementation and tests:

| Property | Evidence and consequence |
| --- | --- |
| S01: code selects a request | `identity/device_approval.go` verifies both issuer account and exact session. Codes are unique per link, allow leading zeroes and revoke at five persisted failures. A code alone is not an account credential. `TestDeviceLinkCapacityDenialStableZeroCodeAndExactIssuer` and `TestDeviceBudgetCooldownAndStateSurviveRestart` exercise this boundary. |
| S02: independent browser binding | `httpapi/device_approval.go` uses a Secure, HttpOnly, SameSite=Strict `__Host-falky-signin` cookie. Request IDs, codes and approval bearers cannot substitute for it. `TestDeviceWrongFlowAndSelectorCannotAuthorizeBrowser` and `TestDeviceApprovalLinkHTTPDeliveryAndBinding` cover replay and delivery. |
| S03: one issuance, bounded redelivery | The identity transaction atomically consumes approval and creates one session/authentication event. Encrypted delivery binds request, flow, session and expiry to the independent browser secret. Concurrency, crypto and restart tests cover a single winner, tampering and same-session retry. Aborting HTTP does not prove rollback. |
| S04: ordinary account access | Device approval grants no recent credential-management proof. `TestDeviceCredentialChangesRequireReceivingSessionPasskey` requires the receiving session's own passkey proof before key/recovery changes. Legacy flags do not bypass this. |
| S05: approval-chain revocation | `identity/session_authentications.go` and device revocation tests preserve passkey provenance, cancel unredeemed approvals and revoke dependent sessions when their origin credential ends. Completed sessions survive ordinary issuer logout; they do not acquire new provenance through reauthentication. |
| S06: active-session protection | Begin and finish reject a conflicting account; same-account begin is also rejected. Initial guest → account completion is allowed. Consumed retries cannot overwrite a newer guest/session. Account-conflict and consumed-retry tests cover these distinctions. |
| S07: origin and bearer handling | Account HTTP protection checks configured Origin, JSON shape/body limits and no-store responses. Bearers travel in JSON bodies or configured-origin fragments, never API paths/queries. HTTP tests cover strict bodies, origin checks and candidate admission. |
| S08: sanitized exact-scope updates | `httpapi/live.go` sends initial pending-request snapshots to the exact issuer session. Private events contain IDs/state/version/UA/times, without bearer or code. Realtime/live tests cover scoping, bounded streams and original deadlines. Events are hints followed by authoritative reads. |
| S09: absolute expiry | Five-minute creation deadlines govern reads, approval and finish independently of maintenance. Resume/resend never extend them. Maintenance wipes expired secrets and retains only appropriate sanitized history; restart/maintenance tests exercise this. |
| S10: separate bounded budgets | Anonymous allocation/operation traffic has independent limits, browser/IP quotas and actual Retry-After. Cookie quotas are intentionally client-resettable and restart-resettable; IP quota and authorization remain independent. Persistent wrong-code failures and resend cooldown survive restart. Distributed load/proxy-IP correctness was not tested. |

Source paths above are under `server/internal/`. Relevant test families are
`identity/device_approval_{security,concurrency,crypto,restart,revocation,maintenance}_test.go`,
`httpapi/device_approval*_test.go` and `realtime/device_approval_test.go`.

The production frontend resolves the baseline integration gaps as follows:

| Finding / impact | Implemented handling and remaining limitation |
| --- | --- |
| G01: missing device entry links | Capture/scrub `signin` and `qr-signin` fragments before async bootstrap; exact-origin/root/one-token validation. Authority remains in memory, including signed-out approver authentication. Scanned URLs are never navigated. Existing guest/invitation/recovery entry remains intact. |
| G02: missing adapters/state/private events | Typed HTTP adapters, candidate/issuer/approver stores, original deadlines, private hints and authoritative polling. Cookie-backed session reconciliation performs adoption; rendering completion alone does not authenticate. |
| G03/G12: untrusted browser description and transferable QR/link | Escaped user-agent text and a self-started-request warning; real account identity and explicit approval. No invented model/location, proximity guarantee or scan-implies-trust claim. A QR can be forwarded. |
| G04: unrecoverable creation bearer | Keep copy URL only in memory. Reload recovers sanitized pending requests from private snapshots, allowing approve/deny/revoke without copying. An empty open link has no initial request snapshot/list API; creating a replacement is explicit and cancels the old link. |
| G05/G10: hidden attempt count and generic failures | Explain the five-error policy, preserve four ASCII digits as a string, reread server state after rejection. Show known denial/cancellation, expiry from saved deadline, otherwise neutral unavailable text. No invented attempts remaining or distinct lockout reason. |
| G06: QR-only candidate cancellation | QR Back uses DELETE. Link Back abandons local completion/authority; it cannot promise server cancellation. Issuer deny/revoke or the fixed deadline ends the request. |
| G07: shared cookies and first-allocation races | Web Locks serialize allocation where available; local fallback, session epochs and authoritative session checks fence stale work. Independent first requests can still race a shared binding cookie; binding loss fails closed and offers explicit restart. No global uniqueness promise. |
| G08: uncertain completion | Reconcile actual `/accounts/session` after lost finish, retry the same request before its original deadline, and never assume an aborted request rolled back. Session changes and disposal stop stale polling/approval. |
| G09: camera/decoder lifecycle | Local deferred ZXing encoder/decoder; permission on user intent, accessible errors/retry and secondary collapsed paste fallback. Stop tracks/decoder and detach video on detection, exit, replacement, session loss, unmount and late permission resolution. |
| G11: guest/account conflicts | Explicit receiving consent preserves current session until approval. Existing account-switch rules remain authoritative, with no silent logout. Issuer approval never adopts the candidate's session. |

The scanner return-focus defect found during integration is covered by a browser
regression holding the Account passkey refresh pending: Scan remains disabled until
usable, then receives focus after Done. Back is covered too. Normal Account tab
selection keeps its normal tab focus.

## Verification and limits

- `make check-web`: frozen install, generated-schema freshness, 211 Vitest tests,
  runtime selection/production mock-exclusion assertions and production build.
- `pnpm run typecheck` includes production, mock, browser helpers and tooling;
  `pnpm run test:mock` covers 19 fixture tests.
- `smoke/accounts.spec.ts` retains the nine existing passkey, recovery, guest,
  shared-cookie and sensitive-operation browser regressions.
- `smoke/device-signin.spec.ts` covers separate QR/link candidate cookie contexts,
  explicit approval, exact unchanged issuer cookies, three requests/leading `0000`,
  wrong code/fifth-error revocation, private reload recovery without copy authority,
  denial/expiry/revoke/cooldown, passkey auth-resume, uncertain finish, guest/account
  conflicts, shared-cookie scanner exit and accessible scanner failure/late exit.
  The mock camera event proves UI plumbing, not physical capture or decoding.
- Camera runtime tests independently cover late permission release, ordinary bad
  frames, fatal decoder cleanup, stopped tracks and suppressed late callbacks.
- The unchanged Go backend was also exercised with a fresh SQLite database,
  attachments/snapshot directory and admin socket under `/tmp`, separately allocated
  loopback ports and a matching `http://localhost:<port>` origin. Actual invitation
  creation and Chromium virtual WebAuthn registered an issuer. Independent receiving
  contexts completed both QR and link/code sign-in. Reload recovered the link's
  pending request without its creation bearer. Exact issuer cookies stayed unchanged;
  receiving credential enrollment was refused with 403 without recent passkey proof.
- For actual decoder evidence, the genuine receiver QR SVG was drawn repeatedly to
  a canvas captured as a MediaStream, supplied through `getUserMedia` to the real
  production scanner. ZXing decoded its video frames; detection stopped the track
  and detached video before explicit approval. This uses synthetic camera frames,
  not a physical phone camera or an operating-system permission prompt.
- Existing screenshot tooling captured welcome, QR/code, inline issuer/pending and
  fullscreen scanner at 1440 desktop and 320/390 mobile widths, English/Ukrainian,
  light/dark themes. PNGs were visually inspected; no horizontal overflow. Scanner
  intentionally keeps its dark camera surface in either theme. Narrow Account
  content scrolls vertically so pending controls remain reachable.

Physical cameras, real passkey hardware, Safari/Firefox camera behavior, deployment
headers/proxy logs, distributed resource limits and clock skew remain untested.
LiveKit was not connected or used as authentication evidence. Temporary voice
configuration was a local placeholder; all owned server/browser processes were
closed. No shared staging state was mutated.

## Reproducing local evidence

From `web/`, use the shared launcher/browser/authenticator helpers in `smoke/`:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium pnpm exec playwright test smoke/accounts.spec.ts smoke/device-signin.spec.ts
pnpm run screenshot:mock --preset device-qr --viewport 320x844 --theme light --lang uk
pnpm run screenshot:mock --preset device-code --viewport 390x844 --theme dark
pnpm run screenshot:mock --preset device-issuer --viewport 320x844 --theme light --lang uk
pnpm run screenshot:mock --preset device-scanner --viewport 390x844 --theme dark
```

The device presets use actual production UI and mock HTTP clients. Issuer captures
scroll its actual pending request/code into view. Each command owns and closes its
mock/browser. Screenshots belong in ignored `web/screenshots/` or `/tmp`.

For interactive mock review, run `pnpm run dev:mock`, open its printed app URL using
`localhost` for virtual WebAuthn, and select/reset the `signed-out` scenario through
the printed mock controls. Open `/#invite=mock-invitation`, register with a browser
passkey/virtual authenticator, acknowledge the recovery kit, then Settings → Account.
Use another independent browser context for the receiving welcome/QR or generated
link. The second account fixture invitation is `mock-invitation-second`. These are
mock-only fixtures; production has no query gate or simulation controls.

For a real backend walkthrough, build `server/cmd/falky` into `/tmp`, create a fresh
temporary directory and set all of `FALKY_DB_PATH`, `FALKY_ATTACHMENT_ROOT`,
`FALKY_SNAPSHOT_DIR` and `FALKY_ADMIN_SOCKET` inside it. Reserve unused loopback API
and Vite ports; never attach to existing listeners. Set `FALKY_PUBLIC_ADDR` to the
reserved API listener, `FALKY_INTERNAL_ADDR=127.0.0.1:0` and
`FALKY_PUBLIC_ORIGIN=http://localhost:<vite-port>`. Supply local placeholder
`FALKY_LIVEKIT_API_KEY`/`FALKY_LIVEKIT_API_SECRET` and point its API at an unused local
port. Start `falky serve`, then Vite using the normal config with `/api` proxy
pointing at the reserved API port, and a separate temporary `cacheDir` to isolate
optimization from mock launches. Probe `/api/accounts/session` (401 is expected
before authentication), not LiveKit readiness. Run `falky invitation create` with
the same admin socket, keep its bearer in memory and complete registration using
`smoke/account-browser.ts`'s `virtualAuthenticator`. Run the same UI actions as the
browser suite with independent contexts; the real server chooses its own code.
Check receiving and issuer sessions/cookies through HTTP, then close every owned
browser/context, Vite server and Go process in `finally`.

For reproducible synthetic decoding, obtain the receiver's genuine `.device-qr`
SVG in memory, draw it at 480×480 in a 640×640 white canvas, and supply
`canvas.captureStream(15)` from an overridden `getUserMedia` in the issuer page.
Redraw every 100 ms until its track ends, since an unchanged canvas may emit no new
video frames. Do not dispatch the mock scanner event or paste the token for this
check. Assert zero capture calls before Use camera, preview before approval,
ended tracks and detached video after detection, then perform explicit approval.
This harness replaces the input device only; the real browser video, local decoder,
trusted URL parser and Go API still execute. Do not persist/log bearer URLs, codes,
recovery material or credential private keys when retaining evidence.
