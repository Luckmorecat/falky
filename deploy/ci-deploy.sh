#!/usr/bin/env bash
# Forced SSH command for the dedicated GitHub Actions key.
set -euo pipefail
cd -- "$(dirname -- "$0")"
# A scheduled backup or a manually started deploy may already hold the lock.
export FALKY_LOCK_WAIT_SECONDS=300
case "${SSH_ORIGINAL_COMMAND:-}" in
  deploy) exec ./manage.sh deploy ;;
  status) exec ./manage.sh status ;;
  *) echo "This SSH key permits only deploy or status" >&2; exit 2 ;;
esac
