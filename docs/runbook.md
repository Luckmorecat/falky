# Runbook

How to run the Falky stack on one host: deploying it, checking its health,
the operator commands, snapshots and restoring them, logs, and what else to
keep safe.

The stack is `deploy/compose.yaml` (Compose project `falky`). Caddy serves
HTTPS and proxies the API and LiveKit's signalling, LiveKit carries voice and
screen share, and the server (service `falky`) keeps the rooms, chat and
visitors. Run every `docker compose` command below in `deploy/`, where Compose
finds `compose.yaml` and `.env` without flags.

The server image has no shell and no `sqlite3`. Everything goes through
`/falky` in the server's container, `docker compose cp`, or a throwaway
container with a volume mounted.

## Deploy

1. Point the domain's DNS at the host. Open TCP 80 and 443, UDP 443 (HTTP/3),
   TCP 7881 and UDP 7882 (voice and screen-share media) to the host. Nothing
   else needs to be reachable.
2. Write `deploy/.env` from the template, and keep it readable by you only:

   ```sh
   cp .env.example .env
   chmod 600 .env
   ```

   Fill in:
   - `FALKY_DOMAIN`, the domain visitors use. Caddy gets its certificate.
   - `LIVEKIT_NODE_IP`, the host's public address, where clients send media.
   - The LiveKit key pair that LiveKit and the server share. The secret must
     be at least 32 characters, letters and digits only:

     ```sh
     echo "FALKY_LIVEKIT_API_KEY=falky$(openssl rand -hex 6)"
     echo "FALKY_LIVEKIT_API_SECRET=$(openssl rand -hex 32)"
     ```

3. Build and start the stack, waiting until every service is up and the
   server is ready:

   ```sh
   docker compose up -d --build --wait
   ```

   On its first start the server creates the database and the access link.

4. Print the access link and hand it to the people who should get in. Create
   the rooms:

   ```sh
   docker compose exec falky /falky link show
   docker compose exec falky /falky room create "Living room"
   ```

To upgrade, take a snapshot first (see *Snapshots*). Then update the checkout
and run `docker compose up -d --build --wait` again. The server applies new
database migrations when it starts. An older `falky` cannot restore a
snapshot taken after an upgrade that added migrations.

## Health

`docker compose ps` shows `falky` as `healthy` while the server is ready.
Compose runs `falky health ready` every 30 seconds. To ask yourself:

```sh
docker compose exec falky /falky health ready
docker compose exec falky /falky health live
```

Each prints the server's report, for example
`{"components":{"database":"ok","livekit":"ok"},"status":"ok"}`, and fails
unless the server answered 200.

- `live` means the process is up and answering.
- `ready` fails, with `unavailable`, when the database cannot be used.
  Nothing that needs the database works then.
- `degraded`, for `livekit` and overall, means the server cannot reach
  LiveKit. It stays ready: entering, chat and live updates work, and only
  voice fails. Look at `docker compose logs livekit`.

The health endpoints, `/metrics` and LiveKit's webhooks are on the server's
internal listener. Caddy does not proxy it, so only containers on the Compose
network reach it.

## Operator commands

Each runs against the running server through its admin socket, which only the
server's own user inside the container can open:

```sh
docker compose exec falky /falky <command>
```

| Command | What it does |
| --- | --- |
| `link show` | Prints the access link. |
| `link rotate` | Replaces the access link and prints the new one. It ends every visitor's access at once: their cookies are refused, their live updates close and their voice ends. Everyone must enter again through the new link. To also stop voice tokens handed out before, see *Full rotation*. |
| `room create "<name>"` | Creates a room and prints its ID. Keep the ID for renaming. |
| `room rename <id> "<name>"` | Renames a room. Visitors see the new name at once. |
| `snapshot` | Takes a snapshot of the database (see *Snapshots*). |
| `health live\|ready` | See *Health*. |

Room names are unique, ignoring case and surrounding spaces. Quote names that
have spaces. `restore` is the one command that runs while the server is
stopped (see *Restore*).

### Full rotation

`link rotate` ends everyone's voice, but LiveKit cannot take back a voice
token it has handed out. A visitor may have kept one from before the rotation,
and a modified client could rejoin voice with it until the server's check
removes it again, as often as it tries. Replacing LiveKit's key pair as well
ends that: LiveKit then refuses every token signed with the old pair. Do a
full rotation instead of `link rotate` when someone who should no longer get
in may have joined voice before, for example after the link leaked.

1. Rotate the link:

   ```sh
   docker compose exec falky /falky link rotate
   ```

