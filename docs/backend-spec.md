# Falky backend — iteration 1

**Status:** agreed in definition sessions on 2026-11-03 · **Scope:** `server/`, `api/`, `deploy/` · **Frontend:** out of scope

This spec narrows the original *Private Voice, Chat & Screen-Sharing Platform — Technical Specification v0.1* for the backend's first iteration. Where they disagree, this document wins; the original stays the background for media and infrastructure. Words follow [GLOSSARY.md](../GLOSSARY.md); lasting decisions live in [docs/adr](adr/).

## Problem statement

A small circle of friends (up to about five at once, usually all in one room) wants a private TeamSpeak-like place on a host they control: talk by voice, share screens, and keep a chat per room for links and notes. Building accounts and sign-in first would delay the part they actually want to use.

## Solution

One self-hosted server, reached through a secret **access link**. Opening the link and entering a name makes you a **visitor**; your browser remembers you. Visitors see the rooms, who is in each room's voice, and each room's chat. Joining a room's voice is an explicit action; inside it, visitors talk, mute, deafen and share screens through LiveKit. The Go server owns visitors, rooms, chat and LiveKit token issuance; LiveKit owns all media. The operator manages rooms and the access link from the command line.

## User stories

| ID | Story |
|---|---|
| S1 | As a person with the access link, I enter a name and I'm in, without creating an account. |
| S2 | As a returning visitor, my browser remembers me, so I come back without entering again. |
| S3 | As a visitor, I can change my name to any free name. |
| S4 | As a visitor, I see the rooms and who is in each room's voice. |
| S5 | As a visitor, I read a room's chat and scroll back through its history. |
| S6 | As a visitor, I post a message, and a retried send never shows up twice. |
| S7 | As a visitor, new messages, occupancy and room changes reach me without refreshing, and I catch up on what I missed after a disconnect. |
| S8 | As a visitor, I join a room's voice; joining another room moves me, and a second tab takes over from the first. |
| S9 | As a participant, I can talk, mute, deafen and share my screen, and others see that I'm deafened. |
| S10 | As the operator, I create and rename rooms and show or replace the access link; replacing it removes everyone at once. |
| S11 | As the operator, I deploy everything on one host with HTTPS and restart it without losing chat. |
| S12 | As the operator, I can tell whether the system is healthy and recover the chat from a backup. |

## Acceptance

**Entering and identity**
- **A1** (S1) Entering with the current link secret and a free name succeeds, sets the visitor cookie, and `GET /api/me` then returns that visitor and name.
- **A2** (S1) A wrong or replaced link secret is refused and sets no cookie. Repeated attempts from one IP beyond the limit get `429`.
- **A3** (S1, S3) A name already held by a connected visitor is refused with `name_taken`. Names are compared trimmed and case-insensitively.
- **A4** (S2) A returning visitor's cookie resolves to the same visitor ID. If another connected visitor holds their name, `GET /api/me` reports the conflict, and live updates and voice stay closed to them until they rename.
- **A5** (S3) After a rename, new messages carry the new name and earlier messages keep the old one. Renaming to a taken name is refused with `name_taken`.

**Rooms and chat**
- **A6** (S4) `GET /api/rooms` lists every room with its occupancy (participant visitor IDs and names).
- **A7** (S5) `GET /api/rooms/{id}/messages?before=<id>&limit=<n>` pages backwards, newest first. `?after=<id>` returns what came later, oldest first. The default limit is 50 and the maximum 100.
- **A8** (S6) Posting with a new request key creates a message with a server-assigned ID and order. Repeating the key with the same body returns the original message; repeating it with a different body is refused with `409`.
- **A9** (S5, S6) Unknown rooms answer `404`. Empty or over-long bodies are refused.

**Live updates**
- **A10** (S7) A connected visitor receives `message.created` within one second of the message being committed, and also receives `occupancy.changed` and `room.changed`. Every event uses the envelope `{v, type, eventId, roomId?, payload, timestamp}`.
- **A11** (S7) An upgrade from a foreign `Origin` is refused. A connection that stops answering heartbeats is closed. A client that falls behind is disconnected, then catches up with `after=`.

