import type {
  BoardEvent,
  BoardTask,
  LogsResult,
  Profile,
  ProviderOptions,
  StatusResult,
  TaskSummary,
} from "./types.js";

export interface RenderContext {
  write: (text: string) => void;
  color: boolean;
  columns: number;
}

const ANSI: Record<string, [string, string]> = {
  green: ["\u001b[32m", "\u001b[0m"],
  red: ["\u001b[31m", "\u001b[0m"],
  yellow: ["\u001b[33m", "\u001b[0m"],
  cyan: ["\u001b[36m", "\u001b[0m"],
  gray: ["\u001b[90m", "\u001b[0m"],
  bold: ["\u001b[1m", "\u001b[0m"],
};

export function style(
  ctx: RenderContext,
  name: keyof typeof ANSI,
  text: string,
): string {
  if (!ctx.color) return text;
  const codes = ANSI[name];
  return codes ? `${codes[0]}${text}${codes[1]}` : text;
}

export function statusText(ctx: RenderContext, status: string): string {
  if (status === "done") return style(ctx, "green", status);
  if (status === "blocked" || status === "cancelled") {
    return style(ctx, "red", status);
  }
  if (status === "in_review") return style(ctx, "yellow", status);
  if (status === "in_progress") return style(ctx, "cyan", status);
  return status;
}

export function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

export function table(
  headers: string[],
  rows: string[][],
  limits: number[] = [],
): string {
  const widths = headers.map((header, index) =>
    Math.min(
      Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
      limits[index] ?? 80,
    ),
  );
  const line = (row: string[]) =>
    row
      .map((cell, index) => {
        const width = widths[index] ?? 0;
        const value =
          cell.length > width
            ? `${cell.slice(0, Math.max(0, width - 3))}...`
            : cell;
        return value.padEnd(width);
      })
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

function shortTime(value: string): string {
  return value.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function shortJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? "" : truncate(text, 400);
  } catch {
    return String(value);
  }
}

export function printTaskList(ctx: RenderContext, tasks: TaskSummary[]): void {
  if (tasks.length === 0) {
    ctx.write("No tasks.\n");
    return;
  }
  const titleWidth = Math.max(20, Math.min(60, ctx.columns - 70));
  const displayIds = new Map(tasks.map((task) => [task.id, task.displayId]));
  const rows = tasks.map((task) => [
    task.displayId,
    task.status,
    task.priority,
    task.execution ? task.execution.agentId.slice(0, 8) : "-",
    task.hierarchyParentId
      ? (displayIds.get(task.hierarchyParentId) ??
        shortParent(task.hierarchyParentId))
      : "-",
    shortTime(task.updatedAt),
    truncate(task.title, titleWidth),
  ]);
  ctx.write(
    `${table(
      ["ID", "STATUS", "PRIORITY", "AGENT", "PARENT", "UPDATED", "TITLE"],
      rows,
      [12, 12, 10, 18, 12, 20, titleWidth],
    )}\n`,
  );
}

function shortParent(parentId: string): string {
  return parentId.slice(0, 10);
}

