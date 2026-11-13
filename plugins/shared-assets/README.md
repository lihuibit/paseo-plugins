# Shared Assets (Paseo plugin)

团队 Git 仓库中的 Skill、`AGENTS.md`、Knowledge 和 Doc 的项目级投影。

## 安装

```bash
paseo plugin install /absolute/path/to/paseo-plugins/plugins/shared-assets --home ~/.paseo-dev
```

要求 Paseo `>=0.16.0 <0.17.0`、Git，并且宿主 `pluginsEnabled: true`。

## 使用

1. Sidebar 点击「共享资产」。
2. 选择 Project → 绑定仓库，填写 Git URL、分支和同步模式；勾选信任。
3. 概览页可同步、重新绑定、解绑。
4. Skills 页按 Provider 启用，写入对应项目级 Skill 目录；未验证 Provider 会标注。
5. SYSTEM Prompt 页把共享 `AGENTS.md` 投影到 `.agentstorm/AGENTS.md` 和 Provider 入口。
6. Knowledge / Docs 页可预览；文本资产可校验、预览 diff 并提交到共享仓库 checkout。
7. 「变更 / 发布」多选资产做批量校验与发布；「Drift」查看三方 diff、解决冲突、覆盖或保留本地。
8. 「设置」编辑 ignore 规则、预览/执行 `.agentstorm/` 迁移、查看 Provider 矩阵。

发布不会自动 push，提交后用 `git push` 推送。

## 数据

`$PASEO_HOME/plugin-data/agentstorm-shared-assets/`：

- `config.json`：绑定与投影记录
- `repos/<projectId>/`：共享仓库 checkout
- `logs/rpc.log`：RPC 错误

卸载插件不会删除项目内 `.agentstorm/`、`.codex/skills/`、`.claude/skills/` 等文件。

## 已知限制

Claude 只验证了目录约定，未做真实模型加载；Codex 目录已在 S4 验证。Provider 只投影
`codex` 与 `claude`。drift、ignore、diff/三方合并、批量发布、迁移属于 I3。