**Voice**
- **A12** (S8, S9) Joining a room's voice returns the LiveKit URL and a short-lived token for that room only. The token uses the visitor ID as identity and the name as display name. It may publish microphone, screen share and screen-share audio, subscribe, and update its own metadata.
- **A13** (S8) Joining room B while a participant in room A removes the visitor from A. Joining a room already at its cap (default 8) is refused with `room_full`.
- **A14** (S4, S7) Occupancy follows LiveKit within seconds of a join or leave. A webhook with a bad signature is refused and changes nothing. A dropped webhook is corrected by the next refresh, at most 30 seconds later.

**Operator**
- **A15** (S10) `falky room create <name>` and `falky room rename <id> <name>` take effect at once: the room list changes and `room.changed` is broadcast. Duplicate room names are refused.
- **A16** (S10) After `falky link rotate`, within about two seconds: old cookies are refused, every live connection receives `access.revoked` and closes, and every participant is removed from voice. `falky link show` prints the current link.
- **A17** (S11) Messages, rooms and visitors survive a restart of the server or its container.
- **A18** (S11) `docker compose up` serves HTTPS through Caddy. The server's internal listener, its admin socket and LiveKit's API are not reachable from outside.
- **A19** (S12) `/health/live` answers while the process runs. `/health/ready` answers when SQLite is open and migrated; LiveKit being unreachable shows up as degraded in the body, not as not-ready.
- **A20** (S12) A backup is a consistent SQLite snapshot, never a raw copy of a live WAL database, and a restore from it has been rehearsed.
- **A21** (S8, S9) Two browsers on different networks hear each other and see a screen share. With UDP blocked, media still flows through TURN or TCP, or the client gets a clear error.

## Constraints and exclusions

- **Host:** one x86-64 Linux host, about 2 vCPU and 2 GB RAM, running Docker Compose with pinned images. There is no Redis and no distributed LiveKit.
- **Secrets:** the LiveKit API secret never leaves the server. Tokens are minted only after a request resolves to a visitor.
- **Out of scope:**
  - **Clients:** the frontend (`web/` comes later) and the desktop client.
  - **Accounts and moderation:** accounts, invites, admin roles in the app, kicking individual visitors.
  - **Presence:** online indicators.
  - **Rooms:** text-only rooms and multiple servers.
  - **Messages:** editing, deleting, attachments, rich text.
  - **Media:** recording, end-to-end media encryption, server-side transcoding.

## Implementation decisions

All decisions are agreed unless marked *delegated*.

**D1 — Repository** ([ADR 0001](adr/0001-light-monorepo.md)). The layout is a light monorepo: `server/` (Go module), `api/openapi.yaml`, `deploy/`, `docs/`, and later `web/`.

**D2 — Contract.** `api/openapi.yaml` is written by hand and is the source of truth. The Go server interface is generated with oapi-codegen (strict server). Live-update event schemas live under `components.schemas`, so the client generates types for them from the same file.

**D3 — Go stack.**
- **HTTP and logging:** standard `net/http` routing and `log/slog`.
- **Database:** `modernc.org/sqlite` (pure Go, no cgo) in WAL mode, with one writer connection and a small read pool; migrations are embedded.
- **IDs:** ULID strings. Message IDs are generated under the writer so they sort in commit order and double as pagination cursors.

**D4 — Modules.** Each module owns its tables; there is no shared storage layer.

| Module | Interface | Owns |
|---|---|---|
| `identity` | `Enter(linkSecret, name)`, `Resolve(request) → Visitor`, `Rename`, `Rotate`; tracks connected visitors for name uniqueness | `access`, `visitors`, `visitor_tokens` |
| `rooms` | `List`, `Create`, `Rename`, `Authorize(visitor, room, action)`, which is the single access check (allows everything in this iteration) | `rooms` |
| `chat` | `Post(visitor, room, requestKey, body) → Message`, `History(room, cursor)` | `messages` |
| `voice` | `Join(visitor, room) → credentials`, `Occupancy(room)`, webhook intake, refresh loop, `RemoveAll`; LiveKit adapter plus an in-memory fake | (in-memory view only) |
| `realtime` | live-update hub: connections, authorized fan-out, heartbeat, dropping slow clients; `Publish(event)` | — |
| `httpapi` | implements the generated interface; thin, no business logic | — |
| `platform` | config, SQLite and migrations, logging, metrics, health | — |

`cmd/falky` provides `serve`, `migrate`, `room create|rename` and `link show|rotate`.

**D5 — Events.** `chat`, `voice`, `rooms` and `identity` publish to `realtime` in-process, after their commit. There is no outbox; a lost broadcast is recovered by the client's `after=` catch-up.

