#!/usr/bin/env bash
# Production operations; run as deployer in /srv/falky.
set -euo pipefail
cd -- "$(dirname -- "$0")"
umask 077

usage() {
  echo "Usage: $0 deploy [backend|frontend|ghcr.io/luckmorecat/falky@sha256:<digest> [web image digest or local image ID]] | backup | status" >&2
  exit 2
}

valid_web_image() {
  [[ $1 =~ ^(sha256:[a-f0-9]{64}|ghcr\.io/luckmorecat/falky-web@sha256:[a-f0-9]{64})$ ]]
}

resolve_latest() {
  local repository=$1
  if ! docker pull "$repository:edge" >&2; then
    echo "Cannot obtain latest image for $repository; publish it and check registry access" >&2
    return 1
  fi
  docker image inspect "$repository:edge" --format '{{json .RepoDigests}}' |
    python3 -c '
import json, re, sys
repository = sys.argv[1]
references = json.load(sys.stdin) or []
for reference in references:
    if re.fullmatch(re.escape(repository) + r"@sha256:[a-f0-9]{64}", reference):
        print(reference)
        break
else:
    raise SystemExit("Pulled image has no digest for " + repository)
' "$repository"
}

[[ $# -ge 1 ]] || usage
operation=$1
case "$operation" in
  deploy)
    [[ $# -le 3 ]] || usage
    if [[ $# == 2 && ( $2 == backend || $2 == frontend ) ]]; then
      :
    elif [[ $# -ge 2 ]]; then
      [[ $2 =~ ^ghcr\.io/luckmorecat/falky@sha256:[a-f0-9]{64}$ ]] || usage
    fi
    if [[ $# == 3 ]]; then valid_web_image "$3" || usage; fi
    ;;
  backup|status) [[ $# == 1 ]] || usage ;;
  *) usage ;;
esac

# Serializes scheduled backups and deploys, including the health checks.
exec 9>.operations.lock
flock --timeout "${FALKY_LOCK_WAIT_SECONDS:-0}" 9 || { echo "Another deployment or backup is running" >&2; exit 1; }
# The persisted deployment, rather than an inherited shell variable, is current.
unset FALKY_IMAGE FALKY_WEB_IMAGE
./compose.sh config --quiet

backup() {
  local container caddy_container directory snapshot
  container=$(./compose.sh ps --all --quiet falky)
  if [[ -z "$container" ]] || [[ $(docker inspect --format '{{.State.Running}}' "$container") != true ]]; then
    echo "Backup requires the existing Falky container to be running" >&2
    return 1
  fi
  mkdir -p backups
  directory=$(mktemp -d "backups/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
  snapshot=$(./compose.sh exec -T falky /falky snapshot)
  [[ $snapshot =~ ^/snapshots/falky-[0-9]{8}T[0-9]{6}Z\.db$ ]] || {
    echo "Unexpected snapshot path; backup failed" >&2
    return 1
  }
  ./compose.sh cp "falky:$snapshot" "$directory/database.db"
  chmod 600 "$directory/database.db"
  python3 - "$directory/database.db" <<'PY'
from contextlib import closing
import sqlite3
import sys
from pathlib import Path

with closing(sqlite3.connect(Path(sys.argv[1]).resolve().as_uri() + '?mode=ro', uri=True)) as db:
    if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
        raise SystemExit('Copied database failed its integrity check')
PY
  cp .env compose.yaml compose.production.yaml compose.sh manage.sh ci-deploy.sh prune-backups.py Caddyfile livekit.yaml "$directory/"
  docker inspect --format '{{.Config.Image}}' "$container" > "$directory/image.txt"
  caddy_container=$(./compose.sh ps --all --quiet caddy)
  docker inspect --format '{{.Image}}' "$caddy_container" > "$directory/web-image.txt"
  docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$caddy_container" > "$directory/web-revision.txt"
  printf '%s\n' "$snapshot" > "$directory/snapshot.txt"
  # Only complete backups get this marker. Failed copies remain for diagnosis.
  touch "$directory/complete"
  python3 ./prune-backups.py "$directory" "$container" "$caddy_container"
  echo "Backup saved to $PWD/$directory"
}

health() {
  local report domain code
  report=$(./compose.sh exec -T falky /falky health ready)
  printf '%s\n' "$report"
  python3 -c 'import json, sys; r=json.load(sys.stdin); sys.exit(0 if r.get("status")=="ok" and r.get("components",{}).get("database")=="ok" and r.get("components",{}).get("livekit")=="ok" else 1)' <<< "$report" || return 1
  domain=$(./compose.sh config --format json | python3 -c 'import json, sys; print(json.load(sys.stdin)["services"]["caddy"]["environment"]["FALKY_DOMAIN"])') || return 1
  code=$(curl --proto '=https' --silent --show-error --connect-timeout 5 --max-time 15 \
    --output /dev/null --write-out '%{http_code}' "https://$domain/api/me") || return 1
  [[ $code == 401 ]] || { echo "Public API returned HTTP $code; expected 401 without a visitor cookie" >&2; return 1; }
  # Verify HTML and its JS/CSS too: API health alone cannot detect a missing UI.
  python3 - "$domain" <<'PY' || return 1
from html.parser import HTMLParser
import sys
from urllib.request import urlopen

class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.root = False
        self.assets = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'div' and attrs.get('id') == 'root':
            self.root = True
        if tag == 'script' and attrs.get('src'):
            self.assets.append((attrs['src'], 'javascript'))
        if tag == 'link' and attrs.get('rel') == 'stylesheet':
            self.assets.append((attrs['href'], 'css'))

origin = 'https://' + sys.argv[1]
with urlopen(origin + '/', timeout=15) as response:
    if response.status != 200 or response.headers.get_content_type() != 'text/html':
        raise SystemExit('Frontend did not return HTML')
    page = Page()
    page.feed(response.read().decode())
if not page.root or not any(kind == 'javascript' for _, kind in page.assets):
    raise SystemExit('Frontend root or JavaScript bundle is missing')
for asset, kind in page.assets:
    if not asset.startswith('/assets/'):
        raise SystemExit('Unexpected frontend asset path')
    with urlopen(origin + asset, timeout=15) as response:
        if response.status != 200 or kind not in response.headers.get_content_type():
            raise SystemExit('Frontend asset failed: ' + asset)
        if not response.read(1):
            raise SystemExit('Frontend asset is empty: ' + asset)
print('Frontend HTML, JavaScript and CSS OK')
PY
  echo "HTTPS, frontend and public API OK"
}

case "$operation" in
  backup) backup ;;
  status)
    ./compose.sh ps
    health
    ;;
  deploy)
    services=()
    pull_services=(falky livekit)
    if [[ $# == 1 ]]; then
      image=$(resolve_latest ghcr.io/luckmorecat/falky)
      web_image=$(resolve_latest ghcr.io/luckmorecat/falky-web)
      printf 'Selected server: %s\nSelected web: %s\n' "$image" "$web_image"
    elif [[ $2 == backend ]]; then
      image=$(resolve_latest ghcr.io/luckmorecat/falky)
      web_image=$(./compose.sh config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["caddy"]["image"])')
      services=(falky)
      pull_services=(falky)
    elif [[ $2 == frontend ]]; then
      image=$(./compose.sh config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["falky"]["image"])')
      web_image=$(resolve_latest ghcr.io/luckmorecat/falky-web)
      services=(caddy)
      pull_services=()
    else
      image=$2
      web_image=${3:-$(./compose.sh config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["caddy"]["image"])')}
    fi
    valid_web_image "$web_image" || usage
    if [[ ${services[0]:-} != falky ]]; then
      if [[ $web_image == ghcr.io/* ]]; then
        docker pull "$web_image"
      else
        docker image inspect "$web_image" >/dev/null
      fi
    fi
    # Pull before touching the existing application or its configuration.
    FALKY_IMAGE=$image FALKY_WEB_IMAGE=$web_image ./compose.sh config --quiet
    if [[ ${#pull_services[@]} != 0 ]]; then
      FALKY_IMAGE=$image FALKY_WEB_IMAGE=$web_image ./compose.sh pull "${pull_services[@]}"
    fi
    # Assign separately so a failed container query cannot look like a fresh
    # installation. `compose down` removes containers but retains the database.
    container=$(./compose.sh ps --all --quiet falky)
    if [[ -n "$container" ]]; then
      backup
    else
      data_volume=$(./compose.sh config --format json | python3 -c '
import json, sys
config = json.load(sys.stdin)
mounts = [mount for mount in config["services"]["falky"]["volumes"] if mount["target"] == "/data"]
if len(mounts) != 1 or mounts[0]["type"] != "volume":
    raise SystemExit("Cannot identify the persistent database volume")
name = config["volumes"][mounts[0]["source"]]["name"]
if not name:
    raise SystemExit("Database volume has no resolved name")
print(name)
')
      existing_volumes=$(docker volume ls --format '{{.Name}}')
      while IFS= read -r volume; do
        if [[ $volume == "$data_volume" ]]; then
          printf 'Refusing to deploy: retained database volume %s has no backend container. Recover the previous release and take a backup before upgrading.\n' "$data_volume" >&2
          exit 1
        fi
      done <<< "$existing_volumes"
    fi
    # Commit the selected image atomically. On failure, keep the attempted image
    # configured for diagnosis; migrations make automatic rollback unsafe.
    python3 - "$image" "$web_image" <<'PY'
import os
from pathlib import Path
import sys
import tempfile

path = Path('.env')
lines = path.read_text().splitlines()
lines = [line for line in lines if not line.startswith(('FALKY_IMAGE=', 'FALKY_WEB_IMAGE='))]
lines.append('FALKY_IMAGE=' + sys.argv[1])
lines.append('FALKY_WEB_IMAGE=' + sys.argv[2])
fd, temporary = tempfile.mkstemp(prefix='.env.', dir='.')
try:
    with os.fdopen(fd, 'w') as output:
        output.write('\n'.join(lines) + '\n')
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
    up_args=(--detach --no-build --wait --wait-timeout 180)
    if [[ ${#services[@]} != 0 ]]; then
      up_args+=(--no-deps "${services[@]}")
    fi
    ./compose.sh up "${up_args[@]}"
    # LiveKit readiness and ACME issuance may lag container startup.
    for attempt in {1..18}; do
      if health; then
        printf 'Deployed %s\n' "$image"
        exit 0
      fi
      sleep 5
    done
    echo "Deployment started but verification failed; inspect ./compose.sh ps and logs" >&2
    exit 1
    ;;
esac
