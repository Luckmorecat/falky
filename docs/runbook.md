# Runbook

How to run the Falky stack on one host: deploying it, checking its health,
the operator commands, snapshots and restoring them, logs, and what else to
keep safe.

The stack is `deploy/compose.yaml` (Compose project `falky`). Caddy serves
HTTPS and proxies the API and guarded RTC signalling to Falky, LiveKit carries voice and
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

The VPS already has two independent instances behind a shared HTTPS edge:

| Environment | Domain | Directory / project | Media ports |
| --- | --- | --- | --- |
| Production | `falky.lunari.win` | `/srv/falky` / `falky` | TCP 7881, UDP 7882 |
| Development | `dev.falky.lunari.win` | `/srv/falky-dev` / `falky-dev` | TCP 7891, UDP 7892 |

Preserve both instances' settings, credentials and data. Their database volumes
are `falky_falky_data` and `falky-dev_falky_data`; snapshot volumes have the same
prefix and end in `_falky_snapshots`. Never rename a project to change its domain.
The external networks are `falky_default` and `falky-dev_default` (override with
`FALKY_NETWORK` only when coordinating host routing). The app publishes only
LiveKit media ports. The edge reaches `<project>-api:8080`, `<project>-voice:7880`
and `<project>-web:80` directly, keeping one trusted proxy hop.

The production package assigns both `-api` and the **unique** `-voice` alias to
Falky. `FALKY_SIGNALLING_ADDR=:7880` enables its private RTC-only listener;
the default is empty (disabled), useful on a bare development host where
LiveKit already binds loopback 7880. Falky's upstream remains the independent
service name `http://livekit:7880`, never the `-voice` alias. Local Caddy routes
`/rtc` and `/rtc/*` through Falky8080. Public URLs, services, networks, volumes
and published media ports remain the same. Keep raw LiveKit signalling/API
private: exposing it to clients bypasses admission.

The first separately authorized rollout of this package must remove the old
LiveKit `-voice` alias as it gives it to Falky. Do not allow old and new alias
owners to coexist; drain/block RTC through that transition. This Compose change
requires a one-time LiveKit container recreation and interrupts voice. Subsequent
unchanged LiveKit packages retain the normal no-recreation behavior. These are
future rollout instructions, not evidence that any instance has been deployed.
Ordinary release health checks database, direct LiveKit API and public web/API;
it alone does not prove RTC guard routing. The package's configuration/listener
tests separately cover unique aliases for both projects, unchanged edge targets,
startup failures and management-path refusal.

