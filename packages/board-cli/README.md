# `paseo-board`

从普通 shell 管理 Paseo 任务看板，不需要成为 Paseo Agent，也不引入 MCP server。
外部 Agent（例如用户自己启动的 Claude Code）通过 Bash 调用 `paseo-board ... --json`
就能看卡片、管理子任务并读取 Agent 输出。

CLI 只依赖 `@getpaseo/client` 的 WebSocket RPC，直接调用插件
`agentstorm-task-board` 的 `task-board.*` 方法。插件仍装在 Paseo daemon 上，
调用方不需要安装插件。

## 环境要求

- Node.js 20+
- Paseo daemon 已安装并启用 `agentstorm-task-board`（`pluginsEnabled: true`）
- daemon 的密码（如果启用了 `daemon.auth.password`）

## 安装

在 `paseo-plugins` 仓库里构建并全局安装：

```bash
cd ~/code/funny_projects/paseo-plugins
npm install
npm run build:cli
npm install -g ./packages/board-cli

paseo-board --version
```

开发时也可以用 `npm link ./packages/board-cli`。全局安装会打包当前的
`dist/`，所以安装前先运行 `npm run build:cli`。

## 连接与鉴权

优先级：命令行参数 > 环境变量 > `--home` 的 `config.json`。

```bash
# 显式 URL（http/https/ws/wss 都可，未写 /ws 时自动补）
export PASEO_BOARD_URL=http://127.0.0.1:6769
export PASEO_BOARD_PASSWORD="$(cat ~/.paseo-plugin-test/local-credential)"

paseo-board list
```

等价写法：

```bash
paseo-board --url http://127.0.0.1:6769 --password "$PASSWORD" list
```

只想复用某个 home 的监听地址时：

```bash
paseo-board --home ~/.paseo-dev list
```

`--home` 只读取 `config.json` 里的 `daemon.listen`；密码仍然必须来自
`PASEO_BOARD_PASSWORD` 或 `--password`。未指定 `--url` / `PASEO_BOARD_URL` 时，
默认 home 是 `~/.paseo`（可用 `PASEO_HOME` 覆盖）。

## 命令

```text
paseo-board list [--status S] [--parent TASK-x] [--label L] [--query Q] [--limit 50] [--exclude-finished]
paseo-board show TASK-x
paseo-board status TASK-x [--tail 5]
paseo-board logs TASK-x [--tail 20] [--filter all|text|tools|errors|permissions]
paseo-board events TASK-x [--kind K] [--tail 50]
paseo-board create "title" [--description ...] [--acceptance ...] [--kind task|task-planning] [--parent TASK-x] [--priority P] [--label L] [--status S]
paseo-board update TASK-x [--title ...] [--description ...] [--acceptance ...] [--priority ...] [--label ...] [--parent TASK-x|none] [--status ...]
paseo-board assign TASK-x --project P --workspace W [--profile ID|name | --provider P --model M --mode MODE --thinking ID] [--title ...] [--message ...] [--start]
paseo-board start TASK-x [--message ...]
paseo-board stop TASK-x
paseo-board cancel TASK-x
paseo-board unassign TASK-x
paseo-board done TASK-x
paseo-board send TASK-x "message" [--wait [seconds]]
paseo-board wait TASK-x [--until review|blocked|idle] [--timeout seconds]
paseo-board profiles
paseo-board providers [--provider P] [--cwd PATH]
paseo-board declare TASK-x review|blocked|waiting|progress --summary ...
```

`TASK-x` 和 `btask_...` 都接受。`--parent`、`--project`、`--workspace`、
`--profile` 既可以传 ID，也可以传名称；名称不唯一时命令会报错。

常用示例：

```bash
paseo-board list --status in_review
paseo-board status TASK-42
paseo-board logs TASK-42 --tail 30 --filter tools
paseo-board create "修复登录超时" \
  --description "复现步骤见 issue" \
  --acceptance "登录 3 秒内完成" \
  --acceptance "超时给出明确提示" \
  --parent TASK-40

paseo-board assign TASK-42 \
  --project "dev2-agentstorm开发" \
  --workspace "dev2-开发" \
  --provider codex --model workbuddy/hy4flash-dev \
  --mode full-access --thinking high

paseo-board start TASK-42
paseo-board wait TASK-42 --until review,blocked --timeout 120
paseo-board send TASK-42 "补充单元测试" --wait 90
paseo-board stop TASK-42
paseo-board done TASK-42
```

