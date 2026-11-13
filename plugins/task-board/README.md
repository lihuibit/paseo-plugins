# Task Board（`agentstorm-task-board`）

Paseo 任务看板插件：卡片、分配 Agent、启动/停止、生命周期 hooks 驱动状态、
Agent 主动调用的 `board_declare` 工具，以及定时/周期、WeCom 通知、父子任务和
旧任务迁移。只支持 Agent 执行，不包含 Pipeline。

## 环境要求

- Paseo `>=0.16.0 <0.17.0`（实测 `0.16.0-beta.2`）
- 宿主 `config.json` 中 `pluginsEnabled: true`
- Agent 主动声明需要宿主开启 `daemon.mcp.injectIntoAgents: true`。未开启时看板顶部
  显示黄色横幅，状态只能由 hooks 推断。

## 安装

```bash
cd ~/code/funny_projects/paseo-plugins
npm install
npm run sync:core

paseo plugin install "$PWD/plugins/task-board" --home ~/.paseo-dev
paseo plugin ls --home ~/.paseo-dev
```

修改代码后：

```bash
paseo plugin reload agentstorm-task-board --home ~/.paseo-dev
```

卸载只删除 Paseo 的插件注册，保留 `plugin-data/agentstorm-task-board/`：

```bash
paseo plugin remove agentstorm-task-board --home ~/.paseo-dev
```

## 数据目录

```text
$PASEO_HOME/plugin-data/agentstorm-task-board/
├── tasks.json          # { version, nextNumber, tasks[] }
├── agentIndex.json     # agentId -> taskId
├── events.jsonl        # hook / 声明 / 状态事件
├── deleted.jsonl       # 删除审计
├── settings.json       # WeCom、时区（0600）
├── notifications.jsonl # 通知发送与重试记录
├── migrations/tasks.json
└── locks/scheduler.lock
```

`tasks.json` 每次写入走串行队列 + 临时文件原子替换。插件重启后从磁盘恢复卡片和绑定；
没有 label 的 Agent 不会进入索引。

## RPC

所有返回都是 `{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`。
业务错误带 code；revision 冲突返回 `E_REVISION_CONFLICT`，`details.httpStatus = 409`，
并附带最新 `task`。

| 方法                             | 作用                                        |
| -------------------------------- | ------------------------------------------- |
| `task-board.list`                | 过滤列卡（状态/项目/标签/搜索）             |
| `task-board.get`                 | 单卡                                        |
| `task-board.create`              | 建卡，默认 `planning`                       |
| `task-board.update`              | 编辑，带 `expectedRevision`                 |
| `task-board.set-status`          | 人工流转，带 `expectedRevision`             |
| `task-board.candidates`          | Project / Workspace / Agent / Provider 候选 |
| `task-board.assign`              | 记录目标，`start=true` 立即启动             |
| `task-board.start`               | 新建或继续 Agent                            |
| `task-board.stop`                | 中断当前 turn，`blocked(manual)`            |
| `task-board.cancel`              | 取消并归档 Agent，`cancelled` + `final`     |
| `task-board.unassign`            | 清除执行体，回 `planning`                   |
| `task-board.schedule`            | 设置/清除定时或 recurring                   |
| `task-board.set-hierarchy`       | 设置父任务（拒绝自指与环）                  |
| `task-board.hierarchy`           | 父任务、子任务列表与只读进度汇总            |
| `task-board.delete`              | 删除卡片并审计                              |
| `task-board.declare`             | 测试/内部声明入口（只接受绑定的 Agent）     |
| `task-board.progress`            | 测试/内部进度入口                           |
| `task-board.settings.get/update` | 读取/更新 WeCom 通知设置                    |
| `task-board.notifications.test`  | 发送测试消息并返回每次尝试                  |
| `task-board.migrate-legacy`      | 只读导入 `$PASEO_HOME/tasks/tasks.json`     |
| `task-board.health`              | 数据目录、绑定数、MCP 注入、调度器状态      |

## Agent 归属与 hooks

- 创建 Agent 时写入 label：`agentstorm.board=1`、`agentstorm.task-id=<btask>`、
  `agentstorm.kind=task`。
- 同时写入 metadata `agentstorm.task-board.taskId`。`agent.turn.*` 载荷不含 labels，
  因此 hook 先用 `agentIndex.json`，再用 metadata 兜底。
- 只处理 `execution.agentId` 与事件 Agent 一致的卡片；用户自己的 Agent 不进入索引。
- `agent.turn.before`：`todo` / `in_review` / `blocked` → `in_progress`，清理旧声明。
- `agent.turn.after`：`completed` → `in_review`；`failed` → `blocked(agent_error)`；
  `canceled` 且有人工停止标记 → `blocked(manual)`，否则 `blocked(agent_silent)`。
- `agent.permission.before`：`question` → `blocked(question)`，其余 →
  `blocked(permission)`，原文写入 `blockDetail` / `pendingPermission`。
- `agent.permission.after`：allow → 回 `in_progress`；deny → 保持
  `blocked(permission)` 并记录拒绝原因。以 `requestId` 去重。
