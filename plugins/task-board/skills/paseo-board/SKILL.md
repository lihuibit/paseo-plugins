---
name: paseo-board
description: Manage the Paseo task board from an external shell with the paseo-board CLI (list/status/logs/create/assign/start/stop/done/send/wait). Use for external agents and scripts; Paseo-launched planning and worker Agents should use the injected board_* tools instead.
---

# Paseo Board CLI

Use this skill when you are an external Agent or a shell script that needs to
inspect or manage the Paseo task board. You call the `paseo-board` executable
through Bash. Do not use this skill from a Paseo-launched planning Agent or
worker Agent: those sessions already receive `board_list`, `board_status`,
`board_logs`, `board_create`, `board_assign`, `board_start`, `board_done`,
`board_send`, `board_wait`, `board_declare`, and the rest of the `board_*`
tools. Shelling out from those sessions is unnecessary and bypasses their tool
contracts.

## Install the CLI

The CLI lives in the `paseo-plugins` repository and is not required on the
machine that runs the Paseo daemon. In the repository:

```bash
cd ~/code/funny_projects/paseo-plugins
npm install
npm run build:cli
npm install -g ./packages/board-cli
paseo-board --version
```

If global install is not allowed, use a temporary prefix and put its `bin`
directory on `PATH`:

```bash
npm install -g ./packages/board-cli --prefix /tmp/paseo-board
export PATH="/tmp/paseo-board/bin:$PATH"
```

The Paseo daemon must have the `paseo-task-board` plugin installed and
enabled. The caller does not install the plugin and does not need an MCP
server.

## Connect and authenticate

Prefer environment variables so the password does not appear in shell history
or process listings:

```bash
export PASEO_BOARD_URL=http://127.0.0.1:6769
export PASEO_BOARD_PASSWORD="$(cat ~/.paseo-plugin-test/local-credential)"
paseo-board list
```

`--url` and `--password` override the environment. `--home <path>` reads
`daemon.listen` from `<path>/config.json`; it does not read the password, so
still set `PASEO_BOARD_PASSWORD` or pass `--password`. If no URL is supplied,
the CLI uses `PASEO_HOME` / `~/.paseo` and its configured listen address.

Use `--json` whenever you need to parse the result. JSON goes to stdout;
human-readable errors go to stderr.

## Commands

All commands accept the global options `--url`, `--password`, `--home`,
`--json`, `--no-color`, `-h/--help`, and `-V/--version`.

| Command     | Usage                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `list`      | `paseo-board list [--status S] [--parent TASK-x] [--label L] [--query Q] [--limit 50] [--exclude-finished]`                          |
| `show`      | `paseo-board show TASK-x`                                                                                                            |
| `status`    | `paseo-board status TASK-x [--tail 5]`                                                                                               |
| `logs`      | `paseo-board logs TASK-x [--tail 20] [--filter all                                                                                   | text                                                                                                      | tools                      | errors                                                                       | permissions]` |
| `events`    | `paseo-board events TASK-x [--kind K] [--tail 50]`                                                                                   |
| `create`    | `paseo-board create "title" [--description text] [--acceptance item]... [--priority P] [--label L]... [--kind task                   | task-planning] [--parent TASK-x] [--status S]`                                                            |
| `update`    | `paseo-board update TASK-x [--title text] [--description text] [--acceptance item]... [--priority P] [--label L]... [--parent TASK-x | none] [--status S]`                                                                                       |
| `assign`    | `paseo-board assign TASK-x --project P --workspace W [--profile ID                                                                   | name] [--provider P] [--model M] [--mode MODE] [--thinking ID] [--title text] [--message text] [--start]` |
| `start`     | `paseo-board start TASK-x [--message text]`                                                                                          |
| `stop`      | `paseo-board stop TASK-x`                                                                                                            |
| `cancel`    | `paseo-board cancel TASK-x`                                                                                                          |
| `unassign`  | `paseo-board unassign TASK-x`                                                                                                        |
| `done`      | `paseo-board done TASK-x`                                                                                                            |
| `send`      | `paseo-board send TASK-x "message" [--wait [seconds]]`                                                                               |
| `wait`      | `paseo-board wait TASK-x [--until review                                                                                             | blocked                                                                                                   | idle] [--timeout seconds]` |
| `profiles`  | `paseo-board profiles`                                                                                                               |
| `providers` | `paseo-board providers [--provider P] [--cwd PATH]`                                                                                  |
| `declare`   | `paseo-board declare TASK-x review                                                                                                   | blocked                                                                                                   | waiting                    | progress --summary text [--stage name] [--block-reason reason] [--agent ID]` |

