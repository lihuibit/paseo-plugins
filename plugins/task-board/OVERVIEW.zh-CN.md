# 任务看板

任务看板把 Agent 的工作组织成卡片。每张卡片包含标题、说明、验收标准、优先级和标签，并在
`todo`、`in_progress`、`in_review`、`blocked`、`done`、`canceled` 之间流转。卡片可以分配给已有
Agent，也可以新建 Agent 执行，并支持父子任务表达多步骤工作。

## 工作方式

插件运行在 Paseo 内，状态保存在 `$PASEO_HOME/plugin-data/paseo-task-board/`。分配 Agent 后，
插件把看板提示词和 `board_declare` 工具加入宿主提供给该 Agent 的工具列表，并监听 Agent 的
生命周期事件来更新卡片。进度、评审和阻塞声明会更新卡片及其活动记录。定时卡片在 daemon
运行期间被调度。

停止运行会通过 `daemon.listen` 和 Paseo home 中的本地凭据，向本机 daemon 发送取消请求。
插件不直接访问 Agent Provider；提示词和工具结果经由 Paseo 到达 Provider。

## 配置

- Paseo 0.15.4 至 0.16.x，并启用 plugins。
- 如需 Agent 主动通过注入的 `board_declare` 工具汇报，需要开启
  `daemon.mcp.injectIntoAgents`。未开启时看板仍可使用，但状态只能由生命周期 hooks 推断，
  界面会显示提示。
- 可选配置企业微信群机器人 webhook URL 和时区，用于通知。
- 不需要安装额外的运行时或依赖。

设置项位于看板设置界面。插件本身不需要账号或 API key。

## 能力与限制

- 创建、编辑、分配、启动、停止、归档和删除卡片；查看卡片活动与 Agent 日志；管理父子任务。
- 支持一次性和周期性调度，以及可选的企微状态通知。
- 在插件数据目录保存看板数据、Agent 绑定、设置、事件和通知尝试记录。Agent 提示词、工具结果
  和错误信息可能包含在这些数据中。
- 配置企微 webhook 后，卡片标题和摘要会发送到该地址；其他数据不会离开本机。
- 取消功能要求 daemon 使用 TCP 监听；daemon 使用本地 socket 时会返回错误。通知是单向的，
  调度只在 daemon 运行期间推进。
- 插件是受信任、无沙箱的宿主插件，可以通过 Paseo 启动、停止和向 Agent 发消息，并可读写插件
  数据目录及被分配的工作区。
- Agent 执行、模型访问和权限确认由 Paseo 与所选 Provider 负责。插件不支持 Pipeline。
