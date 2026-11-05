#!/usr/bin/env bash
# Install a separate copy beside each instance and bind its CI key to this path.
set -euo pipefail
cd -- "$(dirname -- "$0")"
export FALKY_LOCK_WAIT_SECONDS=900
command=${SSH_ORIGINAL_COMMAND:-}
if [[ $command == status || $command == release ]]; then
  exec ./manage.sh "$command"
fi
# Match the entire command before splitting. No eval, arbitrary shell, tags,
# component updates or latest-image selection are accepted from CI.
if [[ ${#command} -le 16015 && $command =~ ^deploy-release\ ([A-Za-z0-9_=-]+)$ ]]; then
  exec ./manage.sh deploy-release "${BASH_REMATCH[1]}"
fi
echo "This SSH key permits only release, deploy-release <validated request> or status" >&2
exit 2