export function printTask(ctx: RenderContext, task: BoardTask): void {
  ctx.write(
    `${style(ctx, "bold", `${task.displayId}  ${task.title}`)}\n` +
      `status:    ${statusText(ctx, task.status)}\n` +
      `id:        ${task.id}\n` +
      `kind:      ${task.kind}\n` +
      `priority:  ${task.priority}\n` +
      `labels:    ${task.labels.join(", ") || "-"}\n` +
      `parent:    ${task.hierarchyParentId ?? "-"}\n` +
      `revision:  ${task.revision}\n` +
      `updated:   ${shortTime(task.updatedAt)}\n`,
  );
  if (task.projectId) ctx.write(`project:   ${task.projectId}\n`);
  if (task.status === "blocked" && task.blockReason) {
    ctx.write(`blocked:   ${task.blockReason} ${task.blockDetail ?? ""}\n`);
  }
  if (task.declaration) {
    ctx.write(
      `declared:  ${task.declaration.kind}${
        task.declaration.summary ? ` - ${task.declaration.summary}` : ""
      }\n`,
    );
  }
  if (task.progress) {
    ctx.write(
      `progress:  ${task.progress.summary}${
        task.progress.stage ? ` (${task.progress.stage})` : ""
      }\n`,
    );
  }
  if (task.execution) {
    ctx.write(
      `agent:     ${task.execution.agentId} ${task.execution.provider}/${
        task.execution.model ?? "-"
      } lifecycle=${task.execution.lastLifecycle ?? "-"}\n`,
    );
    ctx.write(
      `workspace: ${task.execution.workspace.workspaceName} (${task.execution.workspace.workspaceId})\n`,
    );
  } else {
    ctx.write("agent:     -\n");
  }
  if (task.assignment) {
    const agent = task.assignment.agent;
    ctx.write(
      `assigned:  ${agent.kind === "existing" ? agent.agentId : `${agent.provider ?? "-"}/${agent.model ?? "-"}`}\n`,
    );
  }
  if (task.description) {
    ctx.write(`\ndescription:\n${task.description}\n`);
  }
  if (task.acceptanceCriteria?.length) {
    ctx.write("\nacceptance:\n");
    for (const item of task.acceptanceCriteria) ctx.write(`- ${item}\n`);
  }
  if (task.activity?.length) {
    ctx.write("\nactivity:\n");
    for (const entry of task.activity.slice(-10)) {
      ctx.write(
        `  ${shortTime(entry.at)} ${entry.kind}${
          entry.detail ? ` ${shortJson(entry.detail)}` : ""
        }\n`,
      );
    }
  }
}

export function printStatus(ctx: RenderContext, result: StatusResult): void {
  const { task, agent, recentActivity } = result;
  ctx.write(
    `${style(ctx, "bold", `${task.displayId}  ${task.title}`)}\n` +
      `status:    ${statusText(ctx, task.status)}\n` +
      `kind:      ${task.kind}\n` +
      `priority:  ${task.priority}\n` +
      `revision:  ${task.revision}\n` +
      `updated:   ${shortTime(task.updatedAt)}\n`,
  );
  if (task.status === "blocked" && task.blockReason) {
    ctx.write(`blocked:   ${task.blockReason} ${task.blockDetail ?? ""}\n`);
  }
  if (task.declaration) {
    ctx.write(`declared:  ${task.declaration.kind}\n`);
  }
  if (task.execution) {
    ctx.write(
      `execution: ${task.execution.agentId} ${task.execution.provider}/${
        task.execution.model ?? "-"
      }\n`,
    );
  } else {
    ctx.write("execution: -\n");
  }
  if (agent) {
    ctx.write(
      `agent:     lifecycle=${agent.lifecycle} mode=${agent.modeId ?? "-"} archived=${
        agent.archivedAt ?? "-"
      }\n`,
    );
    ctx.write(
      `turn:      ${
        agent.activeTurn
          ? `${agent.activeTurn.turnId} since ${agent.activeTurn.startedAt ?? "-"}`
          : "-"
      }\n`,
    );
    ctx.write(`lastError: ${agent.lastError ?? "-"}\n`);
    ctx.write(`lastUsage: ${shortJson(agent.lastUsage) || "-"}\n`);
    if (agent.pendingPermissions.length === 0) {
      ctx.write("permissions: none\n");
    } else {
      ctx.write(`permissions: ${agent.pendingPermissions.length}\n`);
      for (const permission of agent.pendingPermissions) {
        ctx.write(
          `  - ${permission.requestId} ${permission.kind} ${permission.title}\n`,
        );
      }
    }
  } else {
    ctx.write("agent:     unassigned\n");
  }
  ctx.write(`activity:  ${recentActivity.length} recent\n`);
  for (const entry of recentActivity) ctx.write(`  ${entry}\n`);
}

