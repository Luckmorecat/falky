#!/usr/bin/env bash
# CI transport only. The host's forced command validates the release protocol.
set -euo pipefail
[[ $# == 1 ]] || exit 2
[[ ${VPS_HOST:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { echo "Invalid VPS_HOST" >&2; exit 1; }
test -n "${VPS_SSH_KEY:-}" || { echo "Missing VPS_SSH_KEY" >&2; exit 1; }
test -n "${VPS_KNOWN_HOSTS:-}" || { echo "Missing VPS_KNOWN_HOSTS" >&2; exit 1; }
umask 077
credentials=$(mktemp -d "${RUNNER_TEMP:-/tmp}/vps-ssh.XXXXXXXX")
trap 'rm -rf -- "$credentials"' EXIT
printf '%s\n' "$VPS_SSH_KEY" > "$credentials/key"
printf '%s\n' "$VPS_KNOWN_HOSTS" > "$credentials/known_hosts"
ssh -F /dev/null -T \
  -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none \
  -o StrictHostKeyChecking=yes -o UpdateHostKeys=no \
  -o UserKnownHostsFile="$credentials/known_hosts" \
  -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -i "$credentials/key" -l deployer "$VPS_HOST" "$1"
