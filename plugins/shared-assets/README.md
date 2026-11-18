# Shared Assets (Paseo plugin)

版本：`0.7.0`。plugin id 为 `paseo-shared-assets`；项目内本地目录统一使用
`.paseo/`。

团队 Git 仓库中的 Skill、`AGENTS.md`、Knowledge 和 Doc 的项目级投影。
已发布或已关联的 Skill 只有一个实体，位于 `.paseo/skills/<name>`；Provider 目录是指向
该实体的相对软链。本地新建、尚未发布的 Skill 留在创建它的 Provider 目录。
共享库只支持 `skills/project/<name>/`；`skills/global/` 已废弃，即使目录存在也不会
被扫描或管理。

## 安装

```bash
paseo plugin install /absolute/path/to/paseo-plugins/plugins/shared-assets --home ~/.paseo-dev
```

要求 Paseo `>=0.15.4 <0.17.0`、Git，并且宿主 `pluginsEnabled: true`。

## 使用

1. Sidebar 点击「共享资产」。
2. 项目列表显示每个项目的工作区、绑定状态、attention 明细和忽略项；点「配置 / 管理」进入详情。
3. 详情顶部显示项目路径、作用域工作区与忽略规则；未绑定时填写 Git URL、分支和同步模式。
4. 绑定后可同步、重新绑定、解绑；解绑不会删除项目内的受管副本或本地修改。
5. Skills / SYSTEM Prompt / 经验库 / 项目文档按资产类型与 Provider 分组：
   - 共享资产可「添加到本地」；共享 Skill 的实体会写入 `.paseo/skills/<name>`，Provider
     目录创建指向实体的相对软链；软链不可用时回退复制并标注。
   - 本地新建、尚未发布的 Skill 留在原 Provider 目录；同名本地资产显示为候选，可选择「保留本地」或
     「使用共享版本」建立关联（adopt）。
   - 已关联资产按 `synced / remote-update / local-update / diverged / remote-deleted`
     展示，并支持同步到本地、选择发布、三方合并、放弃本地修改。
   - 只有本地、尚未进入共享库的资产显示为 `unpublished-local`，卡片会提示
     「本地有未发布内容」，可「选择发布」「放弃本地修改」或「移除关联」。
   - 「移除关联」可选择是否同时删除本地 Provider 投影；有未保存修改时先给出警告。
   - 「删除共享资产」会从共享仓库移除资产并创建本地 commit（不自动 push），可选择保留
     本地副本转为未发布，或一并删除本地文件。
   - 批量模式支持批量关联、批量同步、批量发布和批量解除关联。
6. 每个资产 tab 底部固定发布栏显示「已选择 N 项本地 <资产类型>」，可全选可发布项并
   预览发布。本地私有资产同样可勾选，预览会显示「将创建新的共享资产」；预览过期
   （`E_REVISION_CONFLICT`）时会自动同步并重新生成预览，不会直接提交。
7. 「Drift」查看三方 diff、解决冲突、覆盖或保留本地；「设置」编辑全局 ignore 规则、
   查看/恢复项目级已忽略项、预览/执行 `.paseo/` 迁移、查看 Provider 矩阵。

发布不会自动 push，提交后用 `git push` 推送。

`.env`、`.env.*`、`.npmrc`、`.pypirc`、`id_rsa`、`*.pem`、`*.key` 等凭据文件
不会出现在扫描、投影、drift、发布预览或提交中，显式指定这些路径发布会被拒绝。

## 数据

`$PASEO_HOME/plugin-data/paseo-shared-assets/`：

- `config.json`：绑定与投影记录
- `repos/<projectId>/`：共享仓库 checkout
- `logs/rpc.log`：RPC 错误

卸载插件不会删除项目内 `.paseo/`、`.codex/skills/`、`.claude/skills/` 等文件。
旧版本留下的 `skill:global/*` 投影文件会保留，但不再被读取、同步或删除；需要时请手动清理。

## 已知限制

Codex（S4）、CodeBuddy（`.codebuddy/skills`）和 DeepSeek Harness
（`deepseek-harness-native`，`.dsh/skills`）的 Skill 加载经过实测，均支持软链；
CodeBuddy 的指令入口为 `.codebuddy/CODEBUDDY.md`，DeepSeek Harness 读取项目根
`AGENTS.md`、复用 Codex 入口，不单独投影指令。Claude、Pi 只验证了目录约定，Copilot、
OpenCode、Antigravity、Muse 标注“未验证”。Provider 只要有已知的项目级 Skill 目录就会
出现在 tabs 中，未验证项会明确标注。共享 `skills/global/` 不再支持；迁移时只导入受支持
的资产类型。平台不支持软链时，Provider 目录使用复制，界面会标注为复制。
