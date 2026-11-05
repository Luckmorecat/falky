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

## Development and production releases

The VPS hosts two isolated instances behind one shared HTTPS proxy:

| Environment | Domain | Directory | Compose project | Media ports |
| --- | --- | --- | --- | --- |
| Production | `falky.lunari.win` | `/srv/falky` | `falky` | TCP 7881, UDP 7882 |
| Development | `dev.falky.lunari.win` | `/srv/falky-dev` | `falky-dev` | TCP 7891, UDP 7892 |

Each project has its own network, database, snapshots, rooms, visitors, access
link and LiveKit credentials. Never change production's project name: its
existing database is in `falky_falky_data`. Development starts with an empty
`falky-dev_falky_data` volume; do not copy the production database or `.env`.

`Deploy VPS` (`.github/workflows/deploy-vps.yml`) runs on **every push to
`master`**, including docs-only changes, and on **tags matching `v*`**.
A master push deploys development; a version tag deploys production. There is
no production deployment on master pushes and no manual workflow trigger.

```text
master push → complete checks → build backend + frontend → development
v* tag push → complete checks → build backend + frontend → production
```

Both reusable publisher workflows build the caller's checked-out revision,
for `linux/amd64`, and return their immutable image digests. The deploy job
passes those exact digests to the instance's restricted SSH command. Images
are labelled with the source commit and tagged `run-<run ID>-<attempt>` for
traceability. They do not update or deploy `edge`. A tag builds from the tagged
commit, even if master has moved on. It does not promote development data.
Both GHCR packages (`falky` and `falky-web`) must be public for anonymous pulls.

Each environment serializes its complete build/deploy sequence; active runs
are not cancelled. GitHub may coalesce pending runs during a burst of pushes.
Development and production run independently and have separate host locks.
Failed checks or either image build prevent deployment. Failed pulls happen
before any configuration change. Existing instances are backed up before an
upgrade; database migrations are applied on start. A failed health check
leaves the attempted images configured, without an automatic database rollback.

Release a tested commit with:

```sh
git tag v1.2.0 <tested-commit>
git push origin v1.2.0
```

Do not move or reuse a release tag. The tagged commit must contain these
workflows; a tag on an older commit uses that older commit's workflow files.

### GitHub environments and SSH

Configure two GitHub environments with **selected branches and tags**:

| Environment | Allowed ref | Secret | Variables |
| --- | --- | --- | --- |
| `development` | Branch `master` only | `VPS_SSH_KEY` | `VPS_HOST`, `VPS_KNOWN_HOSTS` |
| `production` | Tags `v*` only (remove branch `master`) | `VPS_SSH_KEY` | `VPS_HOST`, `VPS_KNOWN_HOSTS` |

Use a different dedicated SSH key for each environment. Both use
`VPS_HOST=falky.lunari.win` and the verified host key in `VPS_KNOWN_HOSTS`.
Bind each public key in `/home/deployer/.ssh/authorized_keys` to its own path:

```text
restrict,command="/srv/falky/ci-deploy.sh" ssh-ed25519 <production-public-key> falky-github-actions-production
restrict,command="/srv/falky-dev/ci-deploy.sh" ssh-ed25519 <development-public-key> falky-github-actions-development
```

The wrapper accepts only `status` or `deploy <server digest> <web digest>`.
It cannot select another instance, deploy a moving tag, or execute arbitrary
shell commands. Old CI commands such as `deploy frontend` are rejected.
Application secrets stay in each instance's private `.env`.

### VPS configuration

Connect with `ssh -l deployer netcup`. Install these files from `deploy/` in
**both** instance directories: `compose.yaml`, `compose.production.yaml`,
`compose.sh`, `manage.sh`, `ci-deploy.sh`, `prune-backups.py`, `Caddyfile`,
`WebCaddyfile`, and `livekit.yaml`. Keep the scripts executable and each `.env`
mode 0600, owned by `deployer`. The repository need not be cloned on the VPS.

Set the following in each instance's `.env`, alongside fresh instance-specific
LiveKit credentials, the same VPS `LIVEKIT_NODE_IP`, and pinned `FALKY_IMAGE`
and `FALKY_WEB_IMAGE` references:

