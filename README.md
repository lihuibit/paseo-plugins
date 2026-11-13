# paseo-plugins

Paseo 插件 monorepo。

- `shared-assets`：把团队 Git 仓库中的 Skill、`AGENTS.md`、Knowledge 和 Doc 绑定到
  Paseo Project，并投影到 Provider 原生目录。
- `task-board`：Agent 驱动的任务看板，支持卡片、分配 Agent、启动/停止、
  `agent.turn.*` / `agent.permission.*` / `agent.close.after` hooks、
  `board_declare`、定时与周期任务、WeCom 通知、父子任务和旧任务迁移。
- `paseo-board`：任务看板 CLI，供普通 shell 和外部 Agent（如 Claude Code）使用，
  不需要 MCP，调用方也不需要安装插件。

## 环境要求

- Paseo `>=0.16.0 <0.17.0`（清单里已锁定，实测 `0.16.0-beta.2`）
- Node.js 20+、Git
- Paseo daemon 已启用插件：`config.json` 中 `pluginsEnabled: true`

## 目录

```text
packages/core/              纯逻辑：路径校验、diff、Skill frontmatter、Provider 矩阵
packages/board-cli/         看板 CLI（bin: paseo-board）
plugins/shared-assets/      插件本体（server + client + shared 契约）
plugins/task-board/         任务看板插件（server + client + shared 契约）
scripts/sync-core.mjs       把 packages/core/src 生成到插件 shared/core
scripts/e2e-setup.mjs       创建测试 Git 仓库与测试项目
scripts/e2e-rpc.mjs         通过 Paseo SDK 调用插件 RPC 的端到端脚本
scripts/verify-persisted.mjs 重启/重装后的持久化检查
scripts/release-regression.sh 干净 home 安装 → smoke → 重启 → 卸载回归
scripts/release-upgrade.sh  升级到指定 revision 并校验数据保留
scripts/release-smoke.mjs   发布 smoke（共享资产绑定/投影 + 看板卡片）
scripts/e2e-board-cli.mjs   外部 shell 调用 paseo-board 的端到端脚本
scripts/release-cli.sh      构建并把 CLI 装进临时 prefix 后跑完整生命周期
scripts/e2e-planning-smoke.mjs 规划卡片 systemPrompt 与 board_* 工具 smoke
```

Paseo 的插件编译器只允许插件目录内（`client/`、`server/`、`shared/`）的模块进入
bundle，因此 `packages/core` 是唯一源码，插件内的 `shared/core` 是生成副本：

```bash
npm run sync:core    # 生成
npm run check:core   # 校验没有漂移
```

`packages/core` 同时生成到两个插件的 `shared/core`，两个插件之间不互相 import。

## 安装

两个插件独立安装、独立升级、互不依赖。Git 安装要求在仓库根目录提交后执行，
Paseo 会克隆仓库并运行清单里的 `build`（`npm ci` + `sync:core`）。

```bash
cd ~/code/funny_projects/paseo-plugins
git add -A && git commit -m "release: plugins"   # 未提交的改动不会进入克隆

PASEO_RELEASE_HOME=~/.paseo-plugin-test scripts/install.sh
```

等价的单条命令：

```bash
paseo plugin install "file://$PWD:plugins/shared-assets" --home ~/.paseo-plugin-test
paseo plugin install "file://$PWD:plugins/task-board" --home ~/.paseo-plugin-test
paseo plugin ls --home ~/.paseo-plugin-test
```

远端仓库把 `file://$PWD` 换成 `git:owner/repository` 或完整 Git URL；子目录用
`:plugins/<name>` 后缀。`--ref <branch|tag|commit>` 只在首次安装时固定版本。

开发时也可以目录安装，直接引用源码路径，不复制、不执行 build：

```bash
npm install && npm run sync:core
paseo plugin install "$PWD/plugins/shared-assets" --home ~/.paseo-dev
paseo plugin install "$PWD/plugins/task-board" --home ~/.paseo-dev
paseo plugin reload agentstorm-shared-assets --home ~/.paseo-dev
paseo plugin reload agentstorm-task-board --home ~/.paseo-dev
```

## 配置

- `config.json` 必须设置 `pluginsEnabled: true`。
- 看板 UI 需要 `features.webUi.enabled: true`（daemon 自带 Web 客户端）。
- 看板 Agent 的 `board_declare` 需要 `daemon.mcp.injectIntoAgents: true`；未开启时
  看板顶部显示黄色横幅，状态只能由 hooks 推断。
- 两个插件的数据都在 `$PASEO_HOME/plugin-data/<plugin-id>/`，不写 AgentStorm home。

## 升级

升级只改插件安装版本，不触碰 `plugin-data` 和项目文件。先确认新版本已提交，再执行：

