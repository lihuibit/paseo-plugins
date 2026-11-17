import { randomBytes } from "node:crypto";
import type { PaseoAgent, PaseoAgentHandle, PaseoApi } from "./paseo-types";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import { BoardError } from "../shared/core/board/errors";
import {
  advanceRecurring,
  applyAgentMissing,
  applyAgentSilent,
  applyBlocked,
  attachExecution,
  assignBoardTask,
  applyDeclaration,
  applyPermissionAfter,
  applyPermissionBefore,
  applyProgress,
  applyTurnAfter,
  assertRevision,
  beginRun,
  boardCounts,
  cancelBoardTask,
  createBoardTask,
  deleteBoardTask,
  findTask,
  hierarchySummary,
  markStopRequested,
  markScheduleFired,
  setBoardStatus,
  setBoardTrigger,
  setHierarchyParent,
  syncTurnBefore,
  unassignBoardTask,
  updateBoardTask,
  type PermissionSnapshot,
  type TurnOutcome,
} from "../shared/core/board/state";
import {
  isTaskDue,
  nextCadenceRunAt,
  nextRunAtForTrigger,
} from "../shared/core/board/schedule";
import {
  type BoardAssignment,
  type BoardStatus,
  type BoardTask,
  type Trigger,
} from "../shared/core/board/types";
import {
  preferredTaskForAgent,
  taskIdFromAgent,
} from "../shared/core/board/agent-index";
import { BOARD_TASK_LABEL, isTerminalStatus } from "../shared/core/board/types";
import {
  createAgentForTask,
  executionForExistingAgent,
  resolveAssignmentTarget,
} from "./assigner";
import { buildInitialMessage } from "./system-prompt";
import { appendDeleted, appendEvent, type BoardStore } from "./store";
import { rebuildFromPaseo } from "./agent-index";
import type { AgentIndex } from "./agent-index";
import { readAgentSummary, type AgentSummary } from "./inspection";
import { ensureDataDir, pluginDataDir, paseoHome } from "./plugin-data";
import { BoardSettingsStore } from "./settings";
import { WeComNotifier, type NotificationEvent } from "./notifier";
import { cancelAgentViaDaemon } from "./agent-cancel";
import { buildQuestionAnswer } from "./questions";

export type AgentCanceller = (agentId: string) => Promise<void>;

const DEFAULT_FALLBACK_TIMEOUT_MS = 15_000;
const FALLBACK_POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CancellableAgentActions = PaseoApi["agents"] & {
  cancel?: (
    agentId: string,
    options?: { requestId?: string },
  ) => Promise<unknown>;
};

