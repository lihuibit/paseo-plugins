#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${PASEO_RELEASE_HOME:-$HOME/.paseo-plugin-test}"
PORT="${PASEO_RELEASE_PORT:-6769}"
EVIDENCE="${PASEO_RELEASE_EVIDENCE:-$ROOT/.e2e/evidence}"
TARGET_REF="${1:-}"

if [ -z "$TARGET_REF" ]; then
  echo "Usage: scripts/release-upgrade.sh <git-ref>" >&2
  exit 1
fi
if [ ! -f "$EVIDENCE/smoke-state.json" ]; then
  echo "Run scripts/release-regression.sh first; missing $EVIDENCE/smoke-state.json" >&2
  exit 1
fi

mkdir -p "$EVIDENCE"
exec > >(tee "$EVIDENCE/upgrade.log") 2>&1

export PASEO_RELEASE_HOME="$HOME_DIR"
export PASEO_RELEASE_PORT="$PORT"
export PASEO_SMOKE_STATE="$EVIDENCE/smoke-state.json"

echo "== before upgrade =="
paseo plugin ls --home "$HOME_DIR" --json >"$EVIDENCE/plugin-ls-before-upgrade.json"
PASEO_SMOKE_ACTION=verify node "$ROOT/scripts/release-smoke.mjs" >"$EVIDENCE/smoke-before-upgrade.json"

echo "== update to $TARGET_REF =="
paseo plugin update agentstorm-shared-assets --ref "$TARGET_REF" --home "$HOME_DIR" --yes
paseo plugin update agentstorm-task-board --ref "$TARGET_REF" --home "$HOME_DIR" --yes
paseo plugin ls --home "$HOME_DIR" --json >"$EVIDENCE/plugin-ls-after-upgrade.json"

echo "== after upgrade =="
PASEO_SMOKE_ACTION=verify node "$ROOT/scripts/release-smoke.mjs" | tee "$EVIDENCE/smoke-after-upgrade.json"

echo "PASS: upgrade preserved binding, projections and board card"
