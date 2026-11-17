import type { PaseoAgent, PaseoApi } from "./paseo-types";
import { BoardError } from "../shared/core/board/errors";
import type { BoardActivity, BoardTask } from "../shared/core/board/types";

const MAX_TEXT = 500;

export type LogFilter = "all" | "text" | "tools" | "errors" | "permissions";

export interface AgentSummary {
  agentId: string;
  title: string | null;
  lifecycle: PaseoAgent["status"];
  provider: string;
  model: string | null;
  modeId: string | null;
  workspaceId: string | null;
  pendingPermissions: Array<{
    requestId: string;
    kind: string;
    title: string;
    description?: string;
  }>;
  activeTurn: { turnId: string; startedAt: string | null } | null;
  lastError: string | null;
  lastUsage: unknown;
  archivedAt: string | null;
  background: boolean;
}

export interface LogEntry {
  at: string;
  kind: "assistant" | "user" | "tool" | "error" | "permission";
  text?: string;
  name?: string;
  status?: string;
  error?: string;
  requestId?: string;
}

export function truncate(value: string, limit = MAX_TEXT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function formatError(error: unknown): string {
  if (typeof error === "string") return truncate(error);
  if (error === null || error === undefined) return "unknown error";
  try {
    return truncate(JSON.stringify(error));
  } catch {
    return truncate(String(error));
  }
}

export function summarizeAgent(agent: PaseoAgent): AgentSummary {
  return {
    agentId: agent.id,
    title: agent.title,
    lifecycle: agent.status,
    provider: agent.provider,
    model: agent.model,
    modeId: agent.currentModeId,
    workspaceId: agent.workspaceId ?? null,
    pendingPermissions: agent.pendingPermissions.map((request) => ({
      requestId: request.id,
      kind: request.kind,
      title: request.title ?? request.name,
      description: request.description,
    })),
    activeTurn: agent.activeTurn
      ? {
          turnId: agent.activeTurn.turnId,
          startedAt: agent.activeTurn.startedAt ?? null,
        }
      : null,
    lastError: agent.lastError ?? null,
    lastUsage: agent.lastUsage ?? null,
    archivedAt: agent.archivedAt ?? null,
    // Paseo 0.15.x snapshots do not carry the background flag.
    background:
      (agent as PaseoAgent & { background?: boolean }).background ?? false,
  };
}

export function summarizeTask(task: BoardTask, agent: AgentSummary | null) {
  return {
    id: task.id,
    displayId: task.displayId,
    title: task.title,
    kind: task.kind,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    projectId: task.projectId,
    hierarchyParentId: task.hierarchyParentId,
    parentTaskId: task.parentTaskId ?? null,
    revision: task.revision,
    updatedAt: task.updatedAt,
    blockReason: task.blockReason ?? null,
    blockDetail: task.blockDetail ?? null,
    progress: task.progress ?? null,
    declaration: task.declaration ?? null,
    execution: task.execution
      ? {
          agentId: task.execution.agentId,
          agentTitle: task.execution.agentTitle,
          provider: task.execution.provider,
          model: task.execution.model,
          lastLifecycle: task.execution.lastLifecycle ?? null,
          startedAt: task.execution.startedAt,
        }
      : null,
    agent,
  };
}

export function describeActivity(activity: BoardActivity): string {
  const detail = activity.detail ?? {};
  const parts: string[] = [];
  const keys = [
    "from",
    "to",
    "source",
    "summary",
    "stage",
    "status",
    "requestId",
    "behavior",
    "agentId",
    "reason",
  ];
  for (const key of keys) {
    const value = detail[key];
    if (typeof value === "string" && value.length > 0) {
      parts.push(`${key}=${value}`);
    }
  }
  return truncate(
    `${activity.at} ${activity.kind}${parts.length > 0 ? ` ${parts.join(" ")}` : ""}`,
    300,
  );
}

export async function listAgentSummaries(
  paseo: PaseoApi,
): Promise<Record<string, AgentSummary>> {
  const page = await paseo.agents.list({
    includeBackground: true,
    filter: { includeArchived: true, includeBackground: true },
    page: { limit: 200 },
  });
  const summaries: Record<string, AgentSummary> = {};
  for (const entry of page.entries) {
    summaries[entry.agent.id] = summarizeAgent(entry.agent);
  }
  return summaries;
}

export async function readAgentSummary(
  paseo: PaseoApi,
  agentId: string,
): Promise<AgentSummary | null> {
  const refreshed = await paseo.agents
    .ref(agentId)
    .refresh()
    .catch(() => null);
  return refreshed ? summarizeAgent(refreshed.agent) : null;
}

function permissionEntries(task: BoardTask): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const activity of task.activity) {
    if (activity.kind === "permission_requested") {
      entries.push({
        at: activity.at,
        kind: "permission",
        status: "requested",
        requestId:
          typeof activity.detail?.requestId === "string"
            ? activity.detail.requestId
            : undefined,
        text:
          typeof activity.detail?.title === "string"
            ? truncate(activity.detail.title)
            : undefined,
      });
    } else if (activity.kind === "permission_resolved") {
      entries.push({
        at: activity.at,
        kind: "permission",
        status:
          typeof activity.detail?.behavior === "string"
            ? activity.detail.behavior
            : "resolved",
        requestId:
          typeof activity.detail?.requestId === "string"
            ? activity.detail.requestId
            : undefined,
      });
    }
  }
  if (task.pendingPermission) {
    entries.push({
      at: task.pendingPermission.at,
      kind: "permission",
      status: "pending",
      requestId: task.pendingPermission.requestId,
      text: truncate(task.pendingPermission.title),
    });
  }
  return entries;
}