```bash
paseo plugin update agentstorm-shared-assets --ref <new-commit> --home ~/.paseo-plugin-test
paseo plugin update agentstorm-task-board --ref <new-commit> --home ~/.paseo-plugin-test
paseo plugin ls --home ~/.paseo-plugin-test --json
```

升级前脚本会先核对快速验证状态，升级后再次核对绑定、投影文件和看板卡片：

```bash
PASEO_RELEASE_HOME=~/.paseo-plugin-test scripts/release-upgrade.sh <new-commit>
```

失败时 Paseo 丢弃新候选并恢复旧版本；`plugin-data` 不会被升级命令删除。

## 卸载

```bash
PASEO_RELEASE_HOME=~/.paseo-plugin-test scripts/uninstall.sh
```

等价命令：

```bash
paseo plugin remove agentstorm-shared-assets --home ~/.paseo-plugin-test
paseo plugin remove agentstorm-task-board --home ~/.paseo-plugin-test
```

卸载只移除 Paseo 的插件配置，不删除项目内 `.agentstorm/`、`.codex/skills/`、
`.claude/skills/` 文件，也不删除用户项目文件；`plugin-data` 保留，重装后可继续
使用原绑定和卡片。

## 共享仓库规范

```text
team-assets/
├── team-assets.json          # 必填
├── skills/
│   ├── project/<name>/SKILL.md
│   └── global/<name>/SKILL.md
├── AGENTS.md                 # 共享根指令
├── knowledge/<name>.md
└── docs/<name>/              # 目录包，可含图片/附件
```

`team-assets.json`：

```json
{
  "schemaVersion": 1,
  "libraryId": "team-assets",
  "displayName": "Team Assets"
}
```

约束：

- Skill 目录名必须等于 `SKILL.md` frontmatter 的 `name`。
- 拒绝 symlink、路径穿越和凭据文件（`.env*`、`id_rsa`、`*.pem`、`*.key` 等）。
- 单文件上限 8 MiB，目录包上限 40 MiB / 2000 文件。

## 数据目录

```text
$PASEO_HOME/plugin-data/agentstorm-shared-assets/
├── config.json                       # 绑定、投影记录
├── repos/<projectId>/                # 团队仓库 checkout
└── logs/rpc.log                      # RPC 业务错误
```

插件不读写 AgentStorm home，也不依赖 AgentStorm 服务端、CLI 或流水线运行时代码。

## 投影

| 资产             | 项目位置                                          |
| ---------------- | ------------------------------------------------- |
| Skill            | `.codex/skills/<name>/`、`.claude/skills/<name>/` |
| 共享 `AGENTS.md` | `.agentstorm/AGENTS.md`（canonical）              |
| Codex 入口       | 项目根 `AGENTS.md`（符号链接，失败时受管副本）    |
| Claude 入口      | `.claude/CLAUDE.md`（符号链接，失败时受管副本）   |

规则：

- 已存在的用户文件进入冲突，不覆盖。
- 内容一致时不重复写盘。
- 停用 Skill 只删除基线未变的受管副本；本地改过的副本保留。
- 停用/解绑指令入口只删除本插件创建的链接/受管副本，保留 `.agentstorm/AGENTS.md`。
- 解绑时若 checkout 有未提交改动或未推送提交会被拒绝；推送或显式 `force` 后才能解绑。
- 卸载插件不删除任何项目内文件。

## 发布

Knowledge、Prompt、Skill 文件、Doc 文本文件支持“校验并预览 diff → 提交”。提交只包含
选中路径，使用本机 Git 身份；**不会自动 push**，提交后需手动 `git push`。

### 选择性批量发布

`shared-assets.publish.batch.preview` / `.commit` 接受一组 `assetId`，逐项校验并返回：
`eligible`、`warning`（超过 256 KiB）、`ineligible` 或 `skipped`。部分失败不会中断
其余项；提交只包含成功项的路径。预览后共享 checkout 前进会返回
`E_REVISION_CONFLICT`；写入或 commit 失败时恢复已写文件并 `git reset`。本地与共享
都相对基线修改且内容不同（`diverged`）时以 `E_CONFLICT_UNRESOLVED` 拒绝，必须先合并。

### diff、三方合并与冲突

- `shared-assets.diff` 返回“基线 → 本地”“基线 → 共享”“共享 → 本地”三组 unified diff。
- `shared-assets.merge.preview` 以 `baselines.json` 的上次同步内容为 base 做逐行三方
  合并；不重叠改动自动合并，重叠块进入 `conflicts`。
- `shared-assets.merge.apply` 接收每个冲突块的选择（`local` / `remote` / `both` /
  `custom`），保存前重新计算并校验：所有冲突已解决、无冲突标记、路径/大小/Skill
  frontmatter 合法。保存后基线推进到共享版本，资产变为 `local-update`，可以发布。

