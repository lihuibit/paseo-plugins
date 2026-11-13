#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${PASEO_RELEASE_HOME:-$HOME/.paseo-plugin-test}"
PORT="${PASEO_RELEASE_PORT:-6769}"
EVIDENCE="${PASEO_RELEASE_EVIDENCE:-$ROOT/.e2e/evidence}"
CLI_EVIDENCE="$EVIDENCE/cli"
TMP_PREFIX="$(mktemp -d)"

mkdir -p "$CLI_EVIDENCE"
exec > >(tee "$CLI_EVIDENCE/release-cli.log") 2>&1
trap 'rm -rf "$TMP_PREFIX"' EXIT

echo "== build CLI =="
cd "$ROOT"
npm run build:cli

echo "== install CLI into temporary prefix =="
npm install -g ./packages/board-cli --prefix "$TMP_PREFIX"
test -x "$TMP_PREFIX/bin/paseo-board"
"$TMP_PREFIX/bin/paseo-board" --version | tee "$CLI_EVIDENCE/version.txt"

export PASEO_RELEASE_HOME="$HOME_DIR"
export PASEO_RELEASE_PORT="$PORT"
export PASEO_BOARD_URL="http://127.0.0.1:$PORT"
export PASEO_BOARD_PASSWORD="$(cat "$HOME_DIR/local-credential")"
export E2E_BOARD_CLI="$TMP_PREFIX/bin/paseo-board"
export E2E_PASEO_HOME="$HOME_DIR"
export E2E_PASEO_PORT="$PORT"
export E2E_REPORT="$CLI_EVIDENCE/e2e-board-cli.json"
export E2E_SKIP_AUTH_TEST=1

echo "== list --json from the installed binary =="
"$TMP_PREFIX/bin/paseo-board" list --json | tee "$CLI_EVIDENCE/list.json"

echo "== full CLI lifecycle =="
node "$ROOT/scripts/e2e-board-cli.mjs"

echo "PASS: installed paseo-board lifecycle and exit codes"
