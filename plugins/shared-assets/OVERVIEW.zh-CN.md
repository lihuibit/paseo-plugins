# 共享资产

共享资产把 Paseo 项目与团队 Git 仓库连接起来，在项目范围内同步 Skills、`AGENTS.md` Prompt、
经验库和文档。插件展示所有已注册项目、绑定状态，以及各资产的已同步、已修改、未发布和冲突
情况。

## 工作方式

绑定的仓库包含 `team-assets.json`，以及 `skills/project/<name>/`、`knowledge/`、`docs/`、
`AGENTS.md` 中的一项或多项。插件把仓库克隆到自己的插件数据目录并扫描这些目录。已发布或
已关联的 Skill 只有一个实体，位于 `.paseo/skills/<name>`；`.codex/skills/<name>`、
`.claude/skills/<name>`、`.pi/skills/<name>` 等 Provider 目录是指向该实体的相对软链。
本地新建、尚未发布的 Skill 留在创建它的 Provider 目录。平台无法创建软链时，插件回退为
复制，并把该投影标记为复制。修改 `.paseo/skills/<name>` 会同时影响所有已投影的 Provider。

每个资产保留一份基线，因此详情页可以判断共享副本和本地副本各自是否发生了变化。

项目详情按 Skills、Prompt、经验库、文档以及 Provider 分组。可以添加共享资产、关联已有本地
副本、双向同步、比较与合并、发布选中的本地资产，或解除关联。共享资产也可以从共享仓库删除，
删除会创建本地提交，并可选保留本地副本为未发布或一并删除本地文件。较大仓库可以使用批量操作
和忽略规则。发布本地 Skill 时，插件会把它移动到 `.paseo/skills/<name>` 并链接其 Provider。
发布和删除都会创建本地提交并提示推送方式，不会自动推送。

## 配置

- Paseo 0.15.4 或更高（不设上限），并启用 plugins。
- daemon 所在主机有 Git，并能访问配置的仓库。
- 有一个已注册且至少包含一个工作区的 Paseo 项目。
- 团队仓库包含有效的 `team-assets.json`；绑定项目时需要明确确认信任该仓库。
- 不需要安装额外的运行时或依赖。

## 能力与限制

- 读写插件数据目录中的仓库 checkout；扫描本地资产或投影 Skills 时读取项目工作区。
- 在 `.paseo/skills/` 中维护每个共享 Skill 的唯一实体，并在 `.codex/skills/`、
  `.claude/skills/`、`.pi/skills/` 等 Provider 目录创建相对软链。平台不支持软链时改为复制，
  并把该投影标记为复制。不是由插件创建的文件不会被改动。
- 扫描、diff、发布预览和提交都会排除 `.env`、`.npmrc`、私钥和证书等凭据文件。
- 网络访问仅限配置的 Git 远端；不发送遥测数据。
- 发布产生的提交保留在本地，直到有人推送仓库；插件不会强制推送。合并冲突需要在插件内或
  在 checkout 中手动解决。
- 共享资产仅支持项目范围。不支持全局 Skills。
- Provider 支持覆盖目录约定。Codex、CodeBuddy（`.codebuddy/skills`）和 DeepSeek Harness
  （`deepseek-harness-native`，`.dsh/skills`）的加载已验证，包含软链。CodeBuddy 使用
  `.codebuddy/CODEBUDDY.md` 作为指令入口；DeepSeek Harness 读取项目根 `AGENTS.md`，复用
  Codex 入口，不单独投影指令。Claude、Pi、Copilot、OpenCode、Antigravity 和 Muse 仍为
  未验证或仅遵循目录约定。
