import { defineAgentTool } from "@getpaseo/plugin/server";
import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentToolResult,
} from "@getpaseo/plugin/server";
import { z } from "zod";
import { BoardError } from "../shared/core/board/errors";
import {
  BOARD_ADMIN_LABEL,
  LEGACY_BOARD_ADMIN_LABEL,
  BoardPrioritySchema,
  BoardStatusSchema,
  BoardTaskKindSchema,
  TriggerSchema,
  type BoardAssignment,
  type BoardTask,
} from "../shared/core/board/types";
import {
  describeActivity,
  listAgentSummaries,
  readAgentSummary,
  readTaskLogs,
  summarizeTask,
  type LogFilter,
} from "./inspection";
import type { TaskBoardService, DeclareRequest } from "./service";
import { readEvents } from "./store";

const TaskIdSchema = z.string().min(1);
const RevisionSchema = z.number().int().nonnegative();

function ok(
  text: string,
  structuredContent: Record<string, unknown>,
): AgentToolResult {
  return { text, structuredContent: { ok: true, ...structuredContent } };
}

function fail(code: string, message: string): AgentToolResult {
  return {
    isError: true,
    text: `${code}: ${message}`,
    structuredContent: { ok: false, code, message },
  };
}

function tool(
  name: string,
  description: string,
  input: z.ZodType,
  execute: (
    raw: unknown,
    context: AgentToolContext,
  ) => Promise<AgentToolResult>,
): AgentToolDefinition {
  return defineAgentTool({
    name,
    description,
    input,
    async execute(raw, context) {
      try {
        return await execute(raw, context);
      } catch (error) {
        if (error instanceof BoardError) {
          return fail(error.code, error.message);
        }
        const message = error instanceof Error ? error.message : String(error);
        return fail("E_INTERNAL", message);
      }
    },
  });
}

async function requireAdmin(context: AgentToolContext): Promise<void> {
  const refreshed = await context.paseo.agents
    .ref(context.agent.id)
    .refresh()
    .catch(() => null);
  if (!refreshed) {
    throw new BoardError(
      "E_FORBIDDEN",
      "Cannot verify this agent's board role",
      { agentId: context.agent.id },
    );
  }
  if (
    refreshed.agent.labels?.[BOARD_ADMIN_LABEL] !== "1" &&
    refreshed.agent.labels?.[LEGACY_BOARD_ADMIN_LABEL] !== "1"
  ) {
    throw new BoardError("E_FORBIDDEN", "This agent is not a board admin", {
      agentId: context.agent.id,
    });
  }
}

async function revisionFor(
  service: TaskBoardService,
  taskId: string,
  expected?: number,
): Promise<number> {
  if (expected !== undefined) return expected;
  return (await service.get(taskId)).revision;
}

const emptyInput = z.object({}).strict();