`send --wait` 不写秒数时最多等 300 秒；`wait --timeout` 范围 1–120 秒。
`wait` 超时仍以退出码 0 结束，通过 `--json` 的 `reached: null` 判断。

## 输出

- 默认输出给人和终端看；`--json` 输出单个 JSON 文档到 stdout，可直接
  `JSON.parse`。
- 错误一律写 stderr，stdout 保持为空。
- `--no-color`、`NO_COLOR` 或非 TTY 会关闭 ANSI 颜色。
- `status` 返回 `task`、`agent`（lifecycle、modeId、pendingPermissions、
  activeTurn、lastError、lastUsage、archivedAt）和 `recentActivity`。
- `list` 返回 `tasks`（卡片摘要 + Agent 摘要）、`total` 和 `counts`，与
  `board_list` 同形。
- `logs` 返回 timeline 尾部，默认 20 条、最大 200，每条文本由插件截断到
  500 字符，不返回 reasoning。

退出码：

| 退出码 | 含义                                                   |
| ------ | ------------------------------------------------------ |
| 0      | 成功（包括 `wait` 超时）                               |
| 1      | 业务错误，例如任务不存在、revision 冲突、Agent 未分配  |
| 2      | 参数错误，例如未知选项、缺少参数、非法枚举值           |
| 3      | 连接或鉴权错误，例如 daemon 未启动、密码错误、缺少密码 |

## 外部 Claude Code 使用

外部 Agent 不需要安装插件，也不需要 MCP。给 Claude Code 加 Bash allowlist：

```json
{
  "permissions": {
    "allow": ["Bash(paseo-board:*)"]
  }
}
```

然后让 Agent 用 `--json` 调用，例如：

```bash
paseo-board list --json
paseo-board status TASK-42 --json
paseo-board logs TASK-42 --tail 30 --json
paseo-board declare TASK-42 progress --summary "正在补测试" --json
```

环境变量通过启动 Claude Code 的 shell 继承，文档里不要把密码写进 prompt。

## 与 Agent 工具的能力对齐

| CLI                                      | Paseo Agent 工具                                                 |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `list`                                   | `board_list`                                                     |
| `show`                                   | `board_get`                                                      |
| `status`                                 | `board_status`                                                   |
| `logs`                                   | `board_logs`                                                     |
| `events`                                 | `board_events`                                                   |
| `create`                                 | `board_create`                                                   |
| `update`                                 | `board_update` + `task-board.set-status`                         |
| `assign`                                 | `board_assign`                                                   |
| `start` / `stop` / `cancel` / `unassign` | `board_start` / `board_stop` / `board_cancel` / `board_unassign` |
| `done`                                   | `board_done`                                                     |
| `send`                                   | `board_send`                                                     |
| `wait`                                   | `board_wait`                                                     |
| `profiles`                               | `board_profiles`                                                 |
| `providers`                              | `board_providers`                                                |
| `declare`                                | `board_declare`                                                  |

`status` / `logs` 的字段与对应 Agent 工具一致。`list` / `show` 返回完整卡片记录，
是 Agent 工具摘要字段的超集。

## 管理面与边界

- `done` 是管理面操作：只应由人、规划 Agent 或明确的管理脚本调用；普通 worker
  不应自己结束卡片。
- permission 请求会出现在 `status` 的 `pendingPermissions` 和
  `logs --filter permissions` 中。CLI 当前不自动批准/拒绝权限；需要在 Paseo
  UI/桌面端处理。这样避免外部脚本在无人值守时绕过审批。
- `stop` 会中断当前 turn 并把卡片置为 `blocked(manual)`；`cancel` 会取消并归档
  Agent；`done` 只改卡片状态。
- 不引入 MCP server，不修改 Paseo 或 AgentStorm 源码。

## 验证

```bash
cd ~/code/funny_projects/paseo-plugins
npm run verify

E2E_PASEO_HOME=~/.paseo-plugin-test E2E_PASEO_PORT=6769 \
  npm run e2e:board-cli
```

E2E 在独立 home 上以外部进程调用 CLI，覆盖
list/create/update/assign/start/status/logs/events/send/stop/done，以及
任务不存在、密码错误、连接失败、参数错误四类错误。
密码错误用例使用 `E2E_AUTH_URL`（默认 `http://127.0.0.1:6767`，需要启用
`daemon.auth.password`）。
