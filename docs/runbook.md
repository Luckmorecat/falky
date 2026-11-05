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

## Published server image

The `Publish server image` GitHub Actions workflow runs on pushes to `master`
that change `server/**`, `api/**`, or the workflow itself
(`.github/workflows/publish-image.yml`). Frontend-only changes, changes only
to shared tooling (`Makefile`, `mise.toml`), docs-only pushes, other branches,
and tags do not publish server images.

The Check job installs the tool versions pinned in `mise.toml` and runs the
complete root `make check`. Only after it succeeds does Publish build
`server/Dockerfile` with `server/` as its context, for `linux/amd64`, and push
to `ghcr.io/luckmorecat/falky`. Both tags identify that build:

- `edge`, the most recently published revision.
- `sha-<full commit SHA>`, for that exact revision.

Publishing uses the repository's `GITHUB_TOKEN`, with package-write access
only in Publish; no personal access token or push secret needs provisioning.
The image's OCI source and revision labels identify the repository and commit.

The package is intended to be public. GHCR creates new packages as private:
after the first successful publish, a package administrator must open the
`falky` package's **Package settings → Change visibility**, choose **Public**,
and confirm. The workflow does not change this setting. Once public, hosts
can pull anonymously, for example with Docker logged out of GHCR:

```sh
docker pull ghcr.io/luckmorecat/falky:edge
```

The publish job builds the image; the separate `Deploy VPS` workflow updates
the running server after publication succeeds. Local Compose builds its own
images; the VPS uses the production override and published images as
described below.

## Published web image

`Publish web image` (`.github/workflows/publish-web-image.yml`) is independent
of the server workflow. It runs on pushes to `master` that change `web/**` or
the web workflow itself. Backend-only and docs-only changes do not publish a
web image. It checks generated contract types, runs the frontend tests, and
type-checks and builds using the same pinned Node image as `web/Dockerfile`.
Only after those checks pass does it build the Caddy image containing the
frontend and publish `ghcr.io/luckmorecat/falky-web:edge` and
`ghcr.io/luckmorecat/falky-web:sha-<full commit SHA>`, for `linux/amd64`.

Publishing uses `GITHUB_TOKEN`; the new `falky-web` package must be made public
after its first publish if the VPS is to pull without registry credentials.
The workflow becomes active once merged into `master`. Successful publishes
trigger the separate VPS deployment workflow described below. Server and web
images can be selected independently by digest; a frontend-only release need
not rebuild or restart the backend.

## Automatic VPS deployment

`Deploy VPS` (`.github/workflows/deploy-vps.yml`) runs after a successful push
build of either `Publish server image` or `Publish web image` on this
repository's `master`. Failed checks/publishes, other branches, and runs from
other repositories cannot start a production job. It can also be started
manually from **Actions → Deploy VPS → Run workflow**, selecting `master`
and a component: `all`, `backend`, or `frontend`.
The workflow becomes available after it is merged into the default branch.

```text
server/API change → publish server image → manage.sh deploy backend
web change        → publish web image    → manage.sh deploy frontend
  SSH as deployer → restricted ci-deploy.sh → lock and resolve selected digest
  preserve other image → backup → update selected service → check API/frontend
```

A server publish updates only `falky`. A web publish updates only Caddy and
its bundled frontend. The unchanged component keeps its configured image;
it is not pulled or recreated. If both components change, both publishers
run and each schedules its own component update. Manual `all` updates both.

The deploy job uses GitHub's `production` environment, restricted to the
`master` branch. Configure these values there:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `VPS_SSH_KEY` | A dedicated deployment private key, never the personal Netcup key |
| Variable | `VPS_HOST` | `falky.lunari.win` |
| Variable | `VPS_KNOWN_HOSTS` | The verified SSH host public key in known_hosts format for that hostname |

Install `deploy/ci-deploy.sh` alongside `manage.sh` in `/srv/falky`, mode 0750.
Authorize the dedicated public key in `/home/deployer/.ssh/authorized_keys`
with a forced command and forwarding/PTY restrictions:

