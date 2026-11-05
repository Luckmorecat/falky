#!/usr/bin/env bash
# Install a separate copy beside each instance and bind its CI key to this path.
set -euo pipefail
cd -- "$(dirname -- "$0")"
export FALKY_LOCK_WAIT_SECONDS=900
command=${SSH_ORIGINAL_COMMAND:-}
if [[ $command == status ]]; then
  exec ./manage.sh status
fi
# Match the entire command before splitting. No eval, arbitrary shell, tags,
# component updates or latest-image selection are accepted from CI.
if [[ $command =~ ^deploy\ (ghcr\.io/luckmorecat/falky@sha256:[a-f0-9]{64})\ (ghcr\.io/luckmorecat/falky-web@sha256:[a-f0-9]{64})$ ]]; then
  exec ./manage.sh deploy "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
fi
echo "This SSH key permits only deploy <server digest> <web digest> or status" >&2
exit 2
