#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${PASEO_RELEASE_HOME:-$HOME/.paseo-plugin-test}"
PORT="${PASEO_RELEASE_PORT:-6769}"
EVIDENCE="${PASEO_RELEASE_EVIDENCE:-$ROOT/.e2e/evidence}"

if [ "$HOME_DIR" != "$HOME/.paseo-plugin-test" ] && [ "${PASEO_RELEASE_ALLOW_CUSTOM_HOME:-0}" != "1" ]; then
  echo "Refusing to reset $HOME_DIR; set PASEO_RELEASE_ALLOW_CUSTOM_HOME=1 to override" >&2
  exit 1
fi

mkdir -p "$EVIDENCE"
exec > >(tee "$EVIDENCE/regression.log") 2>&1

echo "== clean home =="
paseo daemon stop --home "$HOME_DIR" >/dev/null 2>&1 || true
rm -rf "$HOME_DIR"
mkdir -p "$HOME_DIR"
cat >"$HOME_DIR/config.json" <<JSON
{
  "version": 1,
  "daemon": {
    "listen": "127.0.0.1:$PORT",
    "relay": { "enabled": false },
    "mcp": { "injectIntoAgents": true }
  },
  "pluginsEnabled": true,
  "features": { "webUi": { "enabled": true } }
}
JSON
cp "$HOME_DIR/config.json" "$EVIDENCE/config.json"

echo "== fixtures =="
node "$ROOT/scripts/release-fixtures.mjs" | tee "$EVIDENCE/fixtures.json"
TEAM_REPO="$ROOT/.e2e/release/team.git"
PROJECT_DIR="$ROOT/.e2e/release/demo-project"

echo "== daemon start =="
paseo daemon start --home "$HOME_DIR" --timeout 180
paseo daemon status --home "$HOME_DIR" | tee "$EVIDENCE/daemon-status.txt"

echo "== project and workspace =="
PROJECT_JSON="$(paseo project create "$PROJECT_DIR" --home "$HOME_DIR" --json)"
PROJECT_ID="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).projectId)' <<<"$PROJECT_JSON")"
WORKSPACE_JSON="$(
  paseo workspace create --project "$PROJECT_ID" --path "$PROJECT_DIR" \
    --isolation local --title "Release Workspace" --home "$HOME_DIR" --json
)"
WORKSPACE_ID="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).workspaceId)' <<<"$WORKSPACE_JSON")"
printf '%s\n%s\n' "$PROJECT_JSON" "$WORKSPACE_JSON" | tee "$EVIDENCE/project-workspace.json"

export PASEO_RELEASE_HOME="$HOME_DIR"
export PASEO_RELEASE_PORT="$PORT"
export PASEO_RELEASE_PROJECT_ID="$PROJECT_ID"
export PASEO_RELEASE_WORKSPACE_ID="$WORKSPACE_ID"
export PASEO_RELEASE_TEAM_REPO="$TEAM_REPO"
export PASEO_SMOKE_STATE="$EVIDENCE/smoke-state.json"

echo "== install =="
"$ROOT/scripts/install.sh" | tee "$EVIDENCE/install.txt"
paseo plugin ls --home "$HOME_DIR" --json >"$EVIDENCE/plugin-ls-after-install.json"

echo "== smoke seed =="
PASEO_SMOKE_ACTION=seed node "$ROOT/scripts/release-smoke.mjs" | tee "$EVIDENCE/smoke-seed.json"

echo "== restart =="
paseo daemon restart --home "$HOME_DIR"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
paseo plugin ls --home "$HOME_DIR" --json >"$EVIDENCE/plugin-ls-after-restart.json"

echo "== smoke verify after restart =="
PASEO_SMOKE_ACTION=verify node "$ROOT/scripts/release-smoke.mjs" | tee "$EVIDENCE/smoke-after-restart.json"

echo "== uninstall =="
"$ROOT/scripts/uninstall.sh" | tee "$EVIDENCE/uninstall.txt"
paseo plugin ls --home "$HOME_DIR" --json >"$EVIDENCE/plugin-ls-after-remove.json"

echo "== user files after uninstall =="
{
  echo "user file:"
  cat "$PROJECT_DIR/notes/user-file.txt"
  echo
  echo "project files:"
  find "$PROJECT_DIR" -path "$PROJECT_DIR/.git" -prune -o -type f -print | sort
  echo
  echo "plugin data:"
  find "$HOME_DIR/plugin-data" -maxdepth 2 -type f | sort
} | tee "$EVIDENCE/after-uninstall-files.txt"

test -f "$PROJECT_DIR/notes/user-file.txt"
test -f "$PROJECT_DIR/.agentstorm/AGENTS.md"
test -f "$PROJECT_DIR/.codex/skills/code-review/SKILL.md"
test -f "$PROJECT_DIR/.claude/skills/writing/SKILL.md"
test -f "$HOME_DIR/plugin-data/agentstorm-task-board/tasks.json"

echo "== version constraint =="
"$ROOT/scripts/check-version-constraint.sh" | tee "$EVIDENCE/version-constraint.txt"

echo "== daemon stop =="
cp "$HOME_DIR/daemon.log" "$EVIDENCE/daemon.log"
tail -n 200 "$HOME_DIR/daemon.log" >"$EVIDENCE/daemon-log-tail.txt"
paseo daemon stop --home "$HOME_DIR"

echo "PASS: install -> smoke -> restart -> uninstall regression"