2. Write a new key pair into `deploy/.env`, replacing the lines
   `FALKY_LIVEKIT_API_KEY=` and `FALKY_LIVEKIT_API_SECRET=`. Generate it with
   the same commands as in *Deploy*:

   ```sh
   echo "FALKY_LIVEKIT_API_KEY=falky$(openssl rand -hex 6)"
   echo "FALKY_LIVEKIT_API_SECRET=$(openssl rand -hex 32)"
   ```

   Update your private copy of `deploy/.env` too (see *What else to keep*).

3. Recreate `livekit` and `falky` with the new pair, waiting until the server
   is ready:

   ```sh
   docker compose up -d --wait
   ```

4. Check that the server is ready and that LiveKit accepts the new pair: the
   report shows `livekit` as `ok`, not `degraded`:

   ```sh
   docker compose exec falky /falky health ready
   ```

5. Hand out the new link, which `docker compose exec falky /falky link show`
   prints.

What it costs: everyone's voice ends and everyone must enter again through
the new link, as with `link rotate`. The server and LiveKit restart, so for a
few seconds the API does not answer, and the live updates of anyone who
already entered again close and reconnect.

## Snapshots

A snapshot is a consistent copy of the whole database as of one moment, taken
while the server keeps running and visitors keep posting:

```sh
docker compose exec falky /falky snapshot
```

It prints where the snapshot went, for example
`/snapshots/falky-20261104T014919Z.db`, named after the UTC time. Never copy
`falky.db`, `falky.db-wal` or `falky.db-shm` out of the data volume instead:
while the server runs, those files are not a consistent database.

Snapshots go to the volume `falky_falky_snapshots`, mounted at `/snapshots`,
which is kept apart from the live database. Each file can be read and written
by the server's user only (mode 0600). A snapshot never replaces an existing
file: two in the same second fail the second time, so try again.

Copy a snapshot out of the stack, keeping its mode:

```sh
docker compose cp falky:/snapshots/falky-20261104T014919Z.db .
```

Snapshots stay in the volume until you delete them. List or delete them from
a throwaway container, for example with the Caddy image the stack already
uses:

```sh
caddy=$(docker compose config --images | grep '^caddy:')
docker run --rm -v falky_falky_snapshots:/snapshots --entrypoint ls "$caddy" -l /snapshots
docker run --rm -v falky_falky_snapshots:/snapshots --entrypoint rm "$caddy" /snapshots/falky-20261104T014919Z.db
```

Do this only while the volume exists, that is, after the stack has been up
once. Otherwise Docker creates the volume for the throwaway container, owned
by root, and `falky snapshot` then cannot write there.

### A snapshot holds the access link

A snapshot holds everything in the database: rooms, messages, visitors
(their cookie tokens only as hashes), and the access link's secret in plain
form. Anyone who has a snapshot can enter until the link is next rotated.
Keep snapshots as private as `deploy/.env`.

## Restore

A restore makes a snapshot the database in a fresh data volume, with the
server stopped. Everything posted after the snapshot was taken is lost.

1. Have the snapshot on the host, copied out as above. If the current
   database might still be needed, take a snapshot of it and copy that out
   too.
2. Stop the stack. The volumes stay. Container logs are deleted with the
   containers, so save any you need first (see *Logs*).

   ```sh
   docker compose down
   ```

3. Delete the current database:

   ```sh
   docker volume rm falky_falky_data
   ```

   Do not mount the new, empty volume into any other container before the
   next step. Docker copies that image's directory into an empty volume and
   takes its owner, after which the server cannot write there. If it
   happened, delete the volume again.

4. Restore the snapshot, passing it on standard input:

   ```sh
   docker compose run --rm --no-deps -T falky restore < falky-20261104T014919Z.db
   ```

   This creates the volume and checks the snapshot before using it: the
   SQLite integrity check, and that this version of `falky` knows every
   migration in it. It refuses, and leaves the volume empty, when the check
   fails (`bad snapshot: the integrity check failed`) or the snapshot comes
   from a newer `falky` (`it has migrations this falky does not know`). It
   also refuses when the volume already holds a database or its `-wal` or
   `-shm` file, so nothing of an old database is mixed in. On success it
   prints `restored the snapshot as /data/falky.db; start the server on it`. A snapshot from an older
   `falky` is fine: the server migrates it when it starts.

5. Start the stack:

   ```sh
   docker compose up -d --wait
   ```

6. Check `falky health ready`, the rooms and the latest messages. The access
   link and the visitors' cookies are the ones the snapshot held, so visitors
   who entered before the snapshot are let in again.