```sh
# /srv/falky/.env — preserve all existing data and credentials
FALKY_PROJECT_NAME=falky
FALKY_DOMAIN=falky.lunari.win
LIVEKIT_TCP_PORT=7881
LIVEKIT_UDP_PORT=7882

# /srv/falky-dev/.env — new credentials and empty volumes
FALKY_PROJECT_NAME=falky-dev
FALKY_DOMAIN=dev.falky.lunari.win
LIVEKIT_TCP_PORT=7891
LIVEKIT_UDP_PORT=7892
```

Install `deploy/edge/compose.yaml` and `deploy/edge/Caddyfile` in
`/srv/falky-edge`. The edge joins the two existing project networks using
unambiguous service aliases. It alone publishes ports 80/443, obtains both
certificates, and routes APIs and LiveKit signalling directly to the correct
instance. This preserves client-IP rate limiting without trusting forwarded
headers from visitors. Internal Caddy containers only serve static assets.
No backend health/metrics, LiveKit API, admin or webhook routes are exposed.
Back up `/srv/falky-edge` separately: instance backup bundles do not include
the shared edge configuration.

Point Cloudflare A records for `falky` and `dev.falky` at this VPS, using DNS
only for direct connections. Open TCP 80/443/7881/7891 and UDP 443/7882/7892
in the host/provider firewalls. LiveKit must listen on and advertise the same
media ports that Docker publishes. No extra DNS record is needed for media.

### Migrating the existing single instance

This is a one-time maintenance operation; recreating containers briefly
interrupts requests and voice sessions. Perform it before enabling the new
workflows. Preserve the current image digests throughout the migration.

1. Restrict the GitHub `production` environment to `v*` tags, removing its
   `master` branch policy, so the old push-triggered workflow cannot upgrade it.
2. Run the **old** `/srv/falky/manage.sh backup`. Save a private copy of the
   existing `.env`, scripts, Compose and Caddy configuration outside the
   deployment directory. Serialize the migration with `.operations.lock` so
   a scheduled backup or already-started deployment cannot overlap it.
3. Install the new files and set production's explicit project name and
   existing media ports. Keep its credentials, database and image references.
4. Create `/srv/falky-dev` with fresh credentials, its own project name and
   ports, and a known image pair. Run `./compose.sh up -d --wait` there to
   create the development containers and network.
5. Validate the edge Caddyfile and install the edge files. Recreate the
   production stack using `./compose.sh up -d --wait`; its internal Caddy
   releases host ports 80/443. Start the edge immediately with
   `docker compose -f /srv/falky-edge/compose.yaml up -d --wait`.
   The edge reuses the existing external `falky_caddy_data` certificate volume.
6. Run `./manage.sh status` in both instance directories. Verify the two access
   links are different and production's rooms remain. Test voice and screen
   sharing in both domains from a browser. Never run `make smoke` on either
   shared instance: it rotates the access link.
7. Install both backup services/timers and the separate CI keys. Merge the
   workflows into master to enable development deployment. Subsequent `v*`
   tags deploy production.

If the proxy migration fails, stop the edge, restore the saved production
configuration, and run the old Compose wrapper to recreate the previous stack
with its original image digests. Do not remove volumes or restore the database
unless an actual application upgrade requires it; this infrastructure migration
uses the same images. Leave development stopped if needed while recovering.

### Operations

Run commands from `/srv/falky` for production or `/srv/falky-dev` for development:

```sh
./manage.sh status
./compose.sh logs --since 10m falky livekit caddy
./compose.sh exec falky /falky link show
./manage.sh backup
```

For manual recovery, deploy an explicit pair of known immutable images:

```sh
./manage.sh deploy ghcr.io/luckmorecat/falky@sha256:<server-digest> ghcr.io/luckmorecat/falky-web@sha256:<web-digest>
```

No-argument, latest-image and component-only deployments are intentionally
unavailable: each release identifies both images. A local web image ID is
accepted only by the operator command for recovering older installations;
CI accepts published digests only.

The shared proxy's logs are separate:

```sh
docker compose -f /srv/falky-edge/compose.yaml logs --since 10m
```

