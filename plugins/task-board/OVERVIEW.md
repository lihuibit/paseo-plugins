# Task Board

Task Board keeps agent work on a board of cards. A card holds a title, description,
acceptance criteria, priority and labels, and moves through `todo`, `in_progress`,
`in_review`, `blocked`, `done` and `canceled`. Cards can be assigned to an existing agent or
start a new one, and can have a parent card for multi-step work.

## How it works

The plugin runs inside Paseo and stores its state in
`$PASEO_HOME/plugin-data/paseo-task-board/`. When an agent is assigned, the plugin adds a board
prompt and the `board_declare` tool to that agent's host-provided tool list, and follows the
agent's lifecycle events to update the card. Progress, review and blocked declarations update the
card and its activity log. Scheduled cards are evaluated while the daemon is running.

Stopping a run forwards a cancel request to the local daemon, using `daemon.listen` and the local
credential from the Paseo home. The plugin does not contact agent providers directly; prompts and
tool results reach the provider through Paseo.

## Setup

- Paseo 0.15.4 through 0.16.x with plugins enabled.
- `daemon.mcp.injectIntoAgents` enabled if agents should declare progress through the injected
  `board_declare` tool. Without it, the board still works, but states are inferred from lifecycle
  hooks and the board shows a warning.
- Optional WeCom group webhook URL for notifications, with an optional timezone.
- No external runtime or package installation is needed.

Settings are available from the board's settings screen. The plugin does not require an account or
an API key of its own.

## Capabilities and limits

- Create, edit, assign, start, stop, archive and delete cards; view per-card activity and agent
  logs; manage parent and child cards.
- Run one-off or recurring schedules, and send optional WeCom notifications for status changes.
- Store board data, agent bindings, settings, events and notification attempts under the plugin
  data directory. Agent prompts, tool results and error messages can be part of that data.
- With a WeCom webhook configured, card titles and summaries are sent to that endpoint. Nothing
  else leaves the host.
- Cancellation requires a TCP daemon listener; it reports an error when the daemon uses a local
  socket. Notifications are one-way, and schedules only advance while the daemon runs.
- The plugin is a trusted, unsandboxed host plugin. It can start, stop and message agents through
  Paseo, and can read and write its plugin data directory and the assigned workspace.
- Agent execution, model access and permission prompts are handled by Paseo and the selected
  provider.
