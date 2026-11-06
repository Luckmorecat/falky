#!/usr/bin/env bash
# Fixed per-instance forced command; stdin is only a bounded runtime archive.
set -euo pipefail
cd -- "$(dirname -- "$0")"
export FALKY_LOCK_WAIT_SECONDS=900
command=${SSH_ORIGINAL_COMMAND:-}
if [[ $command == status || $command == release ]]; then
  exec ./manage.sh "$command"
fi
if [[ ${#command} -le 16020 && $command =~ ^(deploy-release|retry-release)\ ([A-Za-z0-9_=-]+)$ ]]; then
  exec ./manage.sh "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
fi
echo 'This key permits only release, status, deploy-release <request>, retry-release <request>' >&2
exit 2
