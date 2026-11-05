#!/usr/bin/env bash
# Forced SSH command for the dedicated GitHub Actions key.
set -euo pipefail
cd -- "$(dirname -- "$0")"
# A scheduled backup or a manually started deploy may already hold the lock.
export FALKY_LOCK_WAIT_SECONDS=900
case "${SSH_ORIGINAL_COMMAND:-}" in
  deploy) exec ./manage.sh deploy ;;
  'deploy backend') exec ./manage.sh deploy backend ;;
  'deploy frontend') exec ./manage.sh deploy frontend ;;
  status) exec ./manage.sh status ;;
  *) echo "This SSH key permits only deploy, deploy backend, deploy frontend or status" >&2; exit 2 ;;
esac