Validate deployment changes from the repository root:

```sh
python3 deploy/manage_test.py
python3 deploy/config_test.py
bash -n deploy/manage.sh deploy/compose.sh deploy/ci-deploy.sh
actionlint
```

The management tests substitute Docker and public HTTPS probes; the configuration
tests render real Compose files without contacting Docker. Validate both Caddyfiles
with the pinned Caddy image before installing them.

### Backups and recovery

`./manage.sh backup` takes a consistent application snapshot and copies it
to `backups/<UTC timestamp>-<suffix>/database.db` and checks the copy's SQLite
integrity. Each directory also holds the private `.env`, deployment
configuration (including `WebCaddyfile`), scripts, and running server image reference (`image.txt`),
plus the web image ID and source revision (`web-image.txt`, `web-revision.txt`).
A `complete` marker is written only after all copies
succeed. Incomplete directories are not usable backups.

After a new backup passes its integrity check and is complete, retention keeps
the ten newest completed backup directories and ten newest timestamped database
snapshots in the Docker volume. The just-created backup and snapshot are always
kept. Older complete directories are removed with their saved configuration;
incomplete directories, unrelated files and symlinks are left alone. Raw volume
snapshots made manually are included in the snapshot limit at the next successful
managed backup. Each retained backup directory has its own database copy, so it
does not depend on the original volume snapshot remaining.

Cleanup shares the deployment/backup lock. It uses the running backend's actual
snapshot volume and the existing Caddy image as an unprivileged helper with no
network and no application-data mount. It never creates a missing snapshot volume.
A snapshot, copy or integrity-check failure does not start pruning. If cleanup
itself fails, the new complete backup remains and the command reports failure;
old complete directories are not removed until Docker snapshot cleanup succeeds.

Install `deploy/systemd/falky-backup.service` and `.timer`, plus
`falky-dev-backup.service` and `.timer`, into `/etc/systemd/system/` as root,
then run:

```sh
systemctl daemon-reload
systemctl enable --now falky-backup.timer falky-dev-backup.timer
systemctl start falky-backup.service falky-dev-backup.service
systemctl list-timers falky-backup.timer falky-dev-backup.timer
```

Production runs daily at 03:00 UTC; development at 03:30 UTC, each with up to
15 minutes of randomized delay. Retention is independent for each instance.
The job runs as `deployer` and waits up to fifteen minutes for a deployment,
status check, or another backup to release the operations lock. Its twenty-
minute service timeout leaves five more minutes to write and copy the backup.
Failures appear in `journalctl -u falky-backup.service`. The ten-copy limit applies
after each successful managed backup; incomplete directories need manual cleanup.
Monitor disk usage and copy complete
backup directories off the VPS regularly: these local copies cannot protect
against loss of the host. They contain the access link and LiveKit secret.

If deployment verification fails, inspect containers and logs; the script
leaves the attempted image configured. It does not automatically roll back,
because a new binary may already have applied database migrations. To
recover, preserve the current data if needed, select a complete pre-upgrade
backup, restore its configuration and scripts, and follow the *Restore*
procedure below using `./compose.sh` instead of `docker compose` and
`database.db` as input. The shared edge is attached to each instance network:
before a restore that uses `compose down`, run
`docker compose -f /srv/falky-edge/compose.yaml down` (without `--volumes`).
This temporarily interrupts both domains. Start the edge again after the
instance network is recreated. Its external certificate volume is preserved.
Use that backup's server and web image references. On a
replacement host, pull the registry images first, or rebuild the web image
from its recorded revision if the backup uses a local image ID. Image IDs
are host-local and may change when rebuilding. This loses writes
after the snapshot. Never run `down --volumes` during routine deployment.

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

All three write JSON lines.
On the VPS use `./compose.sh` instead of `docker compose` for instance logs.
The shared edge has its own Compose file and logs, as shown above.
Docker keeps each container's log with the `json-file` driver and rotates it
at 10 MB, keeping three files per container. Each log is kept on the host
under `/var/lib/docker/containers/`, and
`docker inspect --format '{{.LogPath}}' falky-falky-1` names the file. A
log is deleted with its container, for example by `docker compose down`.

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
