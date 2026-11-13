import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PaseoAgentHandle, PaseoApi } from "@getpaseo/client";
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
  mapLegacyDocument,
  mergeLegacyTasks,
} from "../shared/core/board/migrate";
import {
  preferredTaskForAgent,
  taskIdFromAgent,
} from "../shared/core/board/agent-index";
import { isTerminalStatus } from "../shared/core/board/types";
import {
  createAgentForTask,
  executionForExistingAgent,
  resolveAssignmentTarget,
} from "./assigner";
import { buildInitialMessage } from "./system-prompt";
import { appendDeleted, appendEvent, type BoardStore } from "./store";
import { rebuildFromPaseo } from "./agent-index";
import type { AgentIndex } from "./agent-index";
import {
  legacyTasksPath,
  migrationsPath,
  pluginDataDir,
  paseoHome,
} from "./plugin-data";
import { BoardSettingsStore } from "./settings";
import { WeComNotifier, type NotificationEvent } from "./notifier";

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export interface ListInput {
  status?: BoardStatus;
  projectId?: string;
  label?: string;
  query?: string;
  includeFinished: boolean;
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
  ) {
    this.settings = settings ?? new BoardSettingsStore();
    this.notifier = notifier ?? new WeComNotifier(this.settings);
  }

  initialize(paseo: PaseoApi): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await this.store.load();
        await this.index.load();
        await this.settings.load();
        try {
          const document = await this.store.read();
          const rebuilt = await rebuildFromPaseo(paseo, document.tasks);
          for (const task of document.tasks) {
            if (task.execution && !rebuilt[task.execution.agentId]) {
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
            `[agentstorm-task-board] restored ${document.tasks.length} tasks and ${Object.keys(rebuilt).length} agent bindings`,
          );
        } catch (error) {
          console.error(
            "[agentstorm-task-board] agent index rebuild failed; using persisted index",
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
    description?: string;
    acceptanceCriteria?: string[];
    priority?: BoardTask["priority"];
    labels?: string[];
    projectId?: string | null;
    trigger?: Trigger;
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
          status: input.trigger ? "todo" : "planning",
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
        this.archivingAgents.add(agentId);
        try {
          await paseo.agents
            .ref(agentId)
            .reload()
            .catch(() => undefined);
          await paseo.agents.ref(agentId).archive();
        } catch (error) {
          console.error(
            `[agentstorm-task-board] could not archive ${agentId}`,
            error,
          );
        } finally {
          this.archivingAgents.delete(agentId);
        }
        await this.index.unbind(agentId);
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
            ? await createAgentForTask(paseo, task, task.assignment)
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
      const task = await this.store.transact((document) => {
        const outcome = markStopRequested(document, taskId, now);
        return { document: outcome.document, result: outcome.task };
      });
      const agentId = task.execution?.agentId;
      if (agentId) {
        try {
          await paseo.agents.ref(agentId).reload();
        } catch (error) {
          console.error(
            `[agentstorm-task-board] could not interrupt ${agentId}`,
            error,
          );
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
      this.archivingAgents.add(agentId);
      try {
        await this.stop(paseo, taskId).catch(() => undefined);
        await paseo.agents
          .ref(agentId)
          .archive()
          .catch(() => undefined);
      } finally {
        this.archivingAgents.delete(agentId);
      }
      await this.index.unbind(agentId);
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
      console.error("[agentstorm-task-board] cannot read daemon config", error);
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

  async testNotification(webhookUrl?: string) {
    return this.notifier.test(webhookUrl);
  }

  async migrateLegacy(
    paseo: PaseoApi,
    input: {
      dryRun?: boolean;
      sourcePath?: string;
      includeFinished?: boolean;
    } = {},
  ) {
    const dryRun = input.dryRun ?? true;
    const includeFinished = input.includeFinished ?? true;
    const sourcePath = input.sourcePath ?? legacyTasksPath();
    let raw: string;
    try {
      raw = await readFile(sourcePath, "utf8");
    } catch (error) {
      throw new BoardError(
        "E_MIGRATION_SOURCE",
        `Cannot read legacy tasks file: ${sourcePath}`,
        {
          sourcePath,
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }
    const sourceDigest = createHash("sha256").update(raw).digest("hex");
    const recordPath = migrationsPath();
    const history = await readJsonFile(recordPath);
    const records = Array.isArray(
      (history as { records?: unknown } | null)?.records,
    )
      ? ((history as { records: unknown[] }).records ?? [])
      : [];
    if (
      records.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { sourceDigest?: unknown }).sourceDigest === sourceDigest,
      )
    ) {
      return {
        dryRun,
        noop: true,
        sourcePath,
        sourceDigest,
        appliedAt: new Date().toISOString(),
        mapped: [],
        skipped: [],
        conflicts: [],
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new BoardError(
        "E_MIGRATION_SOURCE",
        "Legacy tasks file is not valid JSON",
        {
          sourcePath,
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }

    const agentIds = new Set<string>();
    const legacyTasks = Array.isArray(parsed)
      ? parsed
      : ((parsed as { tasks?: unknown } | null)?.tasks ?? []);
    if (Array.isArray(legacyTasks)) {
      for (const entry of legacyTasks) {
        if (!entry || typeof entry !== "object") continue;
        const execution = (entry as { execution?: unknown }).execution;
        if (!execution || typeof execution !== "object") continue;
        const agentId = (execution as { agentId?: unknown }).agentId;
        if (typeof agentId === "string" && agentId.length > 0) {
          agentIds.add(agentId);
        }
      }
    }
    const existingAgents = new Set<string>();
    for (const agentId of agentIds) {
      const refreshed = await paseo.agents
        .ref(agentId)
        .refresh()
        .catch(() => null);
      if (refreshed && !refreshed.agent.archivedAt) {
        existingAgents.add(agentId);
      }
    }

    const document = await this.store.read();
    const now = new Date().toISOString();
    const result = mapLegacyDocument(parsed, {
      now,
      includeFinished,
      existingTaskIds: new Set(document.tasks.map((task) => task.id)),
      existingDisplayIds: new Set(document.tasks.map((task) => task.displayId)),
      nextNumber: document.nextNumber,
      createId: () => `btask_${randomBytes(8).toString("hex")}`,
      agentExists: (agentId) => existingAgents.has(agentId),
    });

    const report = {
      dryRun,
      noop: false,
      sourcePath,
      sourceDigest,
      appliedAt: now,
      mapped: result.report.mapped,
      skipped: result.report.skipped,
      conflicts: result.report.conflicts,
      nextNumber: result.nextNumber,
    };
    if (dryRun || result.tasks.length === 0) return report;

    await this.store.transact((current) => ({
      document: mergeLegacyTasks(current, result.tasks, result.nextNumber),
      result: null,
    }));
    await mkdir(dirname(recordPath), { recursive: true });
    const temporary = `${recordPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(
      temporary,
      `${JSON.stringify(
        { version: 1, records: [...records, report] },
        null,
        2,
      )}\n`,
    );
    await rename(temporary, recordPath);
    await appendEvent({
      at: now,
      kind: "migrated",
      detail: {
        sourceDigest,
        mapped: report.mapped.length,
        skipped: report.skipped.length,
      },
    });
    return report;
  }

  async bindAgentFromOpen(agentId: string, labels: Record<string, string>) {
    const taskId = labels["agentstorm.task-id"];
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
        `[agentstorm-task-board] recurring run ${child.id} failed to start`,
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