export async function readTaskLogs(
  paseo: PaseoApi,
  task: BoardTask,
  options: { limit: number; filter: LogFilter },
): Promise<{
  taskId: string;
  agentId: string;
  filter: LogFilter;
  entries: LogEntry[];
  hasOlder: boolean;
  error: string | null;
}> {
  const agentId = task.execution?.agentId;
  if (!agentId) {
    throw new BoardError(
      "E_NOT_ASSIGNED",
      "This task has no bound agent to read logs from",
      { taskId: task.id },
    );
  }
  const wantsTimeline =
    options.filter === "all" ||
    options.filter === "text" ||
    options.filter === "tools" ||
    options.filter === "errors";
  if (!wantsTimeline) {
    const entries = permissionEntries(task);
    const agent = await readAgentSummary(paseo, agentId);
    const seen = new Set(entries.map((entry) => entry.requestId));
    for (const permission of agent?.pendingPermissions ?? []) {
      if (seen.has(permission.requestId)) continue;
      entries.push({
        at: new Date().toISOString(),
        kind: "permission",
        status: "pending",
        requestId: permission.requestId,
        text: truncate(permission.title),
      });
    }
    return {
      taskId: task.id,
      agentId,
      filter: options.filter,
      entries: entries.slice(-options.limit),
      hasOlder: false,
      error: null,
    };
  }

  const page = await paseo.agents.ref(agentId).timeline.refetch({
    direction: "tail",
    limit: options.filter === "all" ? options.limit : 200,
  });
  const entries: LogEntry[] = [];
  for (const entry of page.entries) {
    const item = entry.item;
    const at = entry.timestamp;
    switch (item.type) {
      case "assistant_message":
        if (options.filter === "all" || options.filter === "text") {
          entries.push({
            at,
            kind: "assistant",
            text: truncate(item.text),
          });
        }
        break;
      case "user_message":
        if (options.filter === "all" || options.filter === "text") {
          entries.push({ at, kind: "user", text: truncate(item.text) });
        }
        break;
      case "tool_call": {
        const failed = item.status === "failed";
        if (options.filter === "errors" && !failed) {
          break;
        }
        if (
          options.filter === "all" ||
          options.filter === "tools" ||
          (options.filter === "errors" && failed)
        ) {
          entries.push({
            at,
            kind: "tool",
            name: item.name,
            status: item.status,
            error: failed ? formatError(item.error) : undefined,
          });
        }
        break;
      }
      case "error":
        if (options.filter === "all" || options.filter === "errors") {
          entries.push({
            at,
            kind: "error",
            error: truncate(item.message),
          });
        }
        break;
      case "notification":
        if (
          (options.filter === "all" || options.filter === "errors") &&
          item.level === "error"
        ) {
          entries.push({
            at,
            kind: "error",
            error: truncate(item.message),
          });
        }
        break;
      default:
        break;
    }
  }
  return {
    taskId: task.id,
    agentId,
    filter: options.filter,
    entries: entries.slice(-options.limit),
    hasOlder: page.hasOlder,
    error: page.error,
  };
}