**D6 — Chat is posted over HTTP only.** The live-update connection carries server-to-client events only.

**D7 — Access** ([ADR 0003](adr/0003-access-link-instead-of-accounts.md)). One secret access link. The visitor cookie is `HttpOnly`, `Secure` and `SameSite=Strict`. A visitor's access belongs to the current link generation, and rotating the link ends every generation-bound access at once.
- *Delegated:* the cookie holds a random token whose hash is stored server-side. Do not use self-contained signed cookies, so that per-visitor revocation stays possible later.

**D8 — Link secret in the URL fragment.** The link has the form `https://<host>/#k=<secret>`, and the client exchanges it through `POST /api/enter`. Browsers never send the fragment to servers, so the secret stays out of proxy logs and `Referer` headers.

**D9 — Names.**
- A visitor is *connected* while they hold at least one live-update connection.
- Entering reserves the name for 60 seconds until the first connection opens, so two people can't claim the same name at once.
- Names are 1–32 characters after trimming, with no control characters, compared case-insensitively. *Delegated:* these exact limits.

**D10 — Voice.**
- **Identity:** the LiveKit identity is the visitor ID, so a second tab replaces the first.
- **One room per visitor:** joining another room removes the visitor from the previous one first.
- **Screen share:** any participant may share.
- **Deafen:** deafened means also muted, and is published through the participant's own metadata or attributes, so other participants can see it.
- **Room cap:** configurable, default 8.
- **Token lifetime:** short (*delegated*: about 10 minutes), because the token is only needed to connect.

**D11 — Occupancy** ([ADR 0002](adr/0002-voice-occupancy-from-livekit.md)). Occupancy is never stored. The server keeps an in-memory view fed by signed LiveKit webhooks and refreshed from LiveKit's participant listing at startup and every 30 seconds. Visitors outside a room see names only. Mute, deafen and screen-share state is visible only inside the room, through the LiveKit SDK.

**D12 — Listeners.**
- **Public HTTP listener:** proxied by Caddy; serves `/api/*`.
- **Internal listener:** on the Compose network only; serves the LiveKit webhook, `/metrics` and health checks.
- **Admin Unix socket:** inside the container, used by `falky room …` and `falky link …` so their effects are immediate.

**D13 — Limits.**
- Entering is rate-limited per IP, using the client IP taken only from Caddy's forwarded header.
- Posting is rate-limited per visitor.
- Messages are 1–4000 characters.
- *Delegated:* the exact rates.

**D14 — HTTP surface** (the first draft of `api/openapi.yaml`):

| Endpoint | Purpose |
|---|---|
| `POST /api/enter` | Link secret plus name; sets the visitor cookie |
| `GET /api/me`, `PATCH /api/me` | Current visitor and name conflict; rename |
| `GET /api/rooms` | Rooms with occupancy |
| `GET /api/rooms/{id}/messages` | History, `before=` or `after=` |
| `POST /api/rooms/{id}/messages` | Post, idempotent by request key |
| `POST /api/rooms/{id}/voice` | LiveKit URL and token |
| `GET /api/live` | Live-update WebSocket |
| internal `POST /livekit/webhook`, `GET /metrics`, `GET /health/live`, `GET /health/ready` | Internal listener only |

**D15 — Schema sketch.**

```text
access(id = 1, link_secret_hash, generation, rotated_at)
visitors(id, name, created_at, last_seen_at)
visitor_tokens(token_hash, visitor_id, generation, created_at)
rooms(id, name UNIQUE, created_at)
messages(id, room_id, author_id, author_name, body, request_key, created_at,
         UNIQUE(author_id, request_key))
```

**D16 — Tooling.**
- **Toolchain:** `mise.toml` at the repo root pins Go (latest stable at setup time, also set in `go.mod`) and golangci-lint. Go-based tools (oapi-codegen, govulncheck, the OpenAPI linter if it is a Go binary) are pinned with `go.mod`'s `tool` directive and run with `go tool …`.
- **Task runner:** a `Makefile` with the targets `check`, `fmt`, `lint`, `test`, `test-integration` and `generate`.
- **The done condition:** `make check` runs formatting, build, vet, golangci-lint, `go test -race ./...` and govulncheck. From slice 01 it also regenerates code and fails on any diff, and lints `api/openapi.yaml`. Every slice ends with `make check` passing.
- **No git hooks and no CI for now.** The local `make check` is the only gate.
- *Delegated:* golangci-lint v2 defaults plus gofumpt, errorlint, bodyclose and noctx, with no line-length rule. Tests use the standard `testing` package without an assertion library and with no coverage threshold.

