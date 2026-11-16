#!/usr/bin/env bash
set -euo pipefail

HOME_DIR="${PASEO_RELEASE_HOME:-$HOME/.paseo-plugin-test}"

for id in paseo-shared-assets paseo-task-board; do
  paseo plugin remove "$id" --home "$HOME_DIR" || true
done

paseo plugin ls --home "$HOME_DIR"