`--status` accepts `planning`, `todo`, `in_progress`, `in_review`, `blocked`,
`done`, or `cancelled`. `--priority` accepts `none`, `low`, `medium`, `high`,
or `urgent`. `--acceptance` and `--label` are repeatable. `--until` can be
repeated or given as a comma-separated list.

`TASK-x` and the underlying `btask_...` id are both accepted. `--parent`,
`--project`, `--workspace`, and `--profile` accept an id or a name; if a name
is ambiguous the command fails instead of guessing.

## Recipes

### Board overview

```bash
paseo-board list
paseo-board list --status blocked --json
paseo-board list --parent TASK-40 --status in_review
```

`list --json` returns `{ "tasks": [...], "total": N, "counts": {...} }`,
matching the `board_list` tool. Each task includes a short Agent summary.

### One card and its live Agent

```bash
paseo-board status TASK-42 --tail 5
paseo-board status TASK-42 --json
```

Use `status` to check `lifecycle`, `modeId`, `pendingPermissions`,
`activeTurn`, `lastError`, `lastUsage`, `archivedAt`, and the five most recent
activity entries. It is the cheap way to decide whether an Agent is running,
idle, waiting for permission, or blocked.

### Agent output and tool calls

```bash
paseo-board logs TASK-42 --tail 20
paseo-board logs TASK-42 --tail 20 --filter tools
paseo-board logs TASK-42 --filter errors
paseo-board logs TASK-42 --filter permissions
paseo-board logs TASK-42 --tail 20 --json
```

Use `logs` to read what the Agent actually said or did. `--filter tools`
returns tool name and status; `text` returns assistant/user text; `errors`
returns failed tools and errors; `permissions` returns permission requests and
resolutions.

### Create, assign, and start

```bash
paseo-board create "修复登录超时" \
  --description "复现步骤见 issue" \
  --acceptance "登录 3 秒内完成" \
  --acceptance "超时给出明确提示" \
  --parent TASK-40 \
  --json

paseo-board assign TASK-41 \
  --project "<project name or prj_...>" \
  --workspace "<workspace name or wks_...>" \
  --provider codex \
  --model workbuddy/hy4flash-dev \
  --mode full-access \
  --thinking high

paseo-board start TASK-41
```

Read the created card's `displayId` from the `create --json` output before
assigning. Project, workspace, provider, model, mode, and thinking values must
come from the real environment: use the Paseo UI or
`paseo-board providers --provider <p> --json` to discover them. If
`paseo-board profiles` returns profiles, `--profile <id|name>` can replace the
explicit provider/model/mode/thinking options.

`show TASK-x --json` exposes a card's `projectId` and, when assigned, its
execution project/workspace ids. There is no project/workspace listing command
in this CLI, so read those values from an existing card or the Paseo UI. Never
invent a `prj_...`/`wks_...` id.

### Watch a child task

```bash
paseo-board status TASK-41 --tail 5
paseo-board logs TASK-41 --tail 20 --filter tools
paseo-board wait TASK-41 --until review,blocked,idle --timeout 120
```

`wait` returns `reached: "review" | "blocked" | "idle"` or `null` on timeout.
It exits 0 even on timeout; inspect `reached` (or `status`) before concluding
that the task finished. The timeout is measured in seconds and must be 1–120.

### Rework

```bash
paseo-board send TASK-41 "补充单元测试，并说明覆盖率" --wait 90
paseo-board stop TASK-41
paseo-board start TASK-41
```

If the Agent is running or stuck on a question, `send` interrupts the current
turn before delivering the message. The original question is marked
`Interrupted`; the conversation history is kept, but the model does not
consider the question answered. `send` on an idle Agent adds a turn directly
without changing the card. `--wait` is optional and is capped at 300 seconds.

`stop` cancels the current turn and leaves the card `blocked(manual)`.
`start` resumes the same session. Use `cancel` for abandonment, not rework.
When the provider refuses to acknowledge the cancellation, `stop` and a
`send` that needs to interrupt both fail with a readable error; the card stays
`blocked(manual)` with the reason, and the event log records `stop_failed`
instead of `stopped`. Resolve the pending question in Paseo or wait for the
provider, then retry.

### Accept a card

```bash
paseo-board status TASK-41 --tail 5
paseo-board logs TASK-41 --tail 20
paseo-board done TASK-41
```

`done` is a management action. Verify the acceptance criteria from `show`
and the Agent's actual output first. A worker Agent must not call `done`; its
`board_declare` tool can only report `review`, `blocked`, `waiting`, or
`progress`.

### Create a planning card

```bash
paseo-board create "规划：拆分登录超时修复" \
  --description "先读父任务与验收标准，再拆分并管理子任务" \
  --acceptance "子任务可独立验收" \
  --kind task-planning \
  --parent TASK-40 \
  --json
```