export function createBoardDeclareTool(
  service: TaskBoardService,
): AgentToolDefinition {
  return tool(
    "board_declare",
    "Report this task's status to the Paseo task board. Call once per turn when you finish, " +
      "need a human, are waiting on your own background work, or want to post progress.",
    z
      .object({
        kind: z.enum(["review", "blocked", "waiting", "progress", "clear"]),
        summary: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("One line the card shows"),
        stage: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Coarse stage name, progress only"),
        blockReason: z
          .enum(["human_required", "permission", "question", "manual"])
          .optional(),
        humanRequest: z
          .object({
            title: z.string().trim().min(1),
            instructions: z.string().trim().min(1),
            action: z
              .discriminatedUnion("kind", [
                z
                  .object({
                    kind: z.literal("open_url"),
                    url: z.string().trim().min(1),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("open_terminal"),
                    command: z.string().trim().min(1),
                  })
                  .strict(),
                z.object({ kind: z.literal("manual") }).strict(),
              ])
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    async (raw, context) => {
      const input = raw as {
        kind: "review" | "blocked" | "waiting" | "progress" | "clear";
        summary?: string;
        stage?: string;
        blockReason?: "human_required" | "permission" | "question" | "manual";
        humanRequest?: {
          title: string;
          instructions: string;
          action?:
            | { kind: "open_url"; url: string }
            | { kind: "open_terminal"; command: string }
            | { kind: "manual" };
        };
      };
      if (input.kind === "progress" && !input.summary) {
        return fail("INVALID_INPUT", "progress requires a summary");
      }
      let request: DeclareRequest;
      if (input.kind === "progress") {
        request = {
          kind: "progress",
          summary: input.summary ?? "progress",
          stage: input.stage,
        };
      } else if (input.kind === "blocked") {
        request = {
          kind: "blocked",
          summary: input.summary,
          blockReason: input.blockReason,
          humanRequest: input.humanRequest,
        };
      } else {
        request = { kind: input.kind, summary: input.summary };
      }
      const task = await service.declareForAgent(context.agent, request);
      if (!task) {
        return fail(
          "NO_BOUND_TASK",
          "This agent is not bound to a task board card.",
        );
      }
      return ok(
        `Declared ${input.kind}. ${task.displayId} is ${task.status}.`,
        {
          accepted: true,
          taskId: task.id,
          displayId: task.displayId,
          status: task.status,
          revision: task.revision,
        },
      );
    },
  );
}

export function createBoardAdminTools(
  service: TaskBoardService,
): AgentToolDefinition[] {
  const list = tool(
    "board_list",
    "List board cards with status/parent filters and a short agent state for each card.",
    z
      .object({
        status: BoardStatusSchema.optional(),
        parentId: TaskIdSchema.nullable().optional(),
        includeFinished: z.boolean().default(true),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .strict(),
    async (raw, context) => {
      await requireAdmin(context);
      const input = raw as {
        status?: BoardTask["status"];
        parentId?: string | null;
        includeFinished: boolean;
        limit: number;
      };
      const { tasks, counts } = await service.list({
        status: input.status,
        includeFinished: input.includeFinished,
        hierarchyParentId: input.parentId,
      });
      const agents = await listAgentSummaries(context.paseo);
      const selected = tasks
        .slice(0, input.limit)
        .map((task) =>
          summarizeTask(
            task,
            task.execution ? (agents[task.execution.agentId] ?? null) : null,
          ),
        );
      return ok(`Listed ${selected.length} of ${tasks.length} cards.`, {
        tasks: selected,
        total: tasks.length,
        counts,
      });
    },
  );

  const get = tool(
    "board_get",
    "Read one board card with its full record. Logs are not included; use board_logs.",
    z.object({ taskId: TaskIdSchema }).strict(),
    async (raw, context) => {
      await requireAdmin(context);
      const task = await service.get((raw as { taskId: string }).taskId);
      return ok(`${task.displayId} ${task.title}`, { task });
    },
  );

  const status = tool(
    "board_status",
    "Read a card's state plus its bound agent's live lifecycle, pending permissions, " +
      "active turn, last error and last usage.",
    z.object({ taskId: TaskIdSchema }).strict(),
    async (raw, context) => {
      await requireAdmin(context);
      const task = await service.get((raw as { taskId: string }).taskId);
      const agent = task.execution
        ? await readAgentSummary(context.paseo, task.execution.agentId)
        : null;
      const recentActivity = task.activity.slice(-5).map(describeActivity);
      return ok(
        `${task.displayId} is ${task.status}; agent ${
          agent ? agent.lifecycle : "unassigned"
        }.`,
        {
          task: summarizeTask(task, agent),
          agent,
          recentActivity,
        },
      );
    },
  );

  const logs = tool(
    "board_logs",
    "Read the tail of a card's agent timeline. Defaults to 20 entries, max 200. " +
      "Assistant/user text is truncated and reasoning is never returned.",
    z
      .object({
        taskId: TaskIdSchema,
        limit: z.number().int().min(1).max(200).default(20),
        filter: z
          .enum(["all", "text", "tools", "errors", "permissions"])
          .default("all"),
      })
      .strict(),
    async (raw, context) => {
      await requireAdmin(context);
      const input = raw as {
        taskId: string;
        limit: number;
        filter: LogFilter;
      };
      const task = await service.get(input.taskId);
      const result = await readTaskLogs(context.paseo, task, {
        limit: input.limit,
        filter: input.filter,
      });
      return ok(
        `Read ${result.entries.length} ${input.filter} entries for ${task.displayId}.`,
        result,
      );
    },
  );

  const events = tool(
    "board_events",
    "Read the board event stream (status, declare, progress, stop, hooks).",
    z
      .object({
        taskId: TaskIdSchema.optional(),
        kind: z.string().trim().min(1).optional(),
        limit: z.number().int().min(1).max(500).default(50),
      })
      .strict(),
    async (raw, context) => {
      await requireAdmin(context);
      const input = raw as {
        taskId?: string;
        kind?: string;
        limit: number;
      };
      const result = await readEvents(input);
      return ok(`Read ${result.length} board events.`, { events: result });
    },
  );

  const profiles = tool(
    "board_profiles",
    "List Paseo agent profiles from daemon.agentProfiles so a card can be assigned by profile.",
    emptyInput,
    async (_raw, context) => {
      await requireAdmin(context);
      const result = await service.listProfiles(context.paseo);
      return ok(`Found ${result.length} agent profiles.`, {
        profiles: result,
      });
    },
  );

  const providers = tool(
    "board_providers",
    "List available providers, or one provider's models, thinking options and modes.",
    z
      .object({
        provider: z.string().trim().min(1).optional(),
        cwd: z.string().trim().min(1).optional(),
      })
      .strict(),
    async (raw, context) => {
      await requireAdmin(context);
      const input = raw as { provider?: string; cwd?: string };
      const available = await context.paseo.providers
        .listAvailable()
        .catch(() => null);
      const result: Record<string, unknown> = {
        providers:
          available?.providers.map((entry) => ({
            provider: entry.provider,
            available: entry.available,
          })) ?? [],
      };
      if (input.provider) {
        result.catalog = await service.providerOptions(context.paseo, {
          provider: input.provider,
          cwd: input.cwd,
        });
      }
      return ok(
        input.provider
          ? `Read provider catalog for ${input.provider}.`
          : `Found ${(available?.providers ?? []).length} providers.`,
        result,
      );
    },
  );

  const create = tool(
    "board_create",
    "Create a board card. Use kind=task-planning only when the card should plan other cards.",
    z
      .object({
        title: z.string().trim().min(1).max(200),
        kind: BoardTaskKindSchema.optional(),
        description: z.string().optional(),
        acceptanceCriteria: z.array(z.string().trim().min(1)).optional(),
        priority: BoardPrioritySchema.optional(),
        labels: z.array(z.string().trim().min(1)).optional(),
        projectId: TaskIdSchema.nullable().optional(),
        hierarchyParentId: TaskIdSchema.nullable().optional(),
        trigger: TriggerSchema.optional(),
        status: BoardStatusSchema.optional(),
      })
      .strict(),
    async (raw, context) => {
      await requireAdmin(context);
      const task = await service.create(
        raw as Parameters<TaskBoardService["create"]>[0],
      );
      return ok(`Created ${task.displayId} ${task.title}.`, {
        task: summarizeTask(task, null),
      });
    },
  );

  const update = tool(
    "board_update",
    "Update a card's title, description, acceptance criteria, priority, labels, " +
      "project or hierarchy parent.",
    z
      .object({
        taskId: TaskIdSchema,
        expectedRevision: RevisionSchema.optional(),
        patch: z
          .object({
            title: z.string().trim().min(1).max(200).optional(),
            description: z.string().nullable().optional(),
            acceptanceCriteria: z
              .array(z.string().trim().min(1))
              .nullable()
              .optional(),
            priority: BoardPrioritySchema.optional(),
            labels: z.array(z.string().trim().min(1)).optional(),
            projectId: TaskIdSchema.nullable().optional(),
            hierarchyParentId: TaskIdSchema.nullable().optional(),
          })
          .strict(),
      })
      .strict(),
    async (raw, context) => {
      await requireAdmin(context);
      const input = raw as {
        taskId: string;
        expectedRevision?: number;
        patch: Parameters<TaskBoardService["update"]>[1];
      };
      const task = await service.update(
        input.taskId,
        input.patch,
        await revisionFor(service, input.taskId, input.expectedRevision),
      );
      return ok(`Updated ${task.displayId}.`, {
        task: summarizeTask(task, null),
      });
    },
  );

  const assign = tool(
    "board_assign",
    "Assign a card to a Project, Workspace and either an existing agent or a new one. " +
      "A new agent may come from a profile or explicit provider/model/mode/thinking.",
    z
      .object({
        taskId: TaskIdSchema,
        expectedRevision: RevisionSchema.optional(),
        projectId: TaskIdSchema,
        workspaceId: TaskIdSchema,
        agent: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("existing"),
              agentId: TaskIdSchema,
            })
            .strict(),
          z
            .object({
              kind: z.literal("create"),
              profileId: TaskIdSchema.optional(),
              provider: z.string().trim().min(1).optional(),
              model: z.string().trim().min(1).optional(),
              modeId: z.string().trim().min(1).optional(),
              thinkingOptionId: z.string().trim().min(1).optional(),
              title: z.string().trim().min(1).optional(),
              instructions: z.string().optional(),
            })
            .strict(),
        ]),
        message: z.string().trim().min(1).optional(),
        start: z.boolean().default(false),
      })
      .strict(),
    async (raw, context) => {
      await requireAdmin(context);
      const input = raw as {
        taskId: string;
        expectedRevision?: number;
        projectId: string;
        workspaceId: string;
        agent:
          | { kind: "existing"; agentId: string }
          | {
              kind: "create";
              profileId?: string;
              provider?: string;
              model?: string;
              modeId?: string;
              thinkingOptionId?: string;
              title?: string;
              instructions?: string;
            };
        message?: string;
        start: boolean;
      };
      let agent = input.agent;
      const profileId = agent.kind === "create" ? agent.profileId : undefined;
      if (agent.kind === "create" && profileId) {
        const profiles = await service.listProfiles(context.paseo);
        const profile = profiles.find((entry) => entry.id === profileId);
        if (!profile) {
          throw new BoardError(
            "E_PROFILE_NOT_FOUND",
            `Agent profile not found: ${profileId}`,
            { profileId },
          );
        }
        agent = {
          kind: "create",
          provider: agent.provider ?? profile.provider,
          model: agent.model ?? profile.model,
          modeId: agent.modeId ?? profile.modeId,
          thinkingOptionId: agent.thinkingOptionId ?? profile.thinkingOptionId,
          title: agent.title ?? profile.name,
          instructions: agent.instructions,
        };
      }
      let assignmentAgent: BoardAssignment["agent"];
      if (agent.kind === "existing") {
        assignmentAgent = agent;
      } else {
        if (!agent.provider) {
          throw new BoardError(
            "E_VALIDATION_FAILED",
            "A create assignment needs a profileId or a provider",
            { taskId: input.taskId },
          );
        }
        assignmentAgent = {
          kind: "create",
          provider: agent.provider,
          model: agent.model,
          modeId: agent.modeId,
          thinkingOptionId: agent.thinkingOptionId,
          title: agent.title,
          instructions: agent.instructions,
        };
      }
      const task = await service.assign(context.paseo, {
        taskId: input.taskId,
        expectedRevision: await revisionFor(
          service,
          input.taskId,
          input.expectedRevision,
        ),
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        agent: assignmentAgent,
        message:
          input.message ??
          (assignmentAgent.kind === "create"
            ? assignmentAgent.instructions
            : undefined),
        start: input.start,
      });
      const summary = task.execution
        ? await readAgentSummary(context.paseo, task.execution.agentId)
        : null;
      return ok(`Assigned ${task.displayId}.`, {
        task: summarizeTask(task, summary),
      });
    },
  );

  const start = tool(
    "board_start",
    "Start a card's assigned agent, or send another turn to an existing execution.",
    z
      .object({
        taskId: TaskIdSchema,
        message: z.string().trim().min(1).optional(),
      })
      .strict(),
    async (raw, context) => {
      await requireAdmin(context);
      const input = raw as { taskId: string; message?: string };
      const task = await service.start(
        context.paseo,
        input.taskId,
        input.message,
      );
      const agent = task.execution
        ? await readAgentSummary(context.paseo, task.execution.agentId)
        : null;
      return ok(`${task.displayId} is ${task.status}.`, {
        task: summarizeTask(task, agent),
      });
    },
  );

  const stop = tool(
    "board_stop",
    "Cancel the card's current turn and keep the session. Fails when the provider refuses " +
      "to acknowledge the cancellation; the card is then blocked(manual) with the failure reason.",
    z.object({ taskId: TaskIdSchema }).strict(),
    async (raw, context) => {
      await requireAdmin(context);
      const task = await service.stop(
        context.paseo,
        (raw as { taskId: string }).taskId,
      );
      return ok(`${task.displayId} is ${task.status}.`, {
        task: summarizeTask(task, null),
      });
    },
  );

  const cancel = tool(
    "board_cancel",
    "Cancel the card and archive its agent execution.",
    z
      .object({
        taskId: TaskIdSchema,
        expectedRevision: RevisionSchema.optional(),
      })
      .strict(),
    async (raw, context) => {
      await requireAdmin(context);
      const input = raw as { taskId: string; expectedRevision?: number };
      const task = await service.cancel(
        context.paseo,
        input.taskId,
        await revisionFor(service, input.taskId, input.expectedRevision),
      );
      return ok(`${task.displayId} is ${task.status}.`, {
        task: summarizeTask(task, null),
      });
    },
  );

  const unassign = tool(
    "board_unassign",
    "Stop the bound agent and clear the card's assignment, returning it to planning.",
    z
      .object({
        taskId: TaskIdSchema,
        expectedRevision: RevisionSchema.optional(),
      })
      .strict(),
    async (raw, context) => {
      await requireAdmin(context);
      const input = raw as { taskId: string; expectedRevision?: number };
      const task = await service.unassign(
        context.paseo,
        input.taskId,
        await revisionFor(service, input.taskId, input.expectedRevision),
      );
      return ok(`${task.displayId} is ${task.status}.`, {
        task: summarizeTask(task, null),
      });
    },
  );

  const done = tool(
    "board_done",
    "Mark a card done. Board-admin only; workers must not finish cards themselves.",
    z
      .object({
        taskId: TaskIdSchema,
        expectedRevision: RevisionSchema.optional(),
      })
      .strict(),
    async (raw, context) => {
      await requireAdmin(context);
      const input = raw as { taskId: string; expectedRevision?: number };
      const task = await service.setStatus(
        context.paseo,
        input.taskId,
        "done",
        await revisionFor(service, input.taskId, input.expectedRevision),
      );
      return ok(`${task.displayId} is done.`, {
        task: summarizeTask(task, null),
      });
    },
  );

  const send = tool(
    "board_send",
    "Send a message to a card's bound agent. If the agent is running or waiting on a question, " +
      "the current turn is cancelled first; the question stays in history as Interrupted. " +
      "Optionally wait for the turn to finish (max 300s).",
    z
      .object({
        taskId: TaskIdSchema,
        message: z.string().trim().min(1),
        waitSeconds: z.number().int().min(0).max(300).default(0),
      })
      .strict(),
    async (raw, context) => {
      await requireAdmin(context);
      const input = raw as {
        taskId: string;
        message: string;
        waitSeconds: number;
      };
      const result = await service.sendMessage(
        context.paseo,
        input.taskId,
        input.message,
        input.waitSeconds,
      );
      return ok(
        `Sent to ${result.task.displayId}${
          result.interrupted ? " after interrupting the current turn" : ""
        }${result.wait ? `; turn ${result.wait.status}` : ""}.`,
        {
          task: summarizeTask(result.task, null),
          wait: result.wait,
        },
      );
    },
  );

  const wait = tool(
    "board_wait",
    "Wait until a card reaches review, blocked, or its agent becomes idle (max 120s).",
    z
      .object({
        taskId: TaskIdSchema,
        until: z
          .array(z.enum(["review", "blocked", "idle"]))
          .min(1)
          .default(["review", "blocked"]),
        timeoutMs: z.number().int().min(1_000).max(120_000).default(60_000),
      })
      .strict(),
    async (raw, context) => {
      await requireAdmin(context);
      const input = raw as {
        taskId: string;
        until: Array<"review" | "blocked" | "idle">;
        timeoutMs: number;
      };
      const result = await service.waitForTask(
        context.paseo,
        input.taskId,
        input.until,
        input.timeoutMs,
        context.signal,
      );
      return ok(
        result.reached
          ? `${result.task.displayId} reached ${result.reached}.`
          : `Timed out waiting for ${result.task.displayId}.`,
        result,
      );
    },
  );

  return [
    list,
    get,
    status,
    logs,
    events,
    profiles,
    providers,
    create,
    update,
    assign,
    start,
    stop,
    cancel,
    unassign,
    done,
    send,
    wait,
  ];
}

export function toolsForLabels(
  labels: Readonly<Record<string, string>>,
  declareTool: AgentToolDefinition,
  adminTools: AgentToolDefinition[],
): AgentToolDefinition[] {
  if (
    labels[BOARD_ADMIN_LABEL] === "1" ||
    labels[LEGACY_BOARD_ADMIN_LABEL] === "1"
  ) {
    return [...adminTools, declareTool];
  }
  return [declareTool];
}
