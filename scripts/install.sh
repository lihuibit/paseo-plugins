#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${PASEO_RELEASE_HOME:-$HOME/.paseo-plugin-test}"
REF="${PASEO_RELEASE_REF:-}"

echo "Installing plugins from file://$ROOT into $HOME_DIR${REF:+ at $REF}"

paseo plugin install "file://$ROOT:plugins/shared-assets" \
  --home "$HOME_DIR" ${REF:+--ref "$REF"}
paseo plugin install "file://$ROOT:plugins/task-board" \
  --home "$HOME_DIR" ${REF:+--ref "$REF"}

paseo plugin ls --home "$HOME_DIR"