Assign and start a planning card the same way as a normal card. Its Paseo
Agent receives the `board_*` management tools and the planning prompt; this
skill is only the external shell entry point for inspecting or steering it.

### Declare progress from an external wrapper

```bash
paseo-board declare TASK-41 progress --summary "正在补单元测试" --json
paseo-board declare TASK-41 blocked --summary "需要确认接口契约" \
  --block-reason human_required --json
```

`declare` defaults to the Agent bound to the card. It fails with
`E_NOT_ASSIGNED` when the card has no bound Agent. `--agent` is only for
overriding that id, and it must match the card's binding.

## Semantics that matter

- `status` is the card plus a live snapshot of its bound Agent. `logs` is the
  Agent timeline tail. `status` answers "is it running, blocked, or waiting for
  permission"; `logs` answers "what did it actually output or do".
- `pendingPermissions` is not approval. When it is non-empty, `send` interrupts
  the turn and marks the request `Interrupted`; other permissions still need a
  human decision in the Paseo UI/desktop. The CLI surfaces requests and
  history, but does not approve or deny them.
- A blocked card carries `blockReason` (`agent_error`, `agent_silent`,
  `question`, `permission`, `agent_missing`, `human_required`, `manual`) and
  `blockDetail`. `stop` produces `blocked(manual)`; a pending permission
  produces `blocked(permission)` plus `pendingPermissions`.
- Card changes use revisions. The CLI reads the current revision before
  `update`, `assign`, `cancel`, and `unassign`, but another client can still
  win the race. `E_REVISION_CONFLICT` (exit 1) means re-read with `show` or
  `status` and retry the command. Do not blindly loop a write command.
- `done` records acceptance. It does not archive the Agent and it does not
  replace checking the logs and acceptance criteria. `stop` and `cancel` have
  different effects: `stop` keeps the session and blocks the card; `cancel`
  cancels and archives the execution.
- `declare` is for the bound Agent or a wrapper acting for it. It is not a
  way to bypass the board state machine or to mark a card done.

## Output, limits, and safety

- `status` tail is 1–20 entries (default 5). `logs` tail is 1–200 (default
  20). `events` tail is 1–500 (default 50). `list --limit` is 1–200 (default
  50).
- Log text is truncated by the plugin at 500 characters per entry. Reasoning
  is not returned, and images are not inlined.
- `send --wait` waits at most 300 seconds; `wait --timeout` waits at most 120
  seconds.
- `--json` output can contain prompts, Agent output, paths, and permission
  descriptions. Treat it as sensitive.
- Never put the daemon password in a command line, a prompt, a committed file,
  or a log. Use `PASEO_BOARD_PASSWORD` from a secret store or environment.
  `--password` exists but is visible in shell history and process listings.
- Use `--no-color` or `NO_COLOR=1` when capturing output to a file.

## Exit codes and errors

| Code | Meaning               | Typical cases                                                                       |
| ---- | --------------------- | ----------------------------------------------------------------------------------- |
| 0    | Success               | Includes `wait` timing out with `reached: null`                                     |
| 1    | Business error        | `E_TASK_NOT_FOUND`, `E_NOT_ASSIGNED`, `E_REVISION_CONFLICT`, `E_INVALID_TRANSITION` |
| 2    | Usage error           | Unknown option, missing argument, invalid enum value, bad `--timeout`               |
| 3    | Connection/auth error | Daemon down or unreachable, password required, incorrect password                   |

Common messages:

- `Password required ...` / `Incorrect password ...` — exit 3. Set
  `PASEO_BOARD_PASSWORD` or pass `--password`.
- `Cannot connect to Paseo daemon ...` — exit 3. Check `PASEO_BOARD_URL`,
  daemon status, and the port.
- `E_TASK_NOT_FOUND: Task not found: TASK-x` — exit 1. Re-read `list`.
- `E_NOT_ASSIGNED ...` — exit 1. Assign an Agent and start the card first.
- `E_REVISION_CONFLICT ...` — exit 1. Re-read the card and retry.

## Quick checklist for an external Agent

1. Confirm `paseo-board` is on `PATH` and `PASEO_BOARD_URL` points at the right
   daemon.
2. `paseo-board list --json` to find the card.
3. `paseo-board status TASK-x --tail 5 --json` before writing.
4. `paseo-board logs TASK-x --tail 20 --filter tools --json` to see real work.
5. Create/assign/start only with values discovered from `providers` and the
   real project/workspace.
6. Watch with `wait`, then re-check `status` and `logs`.
7. Call `done` only after verifying acceptance; otherwise `send` for rework or
   `stop`/`cancel` as appropriate.