If the snapshot was restored from a copy that may have leaked, rotate the
link right after: `docker compose exec falky /falky link rotate`.

## Logs

```sh
docker compose logs falky          # or caddy, livekit
docker compose logs -f --since 1h falky
```

All three write JSON lines. The backend uses structured `slog` JSON on stdout.
`FALKY_LOG_LEVEL` in `deploy/.env` sets its minimum level (default `info`);
apply a change with `docker compose up -d falky`. Use `debug` for upgrade
refusals, `info` for request completions, connection lifecycle and recovery,
`warn` for voice outages, failed health probes and refused webhooks, and
`error` for unexpected request/admin failures. Raising the minimum level
also hides lower-level request records; responses still carry request IDs.

Every HTTP response, including a WebSocket upgrade, has a server-generated
`X-Request-ID`; client-supplied IDs are ignored. Copy this header from the
browser's Network panel to find the request and its related errors:

```sh
request_id='COPY_X_REQUEST_ID_HERE'
docker compose logs --no-log-prefix falky | jq -c --arg id "$request_id" 'select(.request_id == $id)'
```

A public `http request completed` record contains `request_id`, `listener`,
`method`, `route`, `status`, and `duration_ms`. Routes are fixed templates
such as `/api/rooms/{id}/messages`; unknown routes and redirects use
`unmatched`. Unknown HTTP methods use `OTHER`. Request summaries contain no
path parameters or query strings. Names, message bodies, cookies, tokens,
and access links are excluded from logs.
`client_ip` appears only on public 401, 403 and 429 completions, from the
validated last `X-Forwarded-For` address supplied by Caddy. Malformed values
are omitted. IPv6 logs use the actual address; the existing rate limiter
still groups IPv6 clients by /64. Internal probes and WebSocket lifecycle
records have no client IP.

WebSocket upgrade completions use status 101 and measure the handshake.
`live connection opened` and `live connection closed` share `request_id`
and `connection_id` with that response. Close records have `lifetime_ms`,
`close_code`, and a fixed `reason`, such as `peer_closed`, `write_failed`,
`heartbeat_timeout`, `slow_consumer`, `access_revoked`, or `shutdown`.
Peer-supplied close text is omitted; there are no per-message records.

Errors use safe `error_kind` categories instead of raw error messages:
for example `connection_refused`, `timeout`, `permission_denied`,
`sqlite_<numeric code>`, or `livekit_<Twirp code>`. The event, component,
room/visitor IDs when available, and request ID provide context. Health
probes and occupancy refreshes log the first failure, a changed category,
and a reminder at most once a minute for an unchanged category. A later
success logs one recovery, with `suppressed` counting omitted repeats.
Healthy probes and metrics requests stay quiet. Each failed voice join has
one correlated warning in addition to its HTTP completion.

Docker keeps each container's log with the `json-file` driver and rotates it
at 10 MB, keeping three files per container. Each log is kept on the host
under `/var/lib/docker/containers/`, and
`docker inspect --format '{{.LogPath}}' falky-falky-1` names the file. A
log is deleted with its container, for example by `docker compose down`.
Retention is bounded by log volume, not by time: busy periods replace old
records sooner. There is no guaranteed number of days of history.

## What else to keep

Snapshots cover the database. Two more things matter when moving or
rebuilding the host:

- **`deploy/.env`.** It is not in Git or in snapshots, so keep a private
  copy, for example in a password manager. If it is lost, write it again:
  - The domain and the node IP can simply be written again.
  - A new key pair works, but only once both `livekit` and `falky` have
    restarted with it. `docker compose up -d` recreates both. Voice tokens
    handed out before stop working, so participants join voice again. This
    is also how *Full rotation* ends held voice tokens.
- **The volume `falky_caddy_data`.** It holds Caddy's certificates and its
  ACME account. If it is lost, Caddy requests new certificates when it
  starts. Certificate authorities limit how often they issue them (Let's
  Encrypt allows only a few certificates for the same names each week), so do
  not delete the volume routinely. For a local domain it holds Caddy's local
  authority instead: a new one is created, and browsers warn again.

`falky_caddy_config` holds only Caddy's autosaved configuration. Nothing in it
needs to be kept.

## `make smoke`

`make smoke`, run from the repository root, checks a running stack end to end
through Caddy, the way clients use it. Do not run it against a stack people
use:

- It replaces the access link, which ends every visitor's access, and it
  leaves its rooms (named `Smoke …`) and visitors behind.
- It trusts only Caddy's local authority, so it works only against a stack
  serving a local domain such as `localhost`. Against a domain with a public
  certificate, it fails.