```text
restrict,command="/srv/falky/ci-deploy.sh" ssh-ed25519 <public-key> falky-github-actions-production
```

The wrapper accepts exactly `deploy`, `deploy backend`, `deploy frontend`,
or `status`; it rejects arbitrary shell commands and file transfers. Test
the new key with `ssh ... status`. The job
pins the server's existing trusted host key, uses no repository checkout or
build artifacts, and needs no `GITHUB_TOKEN` permissions. Only temporary SSH
credentials are written on the runner and they are removed after the job.
Application secrets remain in the VPS's private `.env`.

Production deployments queue per component without cancelling an active
deploy. Pending jobs for the same component may be coalesced; a frontend job
cannot replace a queued backend job. The shared VPS lock serializes all
component updates, manual operations, and scheduled backups. The CI wrapper
waits up to fifteen minutes for this lock.

Each job selects the latest successfully published image for its component,
not necessarily the commit which triggered it. It reads the other image
under the same lock, preserving any update completed by an earlier job.
This prevents old queued events from rolling back either component.

The selected image package must be accessible to the VPS. A backend-only
update can keep the initial locally built frontend. The first web publish
may create a private package: make it public, then manually run **Deploy VPS**
with `frontend` if that initial automatic run failed. A missing image fails
before changing the application. Backups and readiness/HTTPS/frontend checks
are the same as a manual deployment; there is no automatic database rollback.

The action updates container images only. Changes to the Compose files,
Caddy/LiveKit configuration, management scripts or backup units still need
installing on the VPS as described below. To revoke CI access, remove the
dedicated authorized-key entry and delete the `VPS_SSH_KEY` environment
secret. To pause automatic deployment, disable **Deploy VPS** in Actions.

## Production VPS

The Netcup host is reached with `ssh -l deployer netcup`. Its deployment
directory is `/srv/falky`, owned by `deployer`. Docker starts at boot, and all
three containers have `restart: unless-stopped`. The repository need not be
cloned onto the host.

Install these files from `deploy/` into `/srv/falky`: `compose.yaml`,
`compose.production.yaml`, `compose.sh`, `manage.sh`, `ci-deploy.sh`,
`prune-backups.py`, `Caddyfile`, and
`livekit.yaml`. Make the shell scripts executable. Keep the configuration files
from the same repository revision together. `compose.production.yaml` clears
local builds and selects `FALKY_IMAGE` and `FALKY_WEB_IMAGE` from `.env`.
It mounts `Caddyfile`, which serves the web client and proxies the API and
signalling. `compose.sh` always loads both files with the correct paths.

Create `.env` on the host with mode 0600. Use the settings from `.env.example`,
with `FALKY_DOMAIN=falky.lunari.win` and the host's public IP for
`LIVEKIT_NODE_IP`. Generate the key pair on the host; do not commit it or
print it in CI logs. Add `FALKY_IMAGE=ghcr.io/luckmorecat/falky@sha256:<digest>`
for the selected published build. Also set
`FALKY_WEB_IMAGE=ghcr.io/luckmorecat/falky-web@sha256:<digest>`. Public GHCR
images need no registry login. Caddy uses `pull_policy: never`: `manage.sh`
explicitly pulls a selected web registry image before starting Compose, and
can also use an already-built local image by ID.

For the latest published backend and frontend, run:

```sh
cd /srv/falky
./manage.sh deploy
```

To update only one component while preserving the other's deployed version:

```sh
./manage.sh deploy backend
./manage.sh deploy frontend
```

These commands pull only the selected image and use `up --no-deps` with
the selected service (`falky` or `caddy`). They leave the other component and
LiveKit running with their current images.

The no-argument command pulls each package's `edge` tag independently,
resolves it to that repository's immutable digest, and deploys those selected digests. The two
packages may have different source revisions because they publish separately.
Both packages must already be published and accessible: a failed pull or a
missing digest aborts before taking a snapshot or changing configuration or
containers. There is no fallback to an older cached image. The first public
`falky-web` publish is required before using this form.

