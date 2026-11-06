#!/usr/bin/env bash
set -euo pipefail
instance=$(cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$instance/active/release.py" --instance "$instance" compose "$@"
