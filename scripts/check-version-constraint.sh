#!/usr/bin/env bash
set -euo pipefail

HOME_DIR="${PASEO_RELEASE_HOME:-$HOME/.paseo-plugin-test}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

check_range() {
  local range="$1"
  cat >"$TMP/paseo-plugin.json" <<JSON
{
  "id": "agentstorm-version-probe",
  "name": "Version probe",
  "requirements": { "paseo": "$range" }
}
JSON

  set +e
  OUTPUT="$(paseo plugin install "$TMP" --home "$HOME_DIR" 2>&1)"
  STATUS=$?
  set -e

  echo "$OUTPUT"
  if [ "$STATUS" -eq 0 ]; then
    echo "FAIL: incompatible requirements.paseo $range was accepted" >&2
    paseo plugin remove agentstorm-version-probe --home "$HOME_DIR" >/dev/null 2>&1 || true
    exit 1
  fi
  if ! grep -q "requires Paseo $range" <<<"$OUTPUT"; then
    echo "FAIL: rejection did not mention the requirement range $range" >&2
    exit 1
  fi
}

check_range ">=0.14.0 <0.15.0"
check_range ">=0.17.0 <0.18.0"

echo "PASS: incompatible requirements.paseo ranges rejected"