To choose versions explicitly, resolve the digest of the desired
`sha-<full commit SHA>` image and check its
`org.opencontainers.image.revision` label before deploying. Use the resulting
`ghcr.io/luckmorecat/falky@sha256:…` reference, not a moving `edge` tag:

```sh
cd /srv/falky
./manage.sh deploy ghcr.io/luckmorecat/falky@sha256:<digest>
# To update the web client too (or only it, keeping the current server digest):
./manage.sh deploy ghcr.io/luckmorecat/falky@sha256:<server-digest> ghcr.io/luckmorecat/falky-web@sha256:<web-digest>
./manage.sh status
```

With an explicit server digest and no web argument, the current web image is
kept. With no image arguments, both latest published images are selected. The
deploy command validates configuration, obtains the selected images, backs up
the existing running server if there is one, records both image references
atomically in `.env`, and starts Compose with a three-minute readiness deadline. It then
checks that both the database and LiveKit report `ok` and that the public
HTTPS `/api/me` endpoint returns 401 without a visitor cookie. It also checks
the homepage contains the React root and that its JavaScript and CSS load with
the correct content types. Certificate issuance is allowed an additional
retry period. A stopped existing server must be recovered before upgrading,
so a failed backup cannot be skipped. If the backend container is missing
but its configured database volume remains (for example after
`./compose.sh down`), deployment also stops before recording new images or
starting containers. An absent container does not prove the database is new.
Restore/start the previous known working release, then rerun deployment so
it can take the pre-upgrade snapshot. An error querying containers or volumes
also aborts; it cannot be mistaken for a fresh installation.
Deployments and backups share a lock. Manual operations fail immediately if
another operation is running; the CI wrapper sets
`FALKY_LOCK_WAIT_SECONDS=900` to wait for that operation instead.

Use the wrapper for operator commands and diagnostics:

```sh
./compose.sh exec falky /falky link show
./compose.sh exec falky /falky room create "Living room"
./compose.sh logs --since 10m falky livekit caddy
```

The initial frontend rollout was built on the VPS from exact commit
`53e3fa7c818910bcda7f03e6224813b10581856f` because the server publishing
workflow does not include the web client. Its source is retained under
`/srv/falky/releases/<commit>/web`. To rebuild that release before a registry
image is available:

```sh
docker build --label org.opencontainers.image.revision=<commit> -t falky-caddy:sha-<commit> releases/<commit>/web
docker image inspect falky-caddy:sha-<commit> --format '{{.Id}}'
```

Pass the resulting `sha256:<image ID>` as the second image argument to
`manage.sh deploy`. Production pins that content ID, rather than its tag.
Do not use `make smoke` against this public stack.

For changes to the deployment scripts, run `python3 deploy/manage_test.py`
from the repository root. These tests replace Docker and external HTTPS
verification to exercise latest-image selection, explicit version selection,
backup ordering, and failures without touching a running stack. Also run
`bash -n deploy/manage.sh deploy/compose.sh deploy/ci-deploy.sh` and validate workflow changes
with `actionlint`.

### Production backups and recovery

`./manage.sh backup` takes a consistent application snapshot and copies it
to `backups/<UTC timestamp>-<suffix>/database.db` and checks the copy's SQLite
integrity. Each directory also holds the private `.env`, deployment
configuration, scripts, and running server image reference (`image.txt`),
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

Install `deploy/systemd/falky-backup.service` and `.timer` into
`/etc/systemd/system/` as root, then run:

```sh
systemctl daemon-reload
systemctl enable --now falky-backup.timer
systemctl start falky-backup.service
systemctl list-timers falky-backup.timer
```

The timer runs daily at 03:00 UTC with up to 15 minutes of randomized delay.
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
`database.db` as input. Use that backup's server and web image references. On a
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