### drift 与 ignore

drift 按文件比较上次基线、项目 `.agentstorm/` 或 Provider 投影副本、共享 checkout。
状态为 `synced`、`local-update`、`remote-update`、`diverged`、`remote-deleted`、
`unpublished-local`、`missing`。

- `drift.resolve` 的 `overwrite` 用共享内容覆盖本地并推进基线；`keep` 记录项目级
  ignore，不修改文件。
- `workspace.pull` 把共享 Prompt/Knowledge/Doc 同步到当前 Workspace；只更新基线未变
  的文件，本地改动保留。
- 共享规则保存在 checkout 的 `ignore-rules`，支持 `path:<glob>`、`kind:<kind>`、
  `asset:<assetId>` 和裸路径，通过 `ignore.rules.set` 编辑并提交。
- 单条 drift 忽略保存在 Workspace 根 `shared-library-ignores.json`，解绑后保留。

### `.agentstorm/` 一次性迁移

`shared-assets.migrate` 默认 dry-run：导入 `.agentstorm/AGENTS.md`、
`knowledge/*.md`、`docs/<name>/**`；跳过 `workflows/`；Provider 项目级 Skill 只列为
“可发布候选”。目标内容不同记为冲突、不覆盖；源目录只读，执行后源文件仍在。报告包含
每个文件的 `import/skip/conflict`、冲突 diff、迁移前后文件数/字节数与 digest；
`sourceDigest` 未变化时直接复用上次记录。

### Provider 矩阵

`providers.list` 返回 7 个 Paseo Provider 的本机安装状态、Skill 目录、指令入口和验证
状态。当前只有 Codex 的 Skill 加载经过实测；Claude、Pi 目录约定成立但 Paseo 内加载
未验证；Copilot/OpenCode/Antigravity/Muse 标注“未验证”。OpenCode 的指令入口与 Codex
相同，暂不单独投影指令。

### 同步模式

- `manual`（默认）：只由用户触发，不改变已绑定仓库内容。
- `auto`：插件启动后按 `SHARED_ASSETS_AUTO_SYNC_MS`（默认 60 秒，最小 5 秒）执行
  `fetch` + `ff-only`。本地 checkout 有未提交改动时跳过；分叉时记录
  `E_REVISION_CONFLICT`，不做 merge/rebase。auto 不会自动写项目投影，项目副本仍通过
  sync 后的 `workspace.pull` 更新。

## RPC

`shared-assets.projects.list`、`.configure`、`.status`、`.sync`、`.unbind`、
`.assets.list`、`.assets.read`、`.skills.list`、`.skills.set-enabled`、
`.instructions.status`、`.instructions.set-enabled`、`.publish.preview`、`.publish.commit`。

I3 新增：`.providers.list`、`.drift.list`、`.diff`、`.merge.preview`、`.merge.apply`、
`.publish.batch.preview`、`.publish.batch.commit`、`.ignore.rules.get`、
`.ignore.rules.set`、`.drift.ignore`、`.drift.unignore`、`.drift.resolve`、
`.workspace.pull`、`.migrate`。

所有返回都是 `{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`。

## 开发与验证

```bash
npm run check:core
npm run typecheck
npm run lint
npm test
npm run format:check
```

CI 复用同一组命令：

```bash
npm ci
npm run verify        # check:core + typecheck + lint + test
npm run format:check
```

`npm run verify` 覆盖 `packages/core`、`board-cli`、`shared-assets`、
`task-board` 四个 workspace。CI 不需要 Paseo daemon；端到端与发布回归另跑。

### 发布回归（干净 home）

固定使用 `~/.paseo-plugin-test` 与 `127.0.0.1:6769`，不会读写 `~/.paseo-dev`。
脚本结束会停止该 daemon；用户项目文件和 `plugin-data` 保留。

```bash
# 安装 → smoke → daemon 重启 → 校验 → 卸载 → 文件保留 → 版本约束
PASEO_RELEASE_HOME=~/.paseo-plugin-test scripts/release-regression.sh

# 单独验证版本约束（期望安装被拒并提示 requirements.paseo）
PASEO_RELEASE_HOME=~/.paseo-plugin-test scripts/check-version-constraint.sh

# 构建 CLI → 安装到临时 prefix → list/status/logs/create/assign/start/stop/done
PASEO_RELEASE_HOME=~/.paseo-plugin-test scripts/release-cli.sh

# 规划卡片：systemPrompt 含 G0/G5，且规划 Agent 能调用 board_get
PASEO_RELEASE_HOME=~/.paseo-plugin-test npm run e2e:planning-smoke
```

升级回归需要两个已提交的 revision：