## Testing decisions and verification

- **Modules:** each is tested through its interface against a real temporary SQLite file. `voice` is tested against its in-memory LiveKit fake, plus the real adapter against `livekit-server --dev` in Docker.
- **HTTP:** tests go through `httptest` with the generated client, so responses are checked against `api/openapi.yaml`. These cover A1–A9, A12, A13 and A15–A16.
- **Live updates:** tests use a real hub over a real WebSocket, covering A10, A11 and A16 (receiving `access.revoked`).
- **Occupancy:** tests use signed and unsigned webhook fixtures plus a refresh after a dropped webhook (A14).
- **Media:** manual evidence for A21 in two browsers on different networks, plus `lk load-test` for five participants on the target host. The findings are recorded in `docs/`.
- **Commands** (to be created in slice 00 and extended in 01): `mise install`, `make check`, `make test-integration` (needs Docker; uses the `integration` build tag), `make generate`, and `docker compose -f deploy/compose.yaml up`.

## Proposed slices

This is the agreed starting order for `/slice`. Each slice ends with `make check` passing.

| # | Slice | Outcome | Blocked by |
|---|---|---|---|
| 00 | Environment | `mise.toml`, `Makefile`, golangci-lint config, an empty `server/` Go module with one trivial test; `mise install && make check` passes from a clean clone (D16) | — |
| 01 | Scaffold | `falky serve` with health endpoints, config, logging, SQLite with embedded migrations, `api/openapi.yaml` with code generation; `make check` gains the generated-code diff check and contract lint; Dockerfile | 00 |
| 02 | Media spike | A short write-up in `docs/` confirming or refuting each LiveKit claim under *Open choices*, using `livekit-server --dev` and the `lk` CLI | — |
| 03 | Entering | Access link, `falky link show`, `POST /api/enter`, `/api/me` with rename, cookie, name rules, rate limit, admin socket (A1–A5) | 01 |
| 04 | Rooms | `falky room create/rename`, `GET /api/rooms`, `rooms.Authorize` (A15 without broadcasts) | 03 |
| 05 | Chat | Duplicate-safe posting, `before`/`after` history (A7–A9, A17) | 04 |
| 06 | Live updates | Hub, Origin check, heartbeat, dropping slow clients, `message.created`/`room.changed`, connected visitors for name conflicts (A4, A10, A11) | 05 |
| 07 | Voice join | Token and grants, room cap, moving between rooms, LiveKit adapter and fake (A12, A13) | 04, 02 |
| 08 | Occupancy | Internal listener, signed webhooks, refresh loop, occupancy in the room list, `occupancy.changed` (A6, A14) | 06, 07 |
| 09 | Link rotation | Old cookies refused, `access.revoked`, everyone removed from voice (A16) | 06, 07 |
| 10 | Local deploy | Compose with Caddy, LiveKit and the server, the chosen UDP strategy, nothing internal exposed (A18, A19) | 01, 02 |
| 11 | Backups and ops | Consistent snapshot, rehearsed restore, log rotation, runbook (A20) | backup method (open) |
| 12 | End-to-end check | Two browsers on different networks, restricted UDP, a 5-participant load test on the host (A21) | 08, 09, 10, a host |

## Repository context

- **Repository:** `/home/kisshot/development/falky`, branch `master`, revision `0901cc0` (skills only, no code yet), no remote.
- **Tooling:** mise 2026.10.8, GNU Make and Docker 29.7 are installed; Go and golangci-lint are not (mise will install them).

## Open choices and unverified claims

- **LiveKit behaviour, to verify in the media spike before D10/D11 work starts:**
  - webhook signing and its event set;
  - token grants limiting which sources may be published;
  - a duplicate identity replacing the older connection;
  - a participant updating its own metadata;
  - server-side token refresh during long sessions;
  - removing a participant from the server side.
- **Backup method:** Litestream to S3-compatible storage, or nightly `VACUUM INTO` plus off-host copies. This depends on the hosting provider and blocks A20.
- **Hosting and domain:** the provider, region, egress quota and domain names. This blocks deploying to the VPS, not local Compose.
- **Metrics:** `/metrics` in Prometheus format is agreed; what scrapes it on a 2 GB host is open.
- **Go module path:** `github.com/kisshot/falky/server` unless you choose otherwise.