[Private netcup-infra](https://github.com/Luckmorecat/netcup-infra) owns the edge,
networks, host setup and backup timers. Falky owns its runtime package and app
operations. Follow its [migration procedure](https://github.com/Luckmorecat/netcup-infra/blob/main/MIGRATION.md)
for the coordinated first merge, artifact preparation and development-first
activation. The local tests prove configuration behavior; they do not mean the
live host has migrated. Changing a timer or another hosted site needs no Falky
release or release-state edit.

`Deploy VPS` validates backend, frontend and deployment inputs. The stable
aggregate `Check` succeeds only when all three jobs pass. PR checks also validate
every incoming non-merge commit, including bot commits, with read-only permissions;
fork code never runs through `pull_request_target`. `make check` runs the two
application suites locally; `make check-deploy` adds deployment/release-policy
checks and actionlint (Python, Compose CLI, Node 24 and npm required).

Master pushes target development; `v*` tag pushes target production. Any changed
runtime/application/unknown input builds **both** images. Docs-only development
revisions compare the complete tracked release inputs against the last successful
release, so failed or coalesced runs cannot hide a change. Known documentation
and root release metadata alone do not rebuild development. Every new version
tag builds both images. Frontend statistics are enabled only for development.
Both the server (`ghcr.io/luckmorecat/falky`) and web
(`ghcr.io/luckmorecat/falky-web`) images use the full source commit SHA as the
development image tag and the Git version tag (for example, `v1.2.3`) as the
production image tag. For Docker compatibility, `+` in version tags becomes `_`
(for example, `v1.2.3+build.1` becomes `v1.2.3_build.1`), and image tags are
limited to the first 128 characters. Images are built for `linux/amd64`; CI pins
deployments to their actual digests. Both GHCR packages must support anonymous
pulls.

Backend validation may be reused on PR/master runs only from an ancestor's
successful master check with unchanged backend/shared inputs. Changes confined to
`web/`, documentation (`docs/`, `.agents/`, `.claude/`, `GLOSSARY.md`) or root
release metadata or the five existing `deploy/*_test.py` suites allow reuse.
API/server/runtime deployment code/tooling/workflows/release policy and
unknown paths force validation. Missing history/API results or no candidate among
the latest 30 successful master runs also force it. Reuse includes that check's
vulnerability scan.

Deployment validation uses the same successful-master ancestor rule, comparing
complete trees. Changes confined to `server/`, `web/`, `api/`, documentation
(including root `README.md`) or root release metadata allow reuse because these
suites use fixture applications and Git trees. Deployment/release code and tests,
shared tooling, workflows, and unknown paths force fresh validation. Incoming PR
commits and the current PR body are always validated, even when deployment
validation is reused. Reuse skips component test steps, not the required jobs;
the aggregate `Check` still requires every job to succeed. Tags and prepare
dispatches run fresh backend and deployment checks; frontend checks always run.

Each environment serializes checks/build/install without cancelling an active
run. The source must descend from the durable highest successful CI revision,
even after manual recovery of an older release. Eligibility does not fingerprint
host configuration, container IDs or old web health. On the host, a single
instance lock verifies the current baseline, package, images and backup, installs
the package, applies the **full** Compose stack and verifies database, LiveKit,
public API, HTML and assets before recording success. Failed pulls cannot activate
the package. An existing database requires a verified backend snapshot even if
its old containers were removed. Health failure leaves the attempted runtime;
there is no automatic database rollback. LiveKit configuration uses a stable
mount and content label: changed bytes recreate it, an unchanged package move
does not.

The installable package contains `bootstrap.py`, `release.py`, `manage.sh`,
`compose.sh`, `ci-deploy.sh`, `prune-backups.py`, `compose.production.yaml`,
`livekit.yaml` and an inventory. Static serving policy is baked into the web image.
It excludes secrets, source builds, local HTTPS, host edge/timers and CI tools.
Settings stay in the instance's mode-0600 `.env`. The `active` symlink selects an
immutable runtime; `.deploy/` retains package archives, runtime directories,
durable successful/attempted history and the stable LiveKit configuration.
Do not edit installed runtime files or delete `.deploy/` to unblock CI.

Actions uploads `runtime.tar` and `manifest.json` before activation, named
`falky-runtime-ENVIRONMENT-FULL_SHA-RUN_ID-RUN_ATTEMPT`, retained for 90 days.
Host caches/backups preserve exact artifacts independently. `workflow_dispatch`
prepares these artifacts with all checks and both builds but **never contacts or
changes the VPS**. Use actual `master` for development and an existing `v*` tag
containing the new workflow for production; feature refs cannot masquerade as
these sources. Concrete download, verification, ancestry and bootstrap commands
are in the host migration guide.

### Pending attempts

Use the selected instance's stable commands as `deployer`:

```sh
cd /srv/falky-dev                    # production: /srv/falky
./manage.sh release > /tmp/falky-state.json
./manage.sh status
./compose.sh logs --since 10m falky livekit caddy
```

`release` reads durable state without probing old public health. A pending attempt
records the exact request, original backup and stage. Rerun the whole original
CI run to retry that source: CI reuses the cached immutable package/images and
skips publishing. A different source refuses before builds. Do not rebuild a
pending target or remove its journal. For a local retry using its recorded request:

```sh
request=$(python3 - /tmp/falky-state.json <<'PY'
import base64, json, sys
state = json.load(open(sys.argv[1]))
assert state['pending'], 'No pending attempt'
raw = json.dumps(state['pending']['request'], sort_keys=True, separators=(',', ':')).encode()
print(base64.urlsafe_b64encode(raw).decode())
PY
)
./manage.sh retry-release "$request"
```

A pending operator restore must be resumed as recovery, not relabeled a CI retry.
To deliberately abandon an attempt before selecting another target or restore,
inspect its request/backup and acknowledge its exact request hash:

```sh
pending_sha=$(python3 - /tmp/falky-state.json <<'PY'
import hashlib, json, sys
request = json.load(open(sys.argv[1]))['pending']['request']
print(hashlib.sha256(json.dumps(request, sort_keys=True, separators=(',', ':')).encode()).hexdigest())
PY
)
./manage.sh resolve-pending "$pending_sha"
```

Resolution performs no rollback and keeps history/ancestry. Take a fresh snapshot
for subsequent planning. A newer CI release can repair broken installed files or
old web/signalling health if the backend snapshot path is still usable.

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
   Complete the [host migration](https://github.com/Luckmorecat/netcup-infra/blob/main/MIGRATION.md)
   for both instances; release automation does not install host files.
   Release metadata alone does not rebuild development; a new tag builds both images.
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
A matching pending attempt retries its exact cached package and images. A different
source or operator recovery requires explicit [pending resolution](#pending-attempts). No automatic rollback is added. Development
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
`deploy-release <encoded request>` with the bounded runtime archive on stdin,
or `retry-release <encoded request>` without an archive.
It cannot select another instance, deploy a moving tag, or execute arbitrary
shell commands. Old CI commands such as `deploy frontend` and unguarded digest
pairs are rejected. The snapshot reads durable release history and does not require old public health.
Application secrets stay in each instance's private `.env`.

## VPS operations and recovery

Run these as `deployer` from `/srv/falky-dev` or `/srv/falky`. Use `./compose.sh`
for all app Compose operations: it selects the installed package/settings and
protects mutations with the same lock as deployment and backup.

```sh
./manage.sh status
./compose.sh logs --since 10m falky livekit caddy
./compose.sh exec falky /falky health ready
./compose.sh exec falky /falky link show
./compose.sh exec falky /falky room create "Living room"
./compose.sh exec falky /falky room rename ROOM_ID "New name"
./manage.sh backup
```

Room names are unique ignoring case and surrounding spaces. `link show` and
`link rotate` reveal the access link; keep output private. Health `live` means
that the process answers; `ready` fails if the database is unusable. LiveKit may
be reported `degraded` while database readiness remains good: chat works but
voice does not. Full deployment/status verification also requires LiveKit and
public web/API checks. Internal health, metrics and webhook listeners are not
public edge routes.

### Backups

`manage.sh backup` obtains a consistent snapshot through the running backend,
copies it to `backups/<UTC timestamp>-<suffix>/database.db` and checks SQLite
integrity. It saves the exact `runtime.tar`, immutable `manifest.json`, private
`.env`, durable `state.json`, instance identity and snapshot path. `bundle.json`
and `complete` seal the inventory; incomplete or changed bundles cannot restore.
No old web container is needed. A pinned immutable helper handles retention
without network, as an unprivileged user, with restricted snapshot mounts and
without the application data volume.

Successful backup retains ten complete bundles and ten source snapshots per
instance, protecting any original bundle referenced by a pending attempt.
Unrelated files and incomplete bundles are left alone. Pruning failure preserves
the new complete backup and reports failure; after successful deployment it is
a warning rather than a false deployment failure. Keep complete bundles off the
VPS too. They contain the access link and LiveKit secret. Runtime caches currently
have no automatic garbage collection; monitor disk usage.

Host-owned timers call the stable `/srv/<instance>/manage.sh backup`, wait up to
15 minutes for the lock and have a 20-minute timeout. Production runs at 03:00 UTC,
development at 03:30 UTC, each with up to 15 minutes randomized delay. Timer files
and installation commands live in netcup-infra. Inspect with:

```sh
systemctl list-timers falky-backup.timer falky-dev-backup.timer
journalctl -u falky-dev-backup.service --since yesterday
```

### Restore a packaged release

Restoring intentionally loses writes after the selected snapshot. Preserve the
current data first if needed and choose a completed bundle from the **same**
instance. Resolve any pending different attempt explicitly as above, then:

```sh
cd /srv/falky-dev
./manage.sh restore 20261106T120000Z-a1b2c3  # replace with the actual backup basename
./manage.sh status
./compose.sh exec falky /falky link show
```

Restore verifies the sealed bundle and instance/volume identity, stops only that
app, restores its exact package/settings/images and database, applies the full
stack and checks health. It preserves the highest successful CI ancestry and
records recovery history. The shared edge, external network and other instance
stay up. Never stop the edge for an app restore or use `down --volumes`.
An interrupted restore retains its exact bundle and request. Check
`./manage.sh release` before deciding how to continue. If it reports a pending
restore, extract the encoded `pending.request` as shown under
[Pending attempts](#pending-attempts), save it privately, and retry that request:

```sh
# request is the exact encoded pending.request from a fresh release snapshot.
umask 077
printf '%s\n' "$request" > .restore-request.txt
./manage.sh retry-release "$request"
# If the response is lost, reuse the saved request rather than starting a restore:
./manage.sh retry-release "$(cat .restore-request.txt)"
```

Exact retries do not recopy the database after the restored stage and remain
harmless after that request has completed. If there is no pending request, inspect
status and recovery history rather than blindly issuing another restore. A new
`./manage.sh restore BACKUP` after completion intentionally starts a new restore
and discards writes made since that backup, even when it names the same bundle.

Legacy bundles contain `legacy.tar`/`legacy.json` instead of `runtime.tar`.
They require the explicit [one-time legacy recovery](https://github.com/Luckmorecat/netcup-infra/blob/main/MIGRATION.md#legacy-application-and-database-recovery)
procedure. Do not run restored old `manual-finish` or delete either old or new
release records. A replacement host must restore the private instance directory
(including `.deploy/` and backups) at the same path, provision external networks
and edge, and make immutable registry images available before recovery. A bare
database snapshot alone does not contain the application's recovery history or
runtime package.

### Rotate guest access

`link rotate` immediately refuses old guest cookies and guarded RTC admission,
closes guest live updates and ends guest voice. Accounts, reserved account names
and their sessions/live/voice remain. Distribute the new shared guest link only
to intended guests:

```sh
./compose.sh exec falky /falky link rotate
```

An account is excluded with `account disable`, below. Rotation cannot exclude
an account, and disabling an account cannot prevent its holder using a valid
shared link to enter as a new guest. Preserve the raw LiveKit private-network
boundary; bypassing Falky's RTC guard defeats immediate token fencing.

To replace a compromised LiveKit signing pair as well, generate new values:

```sh
openssl rand -hex 6                  # append to "falky" for the new API key
openssl rand -hex 32                 # new API secret; keep this output private
```

Edit this instance's `.env` and private saved copy with the new
`FALKY_LIVEKIT_API_KEY` and `FALKY_LIVEKIT_API_SECRET`, then:

```sh
./compose.sh up --detach --no-build --wait
./manage.sh status
./compose.sh exec falky /falky link show
```

Both the server and LiveKit restart, briefly interrupting voice. Account browsers
must obtain fresh voice credentials after a backend restart because account voice grants
are process-local and fail closed; account sessions persist. Never copy
credentials or a database from production to development.

Guests can reuse valid original or LiveKit-refreshed voice JWTs after a backend
restart while their unique persisted guest session and guest-link generation
remain current. Logout, guest-link rotation or account upgrade refuse that
restoration; room/name checks and newer room choices still apply.

### Accounts, invitations and recovery

These commands use the existing owner-only Unix admin socket in the running
server (`FALKY_ADMIN_SOCKET`, default `falky-admin.sock`, container-configured).
They do not expose a public administration API. Use the selected instance's
`./compose.sh`; in local Compose use `docker compose exec` instead:

```sh
./compose.sh exec falky /falky invitation create
./compose.sh exec falky /falky invitation list
./compose.sh exec falky /falky invitation revoke INVITATION_ID
./compose.sh exec falky /falky account list
./compose.sh exec falky /falky account disable ACCOUNT_ID
./compose.sh exec falky /falky account recover ACCOUNT_ID
```

Creation prints one single-use seven-day `/#invite=<bearer>` link. It is not
restricted by email and is separate from the reusable guest link. Listing shows
non-secret references, times and revoked/redeemed status, never bearer links;
use its reference to revoke. An invitation suffices for a first arrival without
a guest cookie. If a valid guest cookie is present, verified enrollment upgrades
that same identity and preserves messages, drafts and colour. Signing into an
existing account switches identity without merging guest ownership.

The private account list provides IDs/names/disabled status for operator work;
there is no public roster. Accounts reserve names while offline or disabled.
An account claiming a guest name moves affected guests to generated alternatives
and refreshes their connected clients. Names at the time of message publication
remain unchanged in history.

Keep `FALKY_PUBLIC_ORIGIN` and its hostname stable: passkeys bind to that RP
hostname and exact origin. Accounts use discoverable passkeys with required user
verification, never email/password/OAuth. Multiple individually labeled passkeys
are supported. Management and code regeneration require a verified passkey proof
in the same session within five minutes; last-key removal is refused. Removing
one passkey blocks future sign-in/proof with that key, but normal existing
sessions remain usable; recovery/disable ends the old sessions. Account cookies expire server-side
after 90 days absolute; logout ends only that browser's session.

Enrollment and recovery return ten high-entropy single-use recovery codes,
plaintext only in the successful response; only their hashes are stored. Keep
them privately with `session.visitor.id`, the permanent account ID, rather than
the changeable name: code recovery requires both ID and code. Authorized regeneration invalidates
the previous set. Codes authorize replacement-passkey enrollment, not ordinary
access. An operator should issue `account recover` only after out-of-band human
identity verification. It prints a `/#recover=<bearer>&account=<id>` link valid
for 30 minutes. Issuing it alone changes no access. Failed/cancelled enrollment
does not consume the code/link or lock out the existing owner.

Successful recovery verifies and installs a replacement passkey, invalidates
**all** old passkeys, sessions, recovery codes and outstanding recovery grants
and account-bound ceremonies, then returns a fresh session and codes. Old live
updates and voice end; the recovered identity, reserved name and history remain.
Disablement immediately ends that account's sessions/live/voice and rejects
authentication/recovery while retaining the identity and name. It leaves the
shared guest link untouched. A successful HTTP/CLI mutation awaits required
voice removal; a postcommit enforcement error means persistent identity state
already changed. Inspect logs and LiveKit connectivity; do not assume the
transaction was rolled back or media removal succeeded.

The current frontend provides the legacy guest flow; these backend invitation
and recovery links do not add account UI. Client integration must implement the
[account/WebAuthn API](../api/openapi.yaml), including five-minute context-bound
ceremonies, same-origin mutations, recovery-code storage and explicit confirmed
voice transfer at `POST /api/rooms/{id}/voice`. Account transport IDs map to the
permanent prefix before their dot; public occupancy already uses permanent IDs.

The additive `0007_accounts.sql` migration retains existing IDs, guest history
and ownership. `0008_identity_profiles.sql` renames the lasting identity table to
`identities`, appearance to `profiles` and identity-reference columns to
`identity_id`, preserving data and updating foreign keys. `0009_sessions.sql`
combines guest tokens and account sessions into `sessions`, preserving cookie
hashes and existing account-session IDs. Guest sessions receive independent IDs
and an absolute expiry 400 days after original issuance; account deadlines remain
90 days from sign-in. Already expired guest tokens remain expired. A guest
registration ceremony begun before this migration must be restarted because its
old derived session ID is no longer valid. `serve` or `falky migrate` applies these
through the normal application migration sources. No reset is required. A runtime
from before these changes expects the old tables; rolling back to it requires a
pre-upgrade database snapshot. Snapshot before an upgrade; an older
binary cannot restore the newer migration set. A deliberate reset would lose
accounts, credentials, reservations, sessions and history: never delete a live
database for this feature.

### Logs and host state

App and edge logs are separate:

```sh
./compose.sh logs --follow --since 1h falky
sudo docker compose -f /srv/netcup-infra/compose.yaml logs --since 10m caddy
```

Services log JSON; Docker rotates at 10 MB with three files per container.
Logs disappear with a removed container, so save needed evidence before teardown.
The edge's external `falky_caddy_data` holds certificates and the ACME account;
back it up privately to avoid unnecessary certificate reissuance. Its preserved
`falky-edge_config` contains autosaved configuration. Host checkout, systemd units,
SSH access and private settings need separate backup. Dozzle remains a standalone
container bound to localhost:8080 with `dozzle_data` and the Docker socket;
netcup-infra does not recreate it or expose it through Caddy.

## Chat attachments

Attachments live beside the database, under `/data/attachments` in the shipped
image. Both Compose stacks retain them through ordinary container restarts and
upgrades in the existing `falky_data` volume. `FALKY_ATTACHMENT_ROOT` changes the
root; keep it on the durable data mount. Outside containers the default is an
`attachments` directory beside `FALKY_DB_PATH`. The store owns only its private
`objects` subdirectory (0700 directories, 0600 files).

`FALKY_ATTACHMENT_POSTED_BYTES` sets the positive global posted-file quota,
default 5,000,000,000 bytes across every room. A successful new message expires
the oldest posted files by message publication order until its attachments fit.
Text and attachment metadata remain in history. Uploading, invalid sends and
matching retries do not evict files. A message whose files cannot fit by
themselves is rejected. Failed physical cleanup retains accounting and blocks
new attachment posts until cleanup succeeds; text-only sends and retries remain
available. Cleanup failures appear in the server log.

The posted quota excludes the database, snapshots, 256 MiB staging allowance,
and one bounded 32 MiB conversion output scratch file. Uploads reserve 25 MiB
before reading and charge the final stored size on success. Four upload streams
are admitted globally, with at most four pending drafts per visitor. Upload rate
is separate from message rate: burst four, one refill per 15 seconds. Drafts
expire one hour after successful upload. Uploads have an actual 60-second body
read deadline as well as a store deadline. The multipart envelope allows one file,
16 KiB overhead, 8 KiB initial headers, eight headers and a 255-byte filename.
Content reads admit eight global streams and have a 120-second write deadline;
their file handles close on completion or disconnect. An open reader can retain
unlinked expired content until it closes, bounded by eight files of at most
32 MiB each outside active posted accounting. The four-upload HTTP admission
limit also covers incomplete multipart headers before storage admission.

Validated static JPEG, PNG and WebP become metadata-free WebP quality 80,
orientation normalized, alpha retained, longest side at most 2560 without
upscaling. Input is at most 25 MiB, 24,000,000 decoded pixels and 16,384 pixels
per axis. There is one global conversion child with a hard 30-second timeout
and kill/wait/reap ownership. The child uses a 256 MiB Go soft GC target, which
is **not** a hard memory ceiling. Provision at least 1 GiB conversion headroom
in addition to normal server/database and upload overhead. The production image
remains a static, nonroot binary with no external conversion service. GIF,
animated WebP, SVG, HTML and other unsupported formats retain their exact bytes
and metadata and are always download-only; only optimized images display inline.

All attachment routes require the current visitor cookie and room authorization.
Drafts are private to the owning identity. Guest re-entry creates another
visitor and cannot recover those drafts; guest upgrade preserves them, and
account browsers share their account's ownership. Posted files remain readable by newly
admitted visitors after access-link rotation. State-changing attachment requests
with a nonempty Origin must match the configured public origin; authenticated
non-browser clients may omit it. No CORS or public sharing URLs are provided.
Content uses `private, no-cache` and a strong ETag based on the immutable attachment
ID. Conditional reads return `304` only after visitor, room and availability checks.
Metadata and errors retain `no-store`. Content also uses `nosniff`, safe filenames
and actual stored lengths. The frontend uses direct content URLs for posted images;
only local upload previews use object URLs.

The OpenAPI contract describes upload, status, cancel, content and effective
limits (`GET /api/attachments/limits`). `message.created`, history and post
responses carry the same ordered attachment metadata. `attachments.expired`
notifies only the affected room about posted files; private drafts never enter
live events. Events are not replayed. After reconnect, clients must refresh
previously visible attachment IDs with `GET /api/attachments/{id}`, even when
history catch-up returns no new messages. Expired content answers 410 while
metadata and message text remain available.

Database snapshots and managed backup bundles contain **metadata only, never
attachment payloads**. Ordinary same-volume restart preserves files. Restoring
only the database into an empty data volume loses file content: startup recovery
marks missing posted files as expired tombstones and missing drafts as
unpostable. It also reclaims abandoned incoming files, owned orphans and durable
cleanup work before serving; periodic recovery retries once a minute. The
snapshot and backup inventory deliberately does not archive the data mount.

## Local snapshots and restore

The source-build stack from *Deploy* uses `docker compose` in `deploy/`.
The installed VPS instead uses the managed backup/restore above.

```sh
docker compose exec falky /falky snapshot
# Use the exact printed path, for example:
docker compose cp falky:/snapshots/falky-20261106T120000Z.db ./database.db
chmod 600 database.db
```

Snapshots are consistent while the server runs; never copy `falky.db`, `-wal`
or `-shm` directly. Each snapshot is mode 0600 in a separate snapshot volume.
Two snapshots in the same second conflict; retry later. A snapshot includes the
access link, messages, rooms and hashed visitor tokens, so protect it like `.env`.

For a local restore, first save the current snapshot if needed, then explicitly
check the printed database volume before deleting only that volume:

```sh
database_volume=$(docker compose config --format json | python3 -c 'import json, sys; print(json.load(sys.stdin)["volumes"]["falky_data"]["name"])')
printf 'Selected database volume: %s\n' "$database_volume"
docker compose down
docker volume rm -- "${database_volume:?}"
docker compose run --rm --no-deps -T falky restore < database.db
docker compose up -d --build --wait
docker compose exec falky /falky health ready
```

Do not mount the new volume into another helper first: the server image must
initialize its ownership. Restore checks integrity and known migrations and
refuses an existing database. Use the compatible saved server source/image;
an older binary cannot restore a snapshot containing newer migrations. Rooms,
messages and access return to the snapshot's state. Rotate the link if the
snapshot may have leaked. Keep `.env` and the local certificate volume separately.

## `make smoke`

Run only against a disposable local stack. It rotates the access link, ends
existing access and leaves test rooms/visitors. It trusts Caddy's local authority,
not public certificates. Do not run it on either shared VPS instance; validate
voice and screen sharing manually in both domains after migration.