```bash
scripts/release-regression.sh                 # 先安装 revision A 并写入种子数据
scripts/release-upgrade.sh <revision-B>       # 升级到 revision B 并再次校验
```

证据默认写到 `.e2e/evidence/`，可用 `PASEO_RELEASE_EVIDENCE` 改目录。

### 看板调度器的已知限制

Paseo 0.16 的 `PluginServerContext` 不暴露 `PaseoApi`，插件没有 server 启动回调，
因此调度器只能在第一次 RPC 或 hook 到达时布防。daemon 重启后：

- 在该客户端连接之前，定时任务不会触发；
- 首次访问会按持久化的 `nextRunAt` 补跑一次到期任务，不按错过次数重复补跑；
- 运维上应在重启后打开一次看板，或调用 `task-board.health` 完成布防。

```bash
# 重启后主动布防（也可以直接打开看板的 Screen）
PASEO_RELEASE_HOME=~/.paseo-plugin-test node scripts/task-board-health.mjs
```

端到端（需要 Paseo dev daemon，默认 `~/.paseo-dev` / `6767`）：

```bash
node scripts/e2e-setup.mjs
paseo project create "$PWD/.e2e/demo-project" --home ~/.paseo-dev --json
paseo workspace create --project <projectId> --path "$PWD/.e2e/demo-project" \
  --isolation local --title "Demo Workspace" --home ~/.paseo-dev --json
E2E_PROJECT_ID=<projectId> E2E_WORKSPACE_ID=<workspaceId> node scripts/e2e-rpc.mjs
node scripts/e2e-i3.mjs
```

I1 的实测记录与截图在 AgentStorm 仓库：
`docs/plugins/evidence/implementation/I1/`。

## Task Board

任务看板的安装前置条件（`daemon.mcp.injectIntoAgents: true`）、RPC、hooks、
`board_declare` 契约和数据目录见
[`plugins/task-board/README.md`](plugins/task-board/README.md)。

I2 的实测记录、截图与落盘快照在 AgentStorm 仓库：
`docs/plugins/evidence/implementation/I2/`。复跑：

```bash
E2E_PROJECT_ID=<prj_id> E2E_WORKSPACE_ID=<wks_id> npm run e2e:task-board
```

I3 的实测记录、截图与 RPC 证据在 AgentStorm 仓库
`docs/plugins/evidence/implementation/I3/`。

I4 的补齐（permission hooks、定时/周期、WeCom、层级、迁移、UI）记录在：
`docs/plugins/evidence/implementation/I4/`。复跑：

```bash
npm run e2e:i4             # dev daemon：定时重启、recurring、permission、WeCom、层级
npm run e2e:i4-migrate     # 独立 home（6769）：迁移只读与 UI 种子数据
```

### 看板 CLI（外部 Agent）

`paseo-board` 让普通 shell 和外部 Agent 直接管理看板，不需要 MCP，调用方也
不需要安装插件：

```bash
npm install
npm run build:cli
npm install -g ./packages/board-cli

export PASEO_BOARD_URL=http://127.0.0.1:6769
export PASEO_BOARD_PASSWORD="$(cat ~/.paseo-plugin-test/local-credential)"

paseo-board list --status in_review
paseo-board status TASK-42 --json
paseo-board logs TASK-42 --tail 30 --filter tools
paseo-board send TASK-42 "补充测试" --wait 90
paseo-board create "拆解发布任务" --kind task-planning --json
```

`--json` 可直接 `JSON.parse`；退出码 0 成功、1 业务错误、2 参数错误、
3 连接/鉴权错误。`--home` 只读取 `daemon.listen`，密码仍需
`PASEO_BOARD_PASSWORD` 或 `--password`。完整命令、Claude Code
`Bash(paseo-board:*)` 示例和 Agent 工具对照见
[`packages/board-cli/README.md`](packages/board-cli/README.md)。

外部 Claude Code 只需再加一条 Bash allowlist，不需要 MCP 或插件：

```json
{
  "permissions": {
    "allow": ["Bash(paseo-board:*)"]
  }
}
```

```bash
export PASEO_BOARD_URL=http://127.0.0.1:6769
export PASEO_BOARD_PASSWORD="$(cat ~/.paseo-plugin-test/local-credential)"
claude
# 在会话中让 Agent 执行：
# paseo-board list --json
# paseo-board status TASK-42 --json
```

独立 home 的端到端验证：

```bash
E2E_PASEO_HOME=~/.paseo-plugin-test E2E_PASEO_PORT=6769 npm run e2e:board-cli
```

## 仍不包含

Workspace Panel、跨 host 总览、自动 push、二进制批量发布、Skill 目录级三方合并
（Skill 冲突按文件逐个解决）。