type CancellableAgentHandle = PaseoAgentHandle & {
  cancel?: (options?: { requestId?: string }) => Promise<unknown>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pendingPermissionDetails(agent: PaseoAgent): Array<{
  requestId: string;
  kind: string;
  title: string;
}> {
  return (agent.pendingPermissions ?? []).map((request) => ({
    requestId: request.id,
    kind: request.kind,
    title: request.title ?? request.name,
  }));
}

function cancellationWasRefused(error: unknown): boolean {
  return /cancellation was not acknowledged|did not acknowledge cancellation|Cannot stop agent/i.test(
    errorMessage(error),
  );
}

function cancelFailure(
  taskId: string,
  agentId: string,
  error: unknown,
  pending: Array<{ requestId: string; kind: string; title: string }>,
): BoardError {
  if (error instanceof BoardError) return error;
  if (cancellationWasRefused(error) || pending.length > 0) {
    return new BoardError(
      "E_AGENT_BLOCKED",
      `Cannot stop agent ${agentId}: it is waiting for an answer and the current turn could not be interrupted. Answer or dismiss the pending question in Paseo, then retry.`,
      { taskId, agentId, pendingPermissions: pending },
    );
  }
  return new BoardError(
    "E_CANCEL_FAILED",
    `Could not cancel the current turn of agent ${agentId}: ${errorMessage(error)}`,
    { taskId, agentId },
  );
}

/**
 * Interrupts the agent's active run.
 *
 * Paseo 0.16 exposes cancellation through `agent.cancelAgent` on the daemon
 * client but not through `PaseoApi`. Prefer a native cancel method when the
 * host grows one; otherwise the daemon client connection supplied by the
 * plugin process sends the same `cancel_agent_request`. Neither path reloads
 * the provider session, so a following `send` starts the next turn directly.
 */
export async function cancelAgentRun(
  paseo: PaseoApi,
  agentId: string,
  canceller: AgentCanceller,
): Promise<void> {
  const agents = paseo.agents as CancellableAgentActions;
  if (typeof agents.cancel === "function") {
    await agents.cancel(agentId);
    return;
  }
  const handle = paseo.agents.ref(agentId) as CancellableAgentHandle;
  if (typeof handle.cancel === "function") {
    await handle.cancel();
    return;
  }
  await canceller(agentId);
}

async function readStoppedAgent(
  paseo: PaseoApi,
  agentId: string,
): Promise<PaseoAgent> {
  const refreshed = await paseo.agents.ref(agentId).refresh();
  if (!refreshed || refreshed.agent.archivedAt) {
    throw new BoardError("E_AGENT_MISSING", "The bound agent is missing", {
      agentId,
    });
  }
  return refreshed.agent;
}

function assertAgentStopped(
  taskId: string,
  agentId: string,
  agent: PaseoAgent,
): void {
  const pending = pendingPermissionDetails(agent);
  if (agent.status === "running" || pending.length > 0) {
    throw new BoardError(
      "E_AGENT_BLOCKED",
      `Cannot stop agent ${agentId}: it is still running${
        pending.length > 0 ? " with a pending question" : ""
      }. Answer or dismiss the pending request in Paseo, then retry.`,
      {
        taskId,
        agentId,
        lifecycle: agent.status,
        pendingPermissions: pending,
      },
    );
  }
}

export interface ListInput {
  status?: BoardStatus;
  projectId?: string;
  label?: string;
  query?: string;
  includeFinished: boolean;
  hierarchyParentId?: string | null;
}

export type DeclareRequest =
  | { kind: "review"; summary?: string }
  | {
      kind: "blocked";
      summary?: string;
      blockReason?: "human_required" | "permission" | "question" | "manual";
      humanRequest?: {
        title: string;
        instructions: string;
        action?:
          | { kind: "open_url"; url: string }
          | { kind: "open_terminal"; command: string }
          | { kind: "manual" };
      };
    }
  | { kind: "waiting"; summary?: string }
  | { kind: "clear"; summary?: string }
  | { kind: "progress"; summary: string; stage?: string };

export interface PaseoAgentProfile {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  options?: Record<string, unknown>;
  notes?: string;
  icon?: string;
  color?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class TaskBoardService {
  private locks = new Map<string, Promise<unknown>>();
  private ready: Promise<void> | null = null;
  private readonly archivingAgents = new Set<string>();
  private readonly settings: BoardSettingsStore;
  private readonly notifier: WeComNotifier;

  constructor(
    private readonly store: BoardStore,
    private readonly index: AgentIndex,
    settings?: BoardSettingsStore,
    notifier?: WeComNotifier,
    private readonly cancelAgent: AgentCanceller = cancelAgentViaDaemon,
    private readonly fallbackTimeoutMs = DEFAULT_FALLBACK_TIMEOUT_MS,
  ) {
    this.settings = settings ?? new BoardSettingsStore();
    this.notifier = notifier ?? new WeComNotifier(this.settings);
  }

  initialize(paseo: PaseoApi): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await ensureDataDir();
        await this.store.load();
        await this.index.load();
        await this.settings.load();
        try {
          const document = await this.store.read();
          const rebuilt = await rebuildFromPaseo(paseo, document.tasks);
          for (const task of document.tasks) {
            if (
              task.execution &&
              !task.execution.agentId.startsWith("legacy:") &&
              !rebuilt[task.execution.agentId]
            ) {
              const refreshed = await paseo.agents
                .ref(task.execution.agentId)
                .refresh()
                .catch(() => null);
              if (refreshed && !refreshed.agent.archivedAt) {
                rebuilt[task.execution.agentId] = task.id;
              }
            }
          }
          await this.index.replace(rebuilt);
          console.log(
            `[paseo-task-board] restored ${document.tasks.length} tasks and ${Object.keys(rebuilt).length} agent bindings`,
          );
        } catch (error) {
          console.error(
            "[paseo-task-board] agent index rebuild failed; using persisted index",
            error,
          );
        }
      })();
    }
    return this.ready;
  }

  private async withTaskLock<T>(
    taskId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(taskId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.locks.set(
      taskId,
      next.catch(() => undefined),
    );
    try {
      return await next;
    } finally {
      if (this.locks.get(taskId) === next) this.locks.delete(taskId);
    }
  }

  /**
   * Archive the agent bound to a finished card.
   *
   * Archiving is best effort: a missing or already-archived agent is success,
   * and any host error is logged without changing the card state. The agent
   * index is always unbound so a restart cannot resurrect the binding.
   */
  private async archiveAgent(
    paseo: PaseoApi,
    agentId: string,
    reason: string,
  ): Promise<void> {
    if (this.archivingAgents.has(agentId)) return;
    this.archivingAgents.add(agentId);
    try {
      const handle = paseo.agents.ref(agentId);
      await handle.reload().catch(() => undefined);
      if (handle.archivedAt) {
        console.log(
          `[paseo-task-board] agent ${agentId} already archived (${reason})`,
        );
        return;
      }
      await handle.archive();
      console.log(`[paseo-task-board] archived agent ${agentId} (${reason})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found|missing|archived/i.test(message)) {
        console.log(
          `[paseo-task-board] agent ${agentId} is gone; archive treated as success (${reason})`,
        );
      } else {
        console.error(
          `[paseo-task-board] could not archive ${agentId} (${reason})`,
          error,
        );
      }
    } finally {
      this.archivingAgents.delete(agentId);
      await this.index.unbind(agentId).catch((error: unknown) => {
        console.error(
          `[paseo-task-board] could not unbind ${agentId} from agentIndex`,
          error,
        );
      });
    }
  }

  async list(input: ListInput): Promise<{
    tasks: BoardTask[];
    counts: Record<string, number>;
  }> {
    const document = await this.store.read();
    const query = input.query?.trim().toLowerCase();
    const tasks = document.tasks.filter((task) => {
      if (
        !input.includeFinished &&
        (task.status === "done" || task.status === "cancelled")
      ) {
        return false;
      }
      if (input.status && task.status !== input.status) return false;
      if (input.projectId && task.projectId !== input.projectId) return false;
      if (input.label && !task.labels.includes(input.label)) return false;
      if (
        input.hierarchyParentId !== undefined &&
        task.hierarchyParentId !== input.hierarchyParentId
      ) {
        return false;
      }
      if (query) {
        const haystack =
          `${task.displayId} ${task.title} ${task.description ?? ""}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
    return { tasks, counts: boardCounts(document.tasks) };
  }

  async get(taskId: string): Promise<BoardTask> {
    const document = await this.store.read();
    const task = findTask(document, taskId);
    if (!task) {
      throw new BoardError("E_TASK_NOT_FOUND", "Board task not found", {
        taskId,
      });
    }
    return task;
  }

  async create(input: {
    title: string;
    kind?: BoardTask["kind"];
    description?: string;
    acceptanceCriteria?: string[];
    priority?: BoardTask["priority"];
    labels?: string[];
    projectId?: string | null;
    trigger?: Trigger;
    status?: BoardStatus;
    hierarchyParentId?: string | null;
  }): Promise<BoardTask> {
    const now = new Date().toISOString();
    const id = `btask_${randomBytes(8).toString("hex")}`;
    const task = await this.store.transact((document) => {
      if (input.hierarchyParentId) {
        const parent = findTask(document, input.hierarchyParentId);
        if (!parent) {
          throw new BoardError("E_TASK_NOT_FOUND", "Parent task not found", {
            taskId: input.hierarchyParentId,
          });
        }
      }
      const nextRunAt = input.trigger
        ? nextRunAtForTrigger(input.trigger, new Date(now))
        : null;
      const outcome = createBoardTask(
        document,
        {
          ...input,
          status: input.trigger ? "todo" : (input.status ?? "planning"),
          nextRunAt,
        },
        { id, now },
      );
      return { document: outcome.document, result: outcome.task };
    });
    await appendEvent({
      at: now,
      kind: "created",
      taskId: task.id,
      detail: {
        trigger: task.trigger,
        nextRunAt: task.nextRunAt,
        hierarchyParentId: task.hierarchyParentId,
      },
    });
    return task;
  }

  async update(
    taskId: string,
    patch: Parameters<typeof updateBoardTask>[2] & {
      hierarchyParentId?: string | null;
    },
    expectedRevision: number,
  ): Promise<BoardTask> {
    const now = new Date().toISOString();
    const task = await this.store.transact((document) => {
      const { hierarchyParentId, ...fields } = patch;
      const outcome = updateBoardTask(
        document,
        taskId,
        fields,
        expectedRevision,
        now,
      );
      const hierarchy =
        hierarchyParentId === undefined
          ? { document: outcome.document, task: outcome.task }
          : setHierarchyParent(
              outcome.document,
              taskId,
              hierarchyParentId,
              undefined,
              now,
            );
      return { document: hierarchy.document, result: hierarchy.task };
    });
    await appendEvent({ at: now, kind: "updated", taskId });
    return task;
  }

  async setStatus(
    paseo: PaseoApi,
    taskId: string,
    status: BoardStatus,
    expectedRevision: number,
  ): Promise<BoardTask> {
    const now = new Date().toISOString();
    const task = await this.store.transact((document) => {
      const outcome = setBoardStatus(
        document,
        taskId,
        status,
        expectedRevision,
        now,
      );
      return { document: outcome.document, result: outcome.task };
    });
    if (task.status === "done" || task.status === "cancelled") {
      const agentId = task.execution?.agentId;
      if (agentId) await this.archiveAgent(paseo, agentId, task.status);
    }
    await appendEvent({
      at: now,
      kind: "status_changed",
      taskId,
      detail: { to: status, source: "manual" },
    });
    if (task.status === "in_review") this.notify(task, "review");
    if (task.status === "blocked") this.notify(task, "blocked");
    return task;
  }

  async schedule(
    taskId: string,
    trigger: Trigger | null,
    expectedRevision: number,
  ): Promise<BoardTask> {
    const now = new Date().toISOString();
    const task = await this.store.transact((document) => {
      const outcome = setBoardTrigger(
        document,
        taskId,
        trigger,
        expectedRevision,
        now,
      );
      return { document: outcome.document, result: outcome.task };
    });
    await appendEvent({
      at: now,
      kind: "scheduled",
      taskId,
      detail: { trigger, nextRunAt: task.nextRunAt },
    });
    return task;
  }

  async setHierarchy(
    taskId: string,
    parentId: string | null,
    expectedRevision: number,
  ): Promise<BoardTask> {
    const now = new Date().toISOString();
    const task = await this.store.transact((document) => {
      const outcome = setHierarchyParent(
        document,
        taskId,
        parentId,
        expectedRevision,
        now,
      );
      return { document: outcome.document, result: outcome.task };
    });
    await appendEvent({
      at: now,
      kind: "parent_changed",
      taskId,
      detail: { parentId },
    });
    return task;
  }

  async hierarchy(taskId: string) {
    const document = await this.store.read();
    const task = findTask(document, taskId);
    if (!task) {
      throw new BoardError("E_TASK_NOT_FOUND", "Board task not found", {
        taskId,
      });
    }
    const parent = task.hierarchyParentId
      ? findTask(document, task.hierarchyParentId)
      : null;
    const children = document.tasks.filter(
      (entry) => entry.hierarchyParentId === taskId,
    );
    return {
      task,
      parent,
      children,
      summary: hierarchySummary(document.tasks, taskId),
    };
  }

  async cancel(
    paseo: PaseoApi,
    taskId: string,
    expectedRevision: number,
  ): Promise<BoardTask> {
    return this.withTaskLock(taskId, async () => {
      const task = await this.get(taskId);
      assertRevision(task, expectedRevision);
      const now = new Date().toISOString();
      const cancelled = await this.store.transact((document) => {
        const outcome = cancelBoardTask(
          document,
          taskId,
          expectedRevision,
          now,
        );
        return { document: outcome.document, result: outcome.task };
      });
      const agentId = task.execution?.agentId;
      if (agentId) {
        await this.archiveAgent(paseo, agentId, "cancelled");
      }
      await appendEvent({
        at: now,
        kind: "cancelled",
        taskId,
        detail: { executionArchive: "final" },
      });
      return cancelled;
    });
  }

  async assign(
    paseo: PaseoApi,
    input: {
      taskId: string;
      expectedRevision: number;
      projectId: string;
      workspaceId: string;
      agent: BoardAssignment["agent"];
      message?: string;
      start: boolean;
    },
  ): Promise<BoardTask> {
    const target = await resolveAssignmentTarget(
      paseo,
      input.projectId,
      input.workspaceId,
    );
    const assignment: BoardAssignment = {
      mode: "agent",
      ...target,
      agent: input.agent,
      message: input.message,
    };
    const now = new Date().toISOString();
    const task = await this.store.transact((document) => {
      const outcome = assignBoardTask(
        document,
        input.taskId,
        assignment,
        input.expectedRevision,
        now,
      );
      return { document: outcome.document, result: outcome.task };
    });
    await appendEvent({
      at: now,
      kind: "assigned",
      taskId: input.taskId,
      detail: {
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        agent: input.agent.kind,
      },
    });
    return input.start ? this.start(paseo, input.taskId, input.message) : task;
  }

  async start(
    paseo: PaseoApi,
    taskId: string,
    message?: string,
  ): Promise<BoardTask> {
    return this.withTaskLock(taskId, async () => {
      const task = await this.get(taskId);
      if (task.status === "done" || task.status === "cancelled") {
        throw new BoardError(
          "E_INVALID_TRANSITION",
          `Cannot start a task in ${task.status}`,
          { taskId, status: task.status },
        );
      }
      if (task.execution && task.status === "in_progress") return task;

      const now = new Date().toISOString();
      let agentId: string;
      if (!task.execution) {
        if (!task.assignment) {
          throw new BoardError(
            "E_NOT_ASSIGNED",
            "Assign an agent before starting",
            { taskId },
          );
        }
        const created =
          task.assignment.agent.kind === "create"
            ? await createAgentForTask(paseo, task, task.assignment, {
                planningPrompt: (await this.settings.read()).planningPrompt,
              })
            : await executionForExistingAgent(paseo, task, task.assignment);
        agentId = created.execution.agentId;
        await this.index.bind(agentId, task.id);
        await this.store.transact((document) => {
          const outcome = attachExecution(
            document,
            taskId,
            created.execution,
            now,
          );
          return { document: outcome.document, result: outcome.task };
        });
      } else {
        agentId = task.execution.agentId;
        const refreshed = await paseo.agents.ref(agentId).refresh();
        if (!refreshed || refreshed.agent.archivedAt) {
          throw new BoardError(
            "E_AGENT_MISSING",
            "The bound agent is missing or archived",
            { taskId, agentId },
          );
        }
        await this.store.transact((document) => {
          const outcome = beginRun(document, taskId, now);
          return { document: outcome.document, result: outcome.task };
        });
      }

      const prompt = message ?? buildInitialMessage(task);
      try {
        await paseo.agents.ref(agentId).send(prompt);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.store.transact((document) => {
          const outcome = applyTurnAfter(
            document,
            taskId,
            null,
            { kind: "failed", error: { message: reason } },
            new Date().toISOString(),
          );
          return { document: outcome.document, result: outcome.task };
        });
        throw new BoardError("E_AGENT_MISSING", "Could not start the agent", {
          taskId,
          agentId,
          reason,
        });
      }
      await appendEvent({
        at: now,
        kind: "started",
        taskId,
        detail: { agentId },
      });
      return this.get(taskId);
    });
  }

  async stop(paseo: PaseoApi, taskId: string): Promise<BoardTask> {
    return this.withTaskLock(taskId, async () => {
      const now = new Date().toISOString();
      const stopped = await this.store.transact((document) => {
        const outcome = markStopRequested(document, taskId, now);
        return { document: outcome.document, result: outcome.task };
      });
      const agentId = stopped.execution?.agentId;
      if (agentId) {
        try {
          await cancelAgentRun(paseo, agentId, this.cancelAgent);
          const agent = await readStoppedAgent(paseo, agentId);
          assertAgentStopped(taskId, agentId, agent);
        } catch (error) {
          const refreshed = await readStoppedAgent(paseo, agentId).catch(
            () => null,
          );
          const failure = cancelFailure(
            taskId,
            agentId,
            error,
            refreshed ? pendingPermissionDetails(refreshed) : [],
          );
          const failedAt = new Date().toISOString();
          await this.store.transact((document) => {
            const outcome = applyBlocked(
              document,
              taskId,
              "manual",
              failure.message,
              "stop",
              failedAt,
            );
            return { document: outcome.document, result: outcome.task };
          });
          await appendEvent({
            at: failedAt,
            kind: "stop_failed",
            taskId,
            detail: { agentId, reason: failure.message },
          });
          console.error(
            `[paseo-task-board] could not cancel ${agentId}`,
            error,
          );
          throw failure;
        }
      }
      await appendEvent({
        at: now,
        kind: "stopped",
        taskId,
        detail: { agentId },
      });
      return this.get(taskId);
    });
  }

  async unassign(
    paseo: PaseoApi,
    taskId: string,
    expectedRevision: number,
  ): Promise<BoardTask> {
    const before = await this.get(taskId);
    assertRevision(before, expectedRevision);
    let current = before;
    if (before.execution) {
      current = await this.stop(paseo, taskId);
    }
    const now = new Date().toISOString();
    const task = await this.store.transact((document) => {
      const outcome = unassignBoardTask(
        document,
        taskId,
        current.revision,
        now,
      );
      return { document: outcome.document, result: outcome.task };
    });
    if (before.execution) await this.index.unbind(before.execution.agentId);
    await appendEvent({ at: now, kind: "unassigned", taskId });
    return task;
  }

  async delete(
    paseo: PaseoApi,
    taskId: string,
    expectedRevision: number,
  ): Promise<{ deleted: boolean; displayId: string }> {
    const before = await this.get(taskId);
    assertRevision(before, expectedRevision);
    const agentId = before.execution?.agentId;
    if (agentId) {
      await this.stop(paseo, taskId).catch(() => undefined);
      await this.archiveAgent(paseo, agentId, "deleted");
    }
    const current = await this.get(taskId);
    const now = new Date().toISOString();
    const task = await this.store.transact((document) => {
      const outcome = deleteBoardTask(document, taskId, current.revision);
      return { document: outcome.document, result: outcome.task };
    });
    await appendDeleted({
      at: now,
      kind: "deleted",
      taskId,
      detail: { displayId: task.displayId, title: task.title },
    });
    return { deleted: true, displayId: task.displayId };
  }

  async declare(
    taskId: string,
    agentId: string,
    input: DeclareRequest,
  ): Promise<BoardTask> {
    const now = new Date().toISOString();
    const task = await this.requireBoundTask(taskId, agentId);
    if (task.status === "done" || task.status === "cancelled") return task;
    const result = await this.store.transact((document) => {
      if (input.kind === "progress") {
        const outcome = applyProgress(
          document,
          taskId,
          {
            summary: input.summary ?? "progress",
            stage: input.stage,
          },
          now,
        );
        return { document: outcome.document, result: outcome.task };
      }
      const outcome = applyDeclaration(document, taskId, agentId, input, now);
      return { document: outcome.document, result: outcome.task };
    });
    await appendEvent({
      at: now,
      kind: `declare.${input.kind}`,
      taskId,
      detail: {
        agentId,
        summary: input.summary,
        stage: input.kind === "progress" ? input.stage : undefined,
      },
    });
    if (input.kind === "progress") this.notify(result, "progress");
    else if (result.status === "in_review") this.notify(result, "review");
    else if (result.status === "blocked") this.notify(result, "blocked");
    return result;
  }

  async progress(
    taskId: string,
    agentId: string,
    summary: string,
    stage?: string,
  ): Promise<{ task: BoardTask; recorded: boolean }> {
    await this.requireBoundTask(taskId, agentId);
    const now = new Date().toISOString();
    const outcome = await this.store.transact((document) => {
      const applied = applyProgress(document, taskId, { summary, stage }, now);
      return {
        document: applied.document,
        result: { task: applied.task, recorded: applied.recorded },
      };
    });
    await appendEvent({
      at: now,
      kind: "progress",
      taskId,
      detail: { agentId, summary, stage, recorded: outcome.recorded },
    });
    if (outcome.recorded) this.notify(outcome.task, "progress");
    return outcome;
  }

  private async recordSendStopFailure(
    taskId: string,
    agentId: string,
    failure: BoardError,
    source: string,
  ): Promise<void> {
    const at = new Date().toISOString();
    await this.store.transact((document) => {
      const outcome = applyBlocked(
        document,
        taskId,
        "manual",
        failure.message,
        source,
        at,
      );
      return { document: outcome.document, result: outcome.task };
    });
    await appendEvent({
      at,
      kind: "stop_failed",
      taskId,
      detail: { agentId, source, reason: failure.message },
    });
  }

  /**
   * Sends one cancel and polls until the run settles.
   *
   * The daemon can take longer than its own interrupt ack window to settle a
   * run. A repeated cancel would race the first one, so this waits up to
   * `fallbackTimeoutMs` and reports the last observed state when it expires.
   */
  private async interruptForSend(
    paseo: PaseoApi,
    taskId: string,
    agentId: string,
    refreshedAgent: PaseoAgent,
  ): Promise<void> {
    const stopAt = new Date().toISOString();
    await this.store.transact((document) => {
      const outcome = markStopRequested(document, taskId, stopAt);
      return { document: outcome.document, result: outcome.task };
    });

    let cancelError: unknown = null;
    void cancelAgentRun(paseo, agentId, this.cancelAgent).catch((error) => {
      cancelError = error;
    });

    const deadline = Date.now() + this.fallbackTimeoutMs;
    let last = refreshedAgent;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(FALLBACK_POLL_INTERVAL_MS, remaining));
      const current = await readStoppedAgent(paseo, agentId).catch(() => null);
      if (!current) continue;
      last = current;
      const pending = current.pendingPermissions ?? [];
      if (!current.activeTurn && pending.length === 0) return;
    }

    const failure = new BoardError(
      "E_AGENT_BLOCKED",
      `Cannot interrupt agent ${agentId} within ${Math.max(
        1,
        Math.round(this.fallbackTimeoutMs / 1_000),
      )}s. It may be stuck on a question; answer or dismiss it in Paseo, then retry.`,
      {
        taskId,
        agentId,
        lifecycle: last.status,
        pendingPermissions: pendingPermissionDetails(last),
        ...(cancelError === null
          ? {}
          : { cancelError: errorMessage(cancelError) }),
      },
    );
    await this.recordSendStopFailure(taskId, agentId, failure, "send");
    throw failure;
  }

  async sendMessage(
    paseo: PaseoApi,
    taskId: string,
    message: string,
    waitSeconds = 0,
  ): Promise<{
    task: BoardTask;
    wait: Awaited<ReturnType<PaseoAgentHandle["waitForFinish"]>> | null;
    interrupted: boolean;
    answered: boolean;
  }> {
    const task = await this.get(taskId);
    const agentId = task.execution?.agentId;
    if (!agentId) {
      throw new BoardError(
        "E_NOT_ASSIGNED",
        "This task has no bound agent to send a message to",
        { taskId },
      );
    }
    const handle = paseo.agents.ref(agentId);
    const refreshed = await handle.refresh();
    if (!refreshed || refreshed.agent.archivedAt) {
      throw new BoardError("E_AGENT_MISSING", "The bound agent is missing", {
        taskId,
        agentId,
      });
    }

    const pending = refreshed.agent.pendingPermissions ?? [];
    const questionRequests = pending.filter(
      (request) => request.kind === "question",
    );
    let answerFailure: unknown = null;

    // Answer first. Cancelling before the answer lets providers such as pi
    // schedule their delayed abort ahead of the answer and turn the run into
    // "This operation was aborted".
    if (questionRequests.length > 0) {
      const request = questionRequests[0]!;
      const plan =
        pending.length === 1
          ? buildQuestionAnswer(request, message)
          : ({
              ok: false,
              provider: request.provider,
              questions: [],
              reason: `Multiple pending permissions cannot be answered by one send: ${pending
                .map((entry) => `${entry.id} (${entry.kind})`)
                .join(", ")}`,
            } as const);
      if (plan.ok) {
        try {
          await handle.respondToPermission({
            requestId: request.id,
            response: {
              behavior: "allow",
              updatedInput: { answers: plan.answers },
            },
          });
          const answeredAt = new Date().toISOString();
          await this.store.transact((document) => {
            const outcome = syncTurnBefore(document, taskId, null, answeredAt);
            return { document: outcome.document, result: outcome.task };
          });
          await appendEvent({
            at: answeredAt,
            kind: "answered",
            taskId,
            detail: {
              agentId,
              requestId: request.id,
              provider: plan.provider,
              questions: plan.questions.length,
            },
          });
          const wait =
            waitSeconds > 0
              ? await handle.waitForFinish(waitSeconds * 1_000)
              : null;
          return {
            task: await this.get(taskId),
            wait,
            interrupted: false,
            answered: true,
          };
        } catch (error) {
          answerFailure = error;
        }
      } else {
        answerFailure = new BoardError("E_VALIDATION_FAILED", plan.reason, {
          taskId,
          agentId,
          provider: plan.provider,
        });
      }
    }

    if (answerFailure) {
      await appendEvent({
        at: new Date().toISOString(),
        kind: "answer_failed",
        taskId,
        detail: { agentId, reason: errorMessage(answerFailure) },
      });
    }

    const running =
      refreshed.agent.status === "running" ||
      Boolean(refreshed.agent.activeTurn);
    let interrupted = false;
    if (running || pending.length > 0) {
      await this.interruptForSend(paseo, taskId, agentId, refreshed.agent);
      interrupted = true;
    }

    try {
      await handle.send(message);
    } catch (error) {
      const reason = errorMessage(error);
      const failedAt = new Date().toISOString();
      await this.store.transact((document) => {
        const outcome = applyBlocked(
          document,
          taskId,
          "manual",
          `send failed: ${reason}`,
          "send",
          failedAt,
        );
        return { document: outcome.document, result: outcome.task };
      });
      await appendEvent({
        at: failedAt,
        kind: "send_failed",
        taskId,
        detail: { agentId, reason },
      });
      if (/cancellation was not acknowledged/i.test(reason)) {
        throw new BoardError(
          "E_AGENT_BLOCKED",
          `Cannot send to agent ${agentId}: its current turn is still running. Stop the task or wait for the turn to finish, then retry.`,
          { taskId, agentId, reason },
        );
      }
      throw new BoardError("E_CANCEL_FAILED", "Could not send the message", {
        taskId,
        agentId,
        reason,
      });
    }

    if (interrupted) {
      const resumedAt = new Date().toISOString();
      await this.store.transact((document) => {
        const outcome = syncTurnBefore(document, taskId, null, resumedAt);
        return { document: outcome.document, result: outcome.task };
      });
      await appendEvent({
        at: resumedAt,
        kind: "sent",
        taskId,
        detail: { agentId, interrupted: true },
      });
    }
    const wait =
      waitSeconds > 0 ? await handle.waitForFinish(waitSeconds * 1_000) : null;
    return { task: await this.get(taskId), wait, interrupted, answered: false };
  }

  async waitForTask(
    paseo: PaseoApi,
    taskId: string,
    until: ReadonlyArray<"review" | "blocked" | "idle">,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{
    reached: "review" | "blocked" | "idle" | null;
    task: BoardTask;
    agent: AgentSummary | null;
  }> {
    const deadline = Date.now() + timeoutMs;
    let task = await this.get(taskId);
    let agent: AgentSummary | null = null;
    for (;;) {
      task = await this.get(taskId);
      agent = task.execution
        ? await readAgentSummary(paseo, task.execution.agentId)
        : null;
      if (task.status === "in_review" && until.includes("review")) {
        return { reached: "review", task, agent };
      }
      if (task.status === "blocked" && until.includes("blocked")) {
        return { reached: "blocked", task, agent };
      }
      if (
        until.includes("idle") &&
        agent?.lifecycle === "idle" &&
        !agent.activeTurn
      ) {
        return { reached: "idle", task, agent };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal?.aborted) {
        return { reached: null, task, agent };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1_500, remaining)),
      );
    }
  }

  async candidates(paseo: PaseoApi, projectId?: string) {
    const [projects, workspaces, agents, providers] = await Promise.all([
      paseo.projects.list(),
      paseo.workspaces.list({ includeBackground: true, page: { limit: 200 } }),
      paseo.agents.list({ includeBackground: true, page: { limit: 200 } }),
      paseo.providers.listAvailable().catch(() => null),
    ]);
    const providerList =
      providers?.providers.map((entry) => ({
        provider: entry.provider,
        label: entry.provider,
        available: entry.available,
      })) ?? [];
    const profiles = await this.listProfiles(paseo);

    return {
      projects: projects.projects
        .filter((project) => !projectId || project.projectId === projectId)
        .map((project) => {
          const projectWorkspaces = workspaces.entries.filter(
            (workspace) =>
              workspace.projectId === project.projectId &&
              !workspace.archivingAt,
          );
          const workspaceIds = new Set(
            projectWorkspaces.map((workspace) => workspace.id),
          );
          return {
            projectId: project.projectId,
            name: project.projectDisplayName,
            rootPath: project.projectRootPath,
            workspaces: projectWorkspaces.map((workspace) => ({
              workspaceId: workspace.id,
              name: workspace.name,
              directory:
                workspace.workspaceDirectory ?? workspace.projectRootPath,
              kind: workspace.workspaceKind,
              background: workspace.background ?? false,
            })),
            agents: agents.entries
              .filter((entry) => {
                const workspaceId = entry.agent.workspaceId;
                return (
                  workspaceId !== undefined &&
                  workspaceIds.has(workspaceId) &&
                  !entry.agent.archivedAt
                );
              })
              .map((entry) => ({
                agentId: entry.agent.id,
                title: entry.agent.title,
                provider: entry.agent.provider,
                status: entry.agent.status,
              })),
          };
        }),
      profiles,
      providers: providerList,
    };
  }

  async health(
    paseo: PaseoApi,
    scheduler?: {
      instanceId: string;
      lockHeld: boolean;
      lockOwner: string | null;
      lastTickAt: string | null;
      lastReconcileAt: string | null;
      lastError: string | null;
    },
  ) {
    const document = await this.store.read();
    const settings = await this.settings.read();
    let toolInjectionEnabled = false;
    try {
      const config = await paseo.config.get();
      const raw = config.config as unknown as {
        mcp?: { injectIntoAgents?: boolean };
        daemon?: { mcp?: { injectIntoAgents?: boolean } };
      };
      toolInjectionEnabled =
        raw.mcp?.injectIntoAgents ?? raw.daemon?.mcp?.injectIntoAgents ?? false;
    } catch (error) {
      console.error("[paseo-task-board] cannot read daemon config", error);
    }
    return {
      dataDir: pluginDataDir(),
      taskCount: document.tasks.length,
      boundAgentCount: Object.keys(this.index.all()).length,
      toolInjectionEnabled,
      paseoHome: paseoHome(),
      scheduledCount: document.tasks.filter((task) => task.nextRunAt).length,
      pendingPermissionCount: document.tasks.filter(
        (task) => task.pendingPermission,
      ).length,
      wecomEnabled: settings.wecom.enabled,
      wecomConfigured: settings.wecom.webhookUrl.length > 0,
      scheduler: scheduler ?? null,
    };
  }

  async getSettings() {
    return this.settings.read();
  }

  async updateSettings(patch: Parameters<BoardSettingsStore["update"]>[0]) {
    return this.settings.update(patch);
  }

  async listProfiles(paseo: PaseoApi): Promise<PaseoAgentProfile[]> {
    const { config } = await paseo.config.get();
    const raw = config as unknown as {
      agentProfiles?: unknown;
      daemon?: { agentProfiles?: unknown };
    };
    const value = Array.isArray(raw.agentProfiles)
      ? raw.agentProfiles
      : Array.isArray(raw.daemon?.agentProfiles)
        ? raw.daemon.agentProfiles
        : [];
    const profiles: PaseoAgentProfile[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const profile = entry as Record<string, unknown>;
      if (
        typeof profile.id !== "string" ||
        typeof profile.name !== "string" ||
        typeof profile.provider !== "string"
      ) {
        continue;
      }
      profiles.push({
        id: profile.id,
        name: profile.name,
        provider: profile.provider,
        model: optionalString(profile.model),
        modeId: optionalString(profile.modeId),
        thinkingOptionId: optionalString(profile.thinkingOptionId),
        // Paseo 0.15.x profiles only carry featureValues; 0.16 adds options.
        options:
          optionalRecord(profile.options) ??
          optionalRecord(profile.featureValues),
        notes: optionalString(profile.notes),
        icon: optionalString(profile.icon),
        color: optionalString(profile.color),
      });
    }
    return profiles;
  }

  async providerOptions(
    paseo: PaseoApi,
    input: { provider: string; cwd?: string },
  ) {
    const provider = input.provider.trim();
    if (!provider) {
      throw new BoardError("E_VALIDATION_FAILED", "Provider is required");
    }
    const options = input.cwd ? { cwd: input.cwd } : undefined;
    const errors: string[] = [];
    let models: Array<{
      id: string;
      label: string;
      description?: string;
      isDefault: boolean;
      defaultThinkingOptionId?: string;
      thinkingOptions: Array<{
        id: string;
        label: string;
        description?: string;
        isDefault: boolean;
      }>;
    }> = [];
    let modes: Array<{ id: string; label: string; description?: string }> = [];
    try {
      const result = await paseo.providers.listModels(provider, options);
      if (result.error) errors.push(result.error);
      models = (result.models ?? [])
        .filter((model) => model.isSelectable !== false)
        .map((model) => ({
          id: model.id,
          label: model.label,
          description: model.description,
          isDefault: model.isDefault ?? false,
          defaultThinkingOptionId: model.defaultThinkingOptionId,
          thinkingOptions: (model.thinkingOptions ?? []).map((option) => ({
            id: option.id,
            label: option.label,
            description: option.description,
            isDefault: option.isDefault ?? false,
          })),
        }));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      const result = await paseo.providers.listModes(provider, options);
      if (result.error) errors.push(result.error);
      modes = (result.modes ?? []).map((mode) => ({
        id: mode.id,
        label: mode.label,
        description: mode.description,
      }));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return {
      provider,
      cwd: input.cwd ?? null,
      models,
      modes,
      error: errors.length > 0 ? [...new Set(errors)].join(" · ") : null,
    };
  }

  async testNotification(webhookUrl?: string) {
    return this.notifier.test(webhookUrl);
  }

  async bindAgentFromOpen(agentId: string, labels: Record<string, string>) {
    const taskId = labels[BOARD_TASK_LABEL];
    if (!taskId) return;
    const document = await this.store.read();
    const currentId = this.index.taskIdFor(agentId);
    const current = currentId ? findTask(document, currentId) : null;
    if (
      current?.execution?.agentId === agentId &&
      !isTerminalStatus(current.status)
    ) {
      return;
    }
    const preferred = preferredTaskForAgent(document.tasks, agentId);
    if (preferred) {
      await this.index.bind(agentId, preferred.id);
      return;
    }
    if (!findTask(document, taskId)) return;
    await this.index.bind(agentId, taskId);
  }

  async bindAgent(taskId: string, agentId: string): Promise<void> {
    const document = await this.store.read();
    if (!findTask(document, taskId)) return;
    await this.index.bind(agentId, taskId);
  }

  async onTurnBefore(agent: PluginHookAgent, turnId: string | null) {
    const binding = await this.bindingFor(agent);
    if (!binding) return;
    const now = new Date().toISOString();
    await this.store.transact((document) => {
      const outcome = syncTurnBefore(document, binding.taskId, turnId, now);
      return { document: outcome.document, result: outcome.task };
    });
    await appendEvent({
      at: now,
      kind: "hook.turn.before",
      taskId: binding.taskId,
      detail: { agentId: agent.id, turnId },
    });
  }

  async declareForAgent(
    agent: PluginHookAgent,
    input: DeclareRequest,
  ): Promise<BoardTask | null> {
    const binding = await this.bindingFor(agent);
    if (!binding) return null;
    return this.declare(binding.taskId, agent.id, input);
  }

  async onTurnAfter(
    agent: PluginHookAgent,
    turnId: string | null,
    outcome: TurnOutcome,
  ) {
    const binding = await this.bindingFor(agent);
    if (!binding) return;
    const now = new Date().toISOString();
    const task = await this.store.transact((document) => {
      const applied = applyTurnAfter(
        document,
        binding.taskId,
        turnId,
        outcome,
        now,
      );
      return { document: applied.document, result: applied.task };
    });
    await appendEvent({
      at: now,
      kind: "hook.turn.after",
      taskId: binding.taskId,
      detail: {
        agentId: agent.id,
        turnId,
        outcome: outcome.kind,
        status: task.status,
      },
    });
    if (task.status === "in_review") this.notify(task, "review");
    if (task.status === "blocked") this.notify(task, "blocked");
  }

  async onPermissionBefore(
    agent: PluginHookAgent,
    request: PermissionSnapshot,
  ): Promise<void> {
    const binding = await this.bindingFor(agent);
    if (!binding) return;
    const now = new Date().toISOString();
    const task = await this.store.transact((document) => {
      const outcome = applyPermissionBefore(
        document,
        binding.taskId,
        request,
        now,
      );
      return { document: outcome.document, result: outcome.task };
    });
    await appendEvent({
      at: now,
      kind: "hook.permission.before",
      taskId: binding.taskId,
      detail: {
        agentId: agent.id,
        requestId: request.id,
        kind: request.kind,
        status: task.status,
      },
    });
    if (task.status === "blocked") this.notify(task, "blocked");
  }

  async onPermissionAfter(
    agent: PluginHookAgent,
    requestId: string,
    resolution: { behavior: "allow" | "deny"; message?: string },
  ): Promise<void> {
    const binding = await this.bindingFor(agent);
    if (!binding) return;
    const now = new Date().toISOString();
    const outcome = await this.store.transact((document) => {
      const applied = applyPermissionAfter(
        document,
        binding.taskId,
        requestId,
        resolution,
        now,
      );
      return {
        document: applied.document,
        result: { task: applied.task, resumed: applied.resumed },
      };
    });
    await appendEvent({
      at: now,
      kind: "hook.permission.after",
      taskId: binding.taskId,
      detail: {
        agentId: agent.id,
        requestId,
        behavior: resolution.behavior,
        status: outcome.task.status,
        resumed: outcome.resumed,
      },
    });
  }

  async onAgentClose(
    paseo: PaseoApi,
    agent: PluginHookAgent,
    source: string,
  ): Promise<void> {
    if (this.archivingAgents.has(agent.id)) return;
    const binding = await this.bindingFor(agent);
    if (!binding) return;
    const task = await this.get(binding.taskId);
    if (
      task.status === "planning" ||
      task.status === "todo" ||
      task.status === "in_review" ||
      task.status === "done" ||
      task.status === "cancelled"
    ) {
      return;
    }
    let exists = false;
    try {
      const refreshed = await paseo.agents.ref(agent.id).refresh();
      exists = Boolean(refreshed && !refreshed.agent.archivedAt);
    } catch {
      exists = false;
    }
    if (exists) return;
    const now = new Date().toISOString();
    const updated = await this.store.transact((document) => {
      const outcome = applyAgentMissing(document, binding.taskId, now, source);
      return { document: outcome.document, result: outcome.task };
    });
    await appendEvent({
      at: now,
      kind: source,
      taskId: binding.taskId,
      detail: { agentId: agent.id, status: updated.status },
    });
    if (updated.status === "blocked") this.notify(updated, "blocked");
  }

  async runDueScheduled(paseo: PaseoApi, now: Date): Promise<void> {
    const document = await this.store.read();
    const due = document.tasks.filter((task) => isTaskDue(task, now));
    for (const candidate of due) {
      const task = await this.get(candidate.id);
      if (!isTaskDue(task, now)) continue;
      if (task.trigger?.kind === "scheduled") {
        await this.runScheduledOnce(paseo, task, now);
      } else if (task.trigger?.kind === "recurring") {
        await this.runRecurring(paseo, task, now);
      }
    }
  }

  private async runScheduledOnce(
    paseo: PaseoApi,
    task: BoardTask,
    now: Date,
  ): Promise<void> {
    const stamp = now.toISOString();
    await this.store.transact((document) => {
      const outcome = markScheduleFired(document, task.id, null, stamp);
      return { document: outcome.document, result: outcome.task };
    });
    await appendEvent({
      at: stamp,
      kind: "scheduled.fire",
      taskId: task.id,
      detail: { runAt: task.nextRunAt },
    });
    try {
      await this.start(paseo, task.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missingTarget =
        error instanceof BoardError && error.code === "E_NOT_ASSIGNED";
      await this.store.transact((document) => {
        const fired = markScheduleFired(
          document,
          task.id,
          missingTarget ? null : new Date(now.getTime() + 60_000).toISOString(),
          stamp,
        );
        const blocked = applyBlocked(
          fired.document,
          task.id,
          missingTarget ? "human_required" : "agent_error",
          message,
          "scheduler",
          stamp,
        );
        return { document: blocked.document, result: blocked.task };
      });
      await appendEvent({
        at: stamp,
        kind: "scheduled.retry",
        taskId: task.id,
        detail: { message },
      });
      const current = await this.get(task.id);
      if (current.status === "blocked") this.notify(current, "blocked");
      return;
    }
    const current = await this.get(task.id);
    this.notify(current, "scheduled");
  }

  private async runRecurring(
    paseo: PaseoApi,
    task: BoardTask,
    now: Date,
  ): Promise<void> {
    const document = await this.store.read();
    const stamp = now.toISOString();
    const trigger = task.trigger;
    if (!trigger || trigger.kind !== "recurring") return;
    const children = document.tasks.filter(
      (entry) => entry.parentTaskId === task.id,
    );
    const active = children.some(
      (entry) => entry.status !== "done" && entry.status !== "cancelled",
    );
    const next = nextCadenceRunAt(trigger.cadence, now);
    const expired =
      trigger.expiresAt !== undefined &&
      Number.isFinite(Date.parse(trigger.expiresAt)) &&
      Date.parse(trigger.expiresAt) <= now.getTime();
    const maxed =
      trigger.maxRuns !== undefined && task.derivedCount >= trigger.maxRuns;

    if (expired || maxed || !next) {
      await this.store.transact((doc) => {
        const outcome = advanceRecurring(doc, task.id, null, stamp, "stopped");
        return { document: outcome.document, result: outcome.task };
      });
      await appendEvent({
        at: stamp,
        kind: "scheduled.stop",
        taskId: task.id,
        detail: { expired, maxed, derivedCount: task.derivedCount },
      });
      return;
    }
    if (active) {
      await this.store.transact((doc) => {
        const outcome = advanceRecurring(doc, task.id, next, stamp, "skipped");
        return { document: outcome.document, result: outcome.task };
      });
      await appendEvent({
        at: stamp,
        kind: "scheduled.skip",
        taskId: task.id,
        detail: { reason: "previous run is still active", nextRunAt: next },
      });
      return;
    }
    if (!task.assignment) {
      await this.store.transact((doc) => {
        const outcome = applyBlocked(
          doc,
          task.id,
          "human_required",
          "Recurring task has no assignment target.",
          "scheduler",
          stamp,
        );
        return { document: outcome.document, result: outcome.task };
      });
      const current = await this.get(task.id);
      this.notify(current, "blocked");
      return;
    }

    let assignment = task.assignment;
    if (trigger.session === "reuse") {
      const reusable = [...children]
        .reverse()
        .find((entry) => entry.execution?.agentId);
      if (reusable?.execution) {
        assignment = {
          ...task.assignment,
          agent: {
            kind: "existing",
            agentId: reusable.execution.agentId,
          },
        };
      }
    }

    const childId = `btask_${randomBytes(8).toString("hex")}`;
    const child = await this.store.transact((doc) => {
      const created = createBoardTask(
        doc,
        {
          title: task.title,
          description: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
          priority: task.priority,
          labels: [...task.labels, "recurring"],
          projectId: task.projectId,
          status: "todo",
          assignment,
          parentTaskId: task.id,
        },
        { id: childId, now: stamp },
      );
      const advanced = advanceRecurring(
        created.document,
        task.id,
        next,
        stamp,
        "spawned",
      );
      return { document: advanced.document, result: created.task };
    });
    await appendEvent({
      at: stamp,
      kind: "scheduled.spawn",
      taskId: task.id,
      detail: { childId: child.id, nextRunAt: next },
    });
    try {
      const started = await this.start(
        paseo,
        child.id,
        task.assignment.message,
      );
      this.notify(started, "scheduled");
    } catch (error) {
      console.error(
        `[paseo-task-board] recurring run ${child.id} failed to start`,
        error,
      );
      await this.store.transact((doc) => {
        const outcome = markScheduleFired(
          doc,
          task.id,
          new Date(now.getTime() + 60_000).toISOString(),
          stamp,
        );
        return { document: outcome.document, result: outcome.task };
      });
      const current = await this.get(child.id);
      if (current.status === "blocked") this.notify(current, "blocked");
    }
  }

  async reconcileAgents(paseo: PaseoApi, now: Date): Promise<void> {
    const document = await this.store.read();
    for (const task of document.tasks) {
      if (!task.execution) continue;
      if (task.status !== "in_progress" && task.status !== "blocked") continue;
      const agentId = task.execution.agentId;
      if (this.archivingAgents.has(agentId)) continue;
      const lastActivity = Date.parse(
        task.execution.lastActivityAt ?? task.execution.startedAt,
      );
      if (
        Number.isFinite(lastActivity) &&
        now.getTime() - lastActivity < 10_000
      ) {
        continue;
      }
      let refreshed: Awaited<ReturnType<PaseoAgentHandle["refresh"]>> = null;
      try {
        refreshed = await paseo.agents.ref(agentId).refresh();
      } catch {
        refreshed = null;
      }
      const stamp = now.toISOString();
      if (!refreshed || refreshed.agent.archivedAt) {
        const updated = await this.store.transact((doc) => {
          const outcome = applyAgentMissing(
            doc,
            task.id,
            stamp,
            "reconcile.missing",
          );
          return { document: outcome.document, result: outcome.task };
        });
        if (
          updated.status === "blocked" &&
          updated.blockReason === "agent_missing"
        ) {
          this.notify(updated, "blocked");
        }
        continue;
      }
      const pending = refreshed.agent.pendingPermissions[0];
      if (pending) {
        const updated = await this.store.transact((doc) => {
          const outcome = applyPermissionBefore(
            doc,
            task.id,
            {
              id: pending.id,
              kind: pending.kind,
              name: pending.name,
              title: pending.title,
              description: pending.description,
            },
            stamp,
          );
          return { document: outcome.document, result: outcome.task };
        });
        if (updated.status === "blocked") this.notify(updated, "blocked");
        continue;
      }
      if (task.status === "in_progress" && refreshed.agent.status === "idle") {
        const updated = await this.store.transact((doc) => {
          const outcome = applyAgentSilent(doc, task.id, stamp);
          return { document: outcome.document, result: outcome.task };
        });
        if (updated.status === "blocked") this.notify(updated, "blocked");
      }
    }
  }

  private notify(task: BoardTask, event: NotificationEvent): void {
    this.notifier.enqueue(task, event);
  }

  private async bindingFor(
    agent: PluginHookAgent,
  ): Promise<{ taskId: string; task: BoardTask } | null> {
    const indexedId = this.index.taskIdFor(agent.id) ?? taskIdFromAgent(agent);
    const document = await this.store.read();
    let task = indexedId ? findTask(document, indexedId) : null;
    if (!task || task.execution?.agentId !== agent.id) {
      const preferred = preferredTaskForAgent(document.tasks, agent.id);
      if (preferred) task = preferred;
    }
    if (!task) {
      if (indexedId) await this.index.unbind(agent.id);
      return null;
    }
    if (task.execution?.agentId !== agent.id) return null;
    if (this.index.taskIdFor(agent.id) !== task.id)
      await this.index.bind(agent.id, task.id);
    return { taskId: task.id, task };
  }

  private async requireBoundTask(
    taskId: string,
    agentId: string,
  ): Promise<BoardTask> {
    const document = await this.store.read();
    const task = findTask(document, taskId);
    if (!task) {
      throw new BoardError("E_TASK_NOT_FOUND", "Board task not found", {
        taskId,
      });
    }
    if (!task.execution || task.execution.agentId !== agentId) {
      throw new BoardError(
        "E_NO_BOUND_TASK",
        "This agent is not bound to the task",
        { taskId, agentId },
      );
    }
    return task;
  }
}
