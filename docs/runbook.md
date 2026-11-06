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
`Release Please` runs separately on master pushes and maintains one rolling
release PR. Merging that PR authorizes publication and production deployment;
see [Release PRs and version policy](#release-prs-and-version-policy).

Backend/API (`make check-server`), frontend (`make check-web`) and deployment
safety (`make check-deploy`) checks run in parallel on separate runners. The
final `Check` job succeeds only when all three pass; failure, cancellation or
a skipped component blocks publishing and deployment. Locally, `make check`
still runs both application check suites; use `make check-deploy` for deployment
tests, release-policy tests and workflow validation (Node 24 and npm are needed).
On PRs, the deployment check also validates every incoming non-merge commit.
This includes the release bot's commits. It excludes commits already on the PR's
base branch, so historical nonconventional commits do not block new PRs.
PR checks use `pull_request`, read-only permissions and no release App secrets;
fork code never runs in a privileged `pull_request_target` workflow.

On PRs and master pushes, the server job can reuse backend validation from a
successful master workflow run when its commit is an ancestor of the checked-out
revision and all backend/shared inputs still match. Only `web/`, documentation
(`docs/`, `.agents/`, `.claude/`, `GLOSSARY.md`), and the root release metadata
files `CHANGELOG.md`, `version.txt`, and `.release-please-manifest.json` allow
reuse. API, server, tooling, release configuration/scripts, workflow and unknown
paths require the full backend suite. Comparing
against a successful run also catches backend changes from an earlier failed or
cancelled run. Tags always run backend checks. Missing history, API failures or
no suitable baseline among the latest 30 successful master runs also run the
full suite. The server job's log and summary explain its decision. Reuse skips
the expensive tools/check steps; the job still reports success to the final gate.
Frontend and deployment checks continue to run every time.
Reusing backend validation also reuses its vulnerability-scan result; a tag or
backend/shared-input change runs a fresh scan. Local `make check` always runs
the complete backend suite.

```text
master push → complete checks → plan against development → build changed images → development
v* tag push → complete checks → plan against production  → build both images    → production
```

Planning reads the target instance's healthy, successful release through the
restricted SSH command. For development, it compares complete tracked build-input
fingerprints, so failed or coalesced intermediate runs cannot hide an undeployed change.
`web/` changes publish only the web image; `server/` changes publish only the
server image. `api/`, shared tooling, deployment policy and unknown paths
invalidate both. Each publisher's workflow invalidates its own image. Files
under `docs/`, `.agents/`, `.claude/`, and `GLOSSARY.md` do not trigger publishing.
Documentation-only master pushes still run checks and verify the environment,
but do not deploy. Every `v*` tag schedules both publishers, even for frontend-only,
backend-only, documentation-only or identical source. Input fingerprints are
still recorded as provenance, but never skip publishing for a tag. Production
retains health, installed-configuration, ancestry and stale-plan checks; an old
push/tag rerun cannot automatically roll back a newer release.

Requested publishers build the checked-out revision for `linux/amd64` and return
immutable digests. In development, unchanged images retain their previous digest,
input hash and original build revision. Every release still specifies both images. Images are
labelled with their build commit and tagged `run-<run ID>-<attempt>`; CI never
selects `edge` or `latest`. Production validates against its own release, not
development's, and builds both images from the tag. It does not promote
development data.
The tag publishing policy lives in the CI-only `deploy/ci-plan.py`; changing
this policy does not require replacing the installed VPS scripts.
Both GHCR packages (`falky` and `falky-web`) must be public for anonymous pulls.

Each environment serializes its complete build/deploy sequence; active runs
are not cancelled. GitHub may coalesce pending runs during a burst of pushes.
Development and production run independently and have separate host locks.
Failed checks or any requested image build prevent deployment. Only planned
skips may reuse images. Failed pulls happen
before any configuration change. Existing instances are backed up before an
upgrade; database migrations are applied on start. A failed health check
leaves the attempted images configured, without an automatic database rollback.

Each instance stores `.release.json` after successful health verification and
`.release-pending.json` before changing its configured images. A pending attempt
blocks further CI releases until explicit recovery; never delete that marker to
pretend an interrupted release succeeded. CI checks its baseline again under
the VPS operation lock before changing anything. Running images, container IDs,
Compose configuration and installed deployment files must match that baseline.
The file fingerprint includes the instance files, the shared proxy's
`/srv/falky-edge/{Caddyfile,compose.yaml}`, and all four backup service/timer
units. CI reads the units' actual `FragmentPath` from systemd; missing units,
unloaded file changes (`NeedDaemonReload=yes`) and untracked drop-ins block
planning. New files under `deploy/edge/` or `deploy/systemd/` require an explicit
installed-file verification mapping before CI can release them.
Neither a new plan nor a deployment is allowed to reuse a drifted instance.

Application-only updates replace only `caddy` (web) and/or `falky` (server), with
`--no-deps`; LiveKit and unchanged containers stay running. Backups and the full
API, frontend-assets and LiveKit health checks still run for either update.
Replacing a container can briefly interrupt its requests; this is not a
zero-downtime rollout.

### Enabling selective releases and changing VPS configuration

This workflow does **not** install host files. Before enabling it, install the
deployment files listed below, including `release.py`, in each instance, and
install the shared edge files and all four systemd units. Keep them identical
to the source revision being released. The new SSH wrapper
rejects the old CI `deploy <server> <web>` protocol, so coordinate installation
with the workflow change when no deployment is active. Merging code alone does
not perform this installation: CI fails safely if the protocol/files differ.

For an existing healthy instance without a release record, the first CI release
builds both images and establishes the record. A fresh or unhealthy installation
must be started/recovered manually first; CI does not guess its state. When
changing host configuration later, install and apply the intended files first.
For shared edge changes, validate its Caddy configuration and recreate the edge
container using its Compose project; this can interrupt both domains. For unit
changes, run `systemctl daemon-reload` and restart the affected timers as needed.
CI verifies installed files; it does not load a new Caddy configuration for you.
Then explicitly run the operator's full `./manage.sh deploy <server digest> <web digest>` with a
known compatible pair. This reconciles the entire stack, verifies health, and
clears the old release record only on success. The next CI release builds both.
Keep deployment files in sync separately for production tags and development.
The edge and backup units are shared host configuration: changing them requires
coordinating both environments' baselines and release sources, rather than
allowing an application deployment to silently ignore an unapplied host change.

Do not bypass drift checks by editing release records. The records describe
successful running state, not a desired configuration or a migration journal.

### Release PRs and version policy

Merge ordinary PRs into `master` with merge commits, preserving their individual
semantic commits. Their normal development checks/build/deployment still run.
Release Please accumulates the releasable commits into one PR, proposing the
root `version.txt`, `.release-please-manifest.json` and `CHANGELOG.md`. Server
and web share that application version; `web/package.json` is not an independent
release version. Release PRs are refreshed from master even when a later push
only changes documentation. All accumulated source ships with the release,
including changes omitted from its notes. There is no frozen candidate branch.

Review the version and notes, wait for the required `Check`, then merge the
release PR. There is no auto-merge. Release Please publishes `vX.Y.Z` and a
GitHub Release at the **merged release PR commit**, even if master has advanced.
Publication does not wait for that push's development deployment. The App's tag
push starts `Deploy VPS`, which runs all production checks and builds both images
from the tagged commit before deploying. Publication and successful deployment
are separate outcomes; a published GitHub Release is not proof the VPS is healthy.

Use `type(scope): description` or `type: description` on individual commits.
Types are lowercase; supported types are `feat`, `fix`, `perf`, `docs`, `ci`,
`chore`, `build`, `refactor`, `style`, `test`, and `revert`. Optional scopes use
letters, numbers, `.`, `_`, `/`, or `-`, starting with a letter or number (for
example `server`, `web`, `deploy`, `deps`, `server/http`, or `UP-123`). The PR
title alone does not determine the release. Actual merge commits are exempt
from linting; ordinary commits whose subjects happen to say "Merge" are not.
Only commits with zero or one Git parent contribute version changes and notes.
The policy reads parents by exact SHA through GitHub, caching each candidate's
lookup. This prevents semantic PR titles embedded in merge bodies from adding
duplicate notes or inflating versions, even when master advances after checkout.
Merge identities remain available for Release Please's release discovery. Failed
or invalid parent lookups stop the proposal; retry after fixing the API failure.

| Changes since the last release | Next version from 1.2.3 |
| --- | --- |
| `fix(server): ...`, `fix(deploy): ...`, `perf(web): ...` | 1.2.4 |
| Runtime dependency update: `fix(deps): update LiveKit` | 1.2.4 |
| `feat(voice): ...` | 1.3.0 |
| `fix(api)!: ...` or a `BREAKING CHANGE: ...` body/footer | 2.0.0 |
| `docs: ...`, `ci: ...`, any `ci`/`docs` scope (case-insensitive), including `perf(ci): ...` | No release |
| Other maintenance such as `chore(deps): update test tooling`, without a breaking change | No release |

The largest applicable bump wins. CI/docs maintenance is excluded before both
version calculation and notes, including in mixed releases. Use `fix(deploy)`
for operational corrections that should independently release. Runtime dependency
fixes must use **`fix(deps)`**; `deps:` is not a supported type and
`chore(deps)` intentionally does not release. `!` and `BREAKING CHANGE:` use
the same upstream parser in validation and release generation. `Release-As:`
commit directives and PR-body `BEGIN_COMMIT_OVERRIDE` sections are rejected:
they bypass the automatic version policy or the validated individual commits.
PR body edits rerun checks for this reason.
Release generation also checks associated PR bodies before parsing unreleased
commits, since bodies can be edited after merge. An override then stops the
proposal with the PR number and commit SHA. Remove the override from that PR's
body and rerun Release Please; the original Git messages determine the release.

The first release is exactly **v1.0.0**. The initial empty manifest means no
previous release; `version.txt` starts at `0.0.0` only as an unreleased placeholder.
Do not seed a previous version, add a bootstrap SHA, or create a baseline tag.
The initial notes collect releasable history from the beginning, including
individual commits preserved by merge commits. The configured history search
limit is raised far beyond Release Please's default 500 commits. Later releases
start at the previous release commit and use the normal bump rules. `initial-version`
is only a bootstrap default; it does not pin every release to 1.0.0.

### Activating release automation

These are required setup steps, **not a claim that the live repository is already
configured**. This change does not create an App, install secrets, modify branch
rules, publish a release, or change VPS files.

1. Register a GitHub App and install it for **only `Luckmorecat/falky`**. Webhooks
   are unnecessary. Grant repository **Contents: read/write**, **Pull requests:
   read/write**, and **Workflows: read/write**; Metadata read is implicit. PR
   permission covers the labels and comments used by Release Please, so separate
   Issues write permission is unnecessary. Workflows write is needed when an
   exact release commit has older workflow files than later master; GitHub's
   [release API permission rules](https://docs.github.com/en/rest/releases/releases#create-a-release)
   require it in that case. No organization, administration, Actions, or package
   permission is needed by this App.
2. Set repository variable `RELEASE_APP_CLIENT_ID` to the App's client ID and
   repository secret `RELEASE_APP_PRIVATE_KEY` to its generated PEM private key.
   Keep the key out of commits and logs. The workflow requests only this
   repository and those three permissions; the token action revokes its
   short-lived token after the job. There is no PAT or `GITHUB_TOKEN` fallback.
   [App-authenticated events](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
   let release PR checks run automatically and let the tag push trigger deployment.
3. Protect `master`: require PRs, require the existing aggregate **`Check`**, and
   require branches to be up to date before merge. Keep merge commits enabled;
   don't require squash-only merges. The release bot must pass the same checks
   and has no auto-merge or branch-protection bypass. Protect version tags against
   movement/deletion while allowing this App to create them. Confirm repository
   Actions policy allows the pinned actions in the workflows.
4. Retain the development/production environment restrictions and secrets below.
   Complete the existing [VPS baseline setup](#enabling-selective-releases-and-changing-vps-configuration)
   for both instances; release automation does not install or reconcile host files.
   Root release metadata can invalidate both development image fingerprints.
5. Merge the automation change. Once the App is configured, a master push or
   manual **Release Please → Run workflow → master** reconciles release state.
   Verify the first PR proposes 1.0.0 with the historical notes, and that its
   `Check` runs under the App. Merging that release PR is the production
   authorization; do not merge it merely to test setup.

Release Please's pinned npm library, parser and small CI/docs policy adapter live
in `release/`; the lockfile is installed with `npm ci --ignore-scripts`. The
official library owns PR/tag/label/retry state. `make check-deploy` tests its real
manifest, version and changelog behavior against a substituted GitHub boundary,
including full initial history, rolling updates and retry after publication
failure. The historical regression test needs full Git history (CI fetches it).
Hosted App permissions, bot-triggered checks and tag-triggered deployment
must still be verified after activation; local tests cannot prove live settings.

### Publication and deployment failures

Release publication is serialized separately from development and production
deployment. Runs are never cancelled while active; pending runs may coalesce.
Release Please only responds to master pushes or a manual retry on master, so
its PR-branch pushes and version tags cannot recursively start itself. The next
run discovers current master and pending merged release PRs.

If PR creation/publication fails, fix the reported cause and rerun **Release
Please** (or dispatch it on master). Keep its `autorelease: pending` and
`autorelease: tagged` labels intact. It discovers the merged PR and its exact
commit again. A partial publication may reconcile labels on one retry and need
another retry to resume proposals; never delete or move a published version.

If production checks, image builds or deployment fail, the tag and GitHub Release
remain published. Once the cause is resolved, rerun the **whole original tag's
Deploy VPS workflow**, not just a failed deployment job with old outputs. Existing
ancestry and baseline checks reject a stale retry after a newer deployment.
A `.release-pending.json` marker or host drift requires the existing manual
recovery below before a safe rerun. No automatic rollback is added. Development
and production retain separate concurrency, and pending production runs may
coalesce: publishing a version does not guarantee every intermediate version
will reach the VPS.

Do not move or reuse a release tag. The tagged commit must contain these
workflows; a tag on an older commit uses that older commit's workflow files.

### GitHub environments and SSH

Configure two GitHub environments with **selected branches and tags**:

| Environment | Allowed ref | Secret | Variables |
| --- | --- | --- | --- |
| `development` | Branch `master` only | `VPS_SSH_KEY` | `APP_URL`, `VPS_HOST`, `VPS_KNOWN_HOSTS` |
| `production` | Tags `v*` only (remove branch `master`) | `VPS_SSH_KEY` | `APP_URL`, `VPS_HOST`, `VPS_KNOWN_HOSTS` |

Set `APP_URL=https://dev.falky.lunari.win` in `development` and
`APP_URL=https://falky.lunari.win` in `production`. The workflow uses this
environment variable for GitHub's deployment link. It is separate from the SSH
host and does not configure VPS routing, certificates or application origins.

Use a different dedicated SSH key for each environment. Both use
`VPS_HOST=falky.lunari.win` and the verified host key in `VPS_KNOWN_HOSTS`.
Bind each public key in `/home/deployer/.ssh/authorized_keys` to its own path:

```text
restrict,command="/srv/falky/ci-deploy.sh" ssh-ed25519 <production-public-key> falky-github-actions-production
restrict,command="/srv/falky-dev/ci-deploy.sh" ssh-ed25519 <development-public-key> falky-github-actions-development
```

The wrapper accepts only `status`, `release` (a non-secret baseline snapshot),
or `deploy-release <encoded request>` (strictly validated by `release.py`).
It cannot select another instance, deploy a moving tag, or execute arbitrary
shell commands. Old CI commands such as `deploy frontend` and unguarded digest
pairs are rejected. The snapshot requires a healthy, reconciled instance.
Application secrets stay in each instance's private `.env`.

### VPS configuration

Connect with `ssh -l deployer netcup`. Install these files from `deploy/` in
**both** instance directories: `compose.yaml`, `compose.production.yaml`,
`compose.sh`, `manage.sh`, `ci-deploy.sh`, `release.py`, `prune-backups.py`, `Caddyfile`,
`WebCaddyfile`, `web.caddy`, and `livekit.yaml`. Keep the scripts executable and each `.env`
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
Local and VPS Caddyfiles import the same `web.caddy` static-serving policy;
install and mount that file alongside either Caddyfile when updating them.
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
CI accepts published digests only. A successful manual deployment clears the
successful/pending release records; the next CI release rebuilds both images.
If a failed backend release ran migrations, choose a compatible recovery image
or follow database restoration below; do not automatically downgrade the binary.

The shared proxy's logs are separate:

```sh
docker compose -f /srv/falky-edge/compose.yaml logs --since 10m
```

Validate deployment changes from the repository root:

```sh
python3 deploy/manage_test.py
python3 deploy/release_test.py
python3 deploy/config_test.py
bash -n deploy/manage.sh deploy/compose.sh deploy/ci-deploy.sh deploy/ci-ssh.sh
actionlint
```

The management/release tests substitute Docker and public HTTPS probes and use
temporary Git repositories for input and ancestry checks; the configuration
tests render real Compose files without contacting Docker. Validate both Caddyfiles
with the pinned Caddy image before installing them.

### Backups and recovery

`./manage.sh backup` takes a consistent application snapshot and copies it
to `backups/<UTC timestamp>-<suffix>/database.db` and checks the copy's SQLite
integrity. Each directory also holds the private `.env`, deployment
configuration (including `WebCaddyfile` and `web.caddy`), scripts, and running server image reference (`image.txt`),
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

On the VPS, run from the selected instance directory and use `./compose.sh`
instead of `docker compose` for all snapshot commands below.

It prints where the snapshot went, for example
`/snapshots/falky-20261104T014919Z.db`, named after the UTC time. Never copy
`falky.db`, `falky.db-wal` or `falky.db-shm` out of the data volume instead:
while the server runs, those files are not a consistent database.

Snapshots go to the selected project's snapshot volume (`falky_falky_snapshots`
for production, `falky-dev_falky_snapshots` for development), mounted at `/snapshots`,
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
snapshot_volume=$(docker compose config --format json | python3 -c 'import json, sys; print(json.load(sys.stdin)["volumes"]["falky_snapshots"]["name"])')
caddy=$(docker compose config --format json | python3 -c 'import json, sys; print(json.load(sys.stdin)["services"]["caddy"]["image"])')
docker volume inspect "${snapshot_volume:?}" >/dev/null
docker run --rm -v "${snapshot_volume:?}:/snapshots" --entrypoint ls "${caddy:?}" -l /snapshots
docker run --rm -v "${snapshot_volume:?}:/snapshots" --entrypoint rm "${caddy:?}" /snapshots/falky-20261104T014919Z.db
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

Run from the selected instance's directory. On the VPS, use `./compose.sh`
in place of every `docker compose` command below so the saved instance
configuration and published images are selected. Use a backup from that same
instance, and stop the shared edge as described in *Backups and recovery*.

1. Have the snapshot on the host, copied out as above. If the current
   database might still be needed, take a snapshot of it and copy that out
   too.
2. Resolve the database volume from the selected Compose configuration and
   check the printed name: production is `falky_falky_data`, development is
   `falky-dev_falky_data`. Stop if it names the wrong instance.

   ```sh
   database_volume=$(docker compose config --format json | python3 -c 'import json, sys; print(json.load(sys.stdin)["volumes"]["falky_data"]["name"])')
   printf 'Selected database volume: %s\n' "${database_volume:?}"
   ```

3. Stop the stack. The volumes stay. Container logs are deleted with the
   containers, so save any you need first (see *Logs*).

   ```sh
   docker compose down
   ```

4. Delete only the database volume resolved above:

   ```sh
   docker volume rm -- "${database_volume:?}"
   ```

   Do not mount the new, empty volume into any other container before the
   next step. Docker copies that image's directory into an empty volume and
   takes its owner, after which the server cannot write there. If it
   happened, delete the volume again.

5. Restore the snapshot, passing it on standard input:

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

6. Start the stack:

   ```sh
   docker compose up -d --wait
   ```

7. On the VPS, start the shared edge again after the instance network exists.
   Check `falky health ready`, the rooms and the latest messages. The access
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