- `agent.close.after` / `agent.archive.after`：先 `refresh()`；runtime 仍存在且未归档
  → no-op，否则 `blocked(agent_missing)`；`in_review` 不被降级。看板自己
  cancel/delete 归档时忽略。
- 每 30 秒对账一次绑定 Agent：running 保持；idle 且无声明 → `blocked(agent_silent)`；
  不存在/已归档 → `blocked(agent_missing)`；发现 `pendingPermissions` 时补写 blocked。
- 同一 `turnId` 去重；重复事件不改变 revision。
- 同一 Agent 被多张卡复用时，hooks 跟随最近更新的非终态卡片，避免旧 label 抢走事件。

## 定时与 recurring

- `scheduled`：到点启动一次，`nextRunAt=null`；失败把 `nextRunAt` 推后 60 秒并写
  `blocked(agent_error)`。
- `recurring`：父卡保持 `todo`，每次触发派生一张子卡（`parentTaskId`）并启动；
  `derivedCount + 1`。上一轮子卡未结束时跳过本轮，但仍推进 cadence。
- 支持 `everyMs` 与五段 cron（分/时/日/月/周），cron 可带 IANA 时区。
- 每个 tick 只补跑一次；插件重启后按持久化的 `nextRunAt` 对账，不按错过次数补跑。
- `locks/scheduler.lock` 用 pid + heartbeat 保证单实例；90 秒无心跳视为陈旧锁并可接管。
- 调度器在插件收到第一次 RPC 或 hook 时启动（Paseo 0.16 没有 server 启动回调），
  因此 daemon 重启后需要客户端连接一次（UI 打开或 `task-board.health`）才会重新布防。

## WeCom 通知

- `settings.json` 保存 webhook、开关、限流与重试次数，不写 Paseo 配置。
- 进入 `in_review` / `blocked`、定时触发时推送 markdown；`progress` 默认关闭。
- 去重键 `taskId + revision + event`；每任务按 `minIntervalMs` 限流。
- 失败按 1s / 5s / 15s 退避重试，每次尝试写入 `notifications.jsonl`；发送失败不影响卡片。

## 层级、取消与迁移

- `hierarchyParentId` 是人建树关系；父卡只展示子任务进度汇总，不自动推进父状态。
- `delete` 先 stop 再 archive，子任务变顶层，并写 `deleted.jsonl`。
- `unassign` 先 stop，再清空执行体/assignment/trigger，回 `planning`（会话保留）。
- `cancel` 取消 turn、归档 Agent，卡片 `cancelled` + `executionArchive=final`；不提供
  unarchive。`done` 只标 `restorable`。
- `migrate-legacy` 默认 dry-run；只读源文件并记录 sha256。`id` 冲突会重映射，
  未知状态回落 `planning`，`pipeline` 执行体丢弃，Agent 执行体仅在 Paseo 仍存在时保留。
  同一 `sourceDigest` 重复执行返回 no-op。

## `board_declare`

通过 `agent.open.before` 附加到带 `agentstorm.board=1` 的会话，不建 MCP server。

| kind       | 效果                                       |
| ---------- | ------------------------------------------ |
| `review`   | `in_review`                                |
| `blocked`  | `blocked` + `blockReason` + `humanRequest` |
| `waiting`  | 保持 `in_progress`，记录说明               |
| `progress` | 只更新进度，不换列                         |
| `clear`    | 清除声明                                   |

工具只在 session open 时附加；修改后需要 `paseo plugin reload` 并让 Agent 重开会话。

## 边界与已知偏差

- Paseo 0.16 的 `PaseoApi` 没有公开 `cancelAgent`。`task-board.stop` 用
  `agent.reload()` 中断当前 turn（会话与历史保留），卡片立即写 `blocked(manual)`。
- UI 用 2.5 秒轮询 `task-board.list`，没有实现 `task-board.watch` 订阅。
- `background: true` 只影响可见性；无人值守由 `modeId`（如 `full-access`）表达。
- Paseo 0.16 的 `PluginServerContext` 不暴露 `PaseoApi`，插件没有 server 启动回调；
  调度器只能在第一次 RPC 或 hook 到达时布防。daemon 重启后在该客户端连接之前定时
  任务不会触发；首次访问会按持久化的 `nextRunAt` 补跑一次到期任务，不按错过次数
  重复补跑。运维上应在重启后打开一次看板，或调用 `task-board.health` 完成布防：

  ```bash
  PASEO_RELEASE_HOME=~/.paseo-plugin-test \
    node scripts/task-board-health.mjs
  ```

## 验证

```bash
npm run check:core
npm run typecheck
npm run lint
npm test --workspace packages/core
npm test --workspace plugins/task-board
```

端到端（需要 Paseo dev daemon 和已创建的 Project / Workspace）：

```bash
E2E_PROJECT_ID=<prj_id> E2E_WORKSPACE_ID=<wks_id> npm run e2e:task-board
npm run e2e:i4
npm run e2e:i4-migrate
```

I2 / I4 的实测截图、日志与落盘快照在 AgentStorm 仓库
`docs/plugins/evidence/implementation/I2/`、`.../I4/`。
