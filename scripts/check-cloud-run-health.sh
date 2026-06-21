#!/usr/bin/env bash
# Thin wrapper: delegates to the Python checker. Kept as .sh purely so the
# workflow step can `bash scripts/check-cloud-run-health.sh`.
set -euo pipefail
exec python3 "$(dirname "$0")/check_cloud_run_health.py" "$@"