export function printLogs(
  ctx: RenderContext,
  displayId: string,
  result: LogsResult,
): void {
  if (result.entries.length === 0) {
    ctx.write(`${displayId}: no ${result.filter} log entries.\n`);
    return;
  }
  ctx.write(
    `${displayId} ${result.filter} entries (${result.entries.length}${
      result.hasOlder ? ", older available" : ""
    }):\n`,
  );
  for (const entry of result.entries) {
    const time = shortTime(entry.at);
    let detail = "";
    if (entry.kind === "tool") {
      detail = `${entry.name ?? "tool"} ${entry.status ?? ""}`.trim();
      if (entry.error) detail += ` error=${entry.error}`;
    } else if (entry.kind === "permission") {
      detail = `${entry.status ?? ""} ${entry.requestId ?? ""} ${
        entry.text ?? ""
      }`.trim();
    } else {
      detail = entry.error ?? entry.text ?? "";
    }
    ctx.write(`  ${time} ${entry.kind.padEnd(10)} ${detail}\n`);
  }
  if (result.error) ctx.write(`  timeline error: ${result.error}\n`);
}

export function printEvents(ctx: RenderContext, events: BoardEvent[]): void {
  if (events.length === 0) {
    ctx.write("No events.\n");
    return;
  }
  for (const event of events) {
    ctx.write(
      `${shortTime(event.at)} ${event.kind}${
        event.taskId ? ` ${event.taskId}` : ""
      }${event.detail ? ` ${shortJson(event.detail)}` : ""}\n`,
    );
  }
}

export function printProfiles(ctx: RenderContext, profiles: Profile[]): void {
  if (profiles.length === 0) {
    ctx.write("No agent profiles.\n");
    return;
  }
  ctx.write(
    `${table(
      ["ID", "NAME", "PROVIDER", "MODEL", "MODE", "THINKING"],
      profiles.map((profile) => [
        profile.id,
        profile.name,
        profile.provider,
        profile.model ?? "-",
        profile.modeId ?? "-",
        profile.thinkingOptionId ?? "-",
      ]),
      [32, 24, 12, 32, 16, 12],
    )}\n`,
  );
}

export function printProviderCatalog(
  ctx: RenderContext,
  providers: Array<{ provider: string; available: boolean }>,
  catalog?: ProviderOptions,
): void {
  if (!catalog) {
    ctx.write(
      `${table(
        ["PROVIDER", "AVAILABLE"],
        providers.map((entry) => [
          entry.provider,
          entry.available ? "yes" : "no",
        ]),
      )}\n`,
    );
    return;
  }
  ctx.write(
    `${style(ctx, "bold", catalog.provider)} cwd=${catalog.cwd ?? "-"}\n`,
  );
  if (catalog.error) ctx.write(`error: ${catalog.error}\n`);
  if (catalog.models.length > 0) {
    ctx.write("\nmodels:\n");
    ctx.write(
      `${table(
        ["ID", "LABEL", "DEFAULT", "THINKING"],
        catalog.models.map((model) => [
          model.id,
          model.label,
          model.isDefault ? "yes" : "",
          model.thinkingOptions
            .map((option) => `${option.id}${option.isDefault ? "*" : ""}`)
            .join(","),
        ]),
        [36, 28, 10, 32],
      )}\n`,
    );
  }
  if (catalog.modes.length > 0) {
    ctx.write("\nmodes:\n");
    ctx.write(
      `${table(
        ["ID", "LABEL"],
        catalog.modes.map((mode) => [mode.id, mode.label]),
        [24, 32],
      )}\n`,
    );
  }
}

export function printResult(
  ctx: RenderContext,
  verb: string,
  task: TaskSummary | BoardTask,
): void {
  ctx.write(
    `${verb} ${style(ctx, "bold", task.displayId)} ${statusText(ctx, task.status)}  ${task.title}\n`,
  );
}
