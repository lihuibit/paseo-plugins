import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type {
  AgentToolContext,
  AgentToolResult,
} from "@getpaseo/plugin/server";
import {
  applyPermissionBefore,
  attachExecution,
  assignBoardTask,
} from "../shared/core/board/state";
import type {
  BoardAssignment,
  BoardExecution,
} from "../shared/core/board/types";
import {
  createBoardAdminTools,
  createBoardDeclareTool,
  toolsForLabels,
} from "../server/board-tools";
import { AgentIndex } from "../server/agent-index";
import { TaskBoardService } from "../server/service";
import { BoardStore } from "../server/store";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "task-board-tools-"));
  process.env.PASEO_HOME = home;
});

afterEach(async () => {
  delete process.env.PASEO_HOME;
  await rm(home, { recursive: true, force: true });
});

const assignment: BoardAssignment = {
  mode: "agent",
  projectId: "prj_1",
  projectName: "Demo",
  projectRoot: "/tmp/demo",
  workspaceId: "wks_1",
  workspaceName: "demo",
  workspaceDirectory: "/tmp/demo",
  agent: { kind: "create", provider: "codex", modeId: "full-access" },
};

function executionFor(agentId: string): BoardExecution {
  return {
    kind: "agent",
    project: {
      projectId: "prj_1",
      projectName: "Demo",
      projectRoot: "/tmp/demo",
    },
    workspace: {
      workspaceId: "wks_1",
      workspaceName: "demo",
      workspaceDirectory: "/tmp/demo",
      created: false,
    },
    agentId,
    agentTitle: "TASK-1",
    provider: "codex",
    model: "gpt",
    agentCreated: true,
    startedAt: "2026-11-13T10:00:00.000Z",
  };
}

function agentSnapshot(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    provider: "codex",
    cwd: "/tmp/demo",
    model: "gpt",
    currentModeId: "full-access",
    status: "running",
    pendingPermissions: [],
    activeTurn: { turnId: "turn-1", startedAt: "2026-11-13T10:00:00.000Z" },
    lastError: null,
    lastUsage: { inputTokens: 10, outputTokens: 5 },
    archivedAt: null,
    background: true,
    title: "child agent",
    labels: {
      "agentstorm.board": "1",
      "agentstorm.board-admin": "1",
      "agentstorm.task-id": "btask_child",
    },
    ...overrides,
  };
}

function fakePaseo(
  options: {
    adminLabels?: Record<string, string>;
    timeline?: unknown[];
    profiles?: unknown[];
    pendingPermissions?: unknown[];
  } = {},
) {
  const calls = {
    send: [] as string[],
    archive: [] as string[],
  };
  const api = {
    agents: {
      ref: (agentId: string) => ({
        id: agentId,
        refresh: async () => ({
          agent: agentSnapshot(agentId, {
            ...(options.adminLabels === undefined
              ? {}
              : { labels: options.adminLabels }),
            ...(options.pendingPermissions === undefined
              ? {}
              : { pendingPermissions: options.pendingPermissions }),
          }),
        }),
        send: async (text: string) => {
          calls.send.push(text);
        },
        waitForFinish: async () => ({
          status: "idle",
          final: null,
          error: null,
          lastMessage: "finished",
        }),
        reload: async () => null,
        archive: async () => {
          calls.archive.push(agentId);
          return { archivedAt: "2026-11-13T10:01:00.000Z" };
        },
        timeline: {
          refetch: async () => ({
            entries: options.timeline ?? [],
            hasOlder: false,
            error: null,
          }),
        },
      }),
      list: async () => ({
        entries: [
          { agent: agentSnapshot("agent_child") },
          { agent: agentSnapshot("agent_admin") },
        ],
      }),
    },
    config: {
      get: async () => ({
        config: {
          daemon: {
            agentProfiles: options.profiles ?? [],
          },
        },
      }),
    },
    projects: {
      list: async () => ({
        projects: [
          {
            projectId: "prj_1",
            projectDisplayName: "Demo",
            projectRootPath: "/tmp/demo",
          },
        ],
      }),
    },
    workspaces: {
      list: async () => ({
        entries: [
          {
            id: "wks_1",
            projectId: "prj_1",
            name: "demo",
            workspaceDirectory: "/tmp/demo",
            projectRootPath: "/tmp/demo",
            archivingAt: null,
          },
        ],
      }),
    },
    providers: {
      listAvailable: async () => ({
        providers: [{ provider: "codex", available: true }],
      }),
      listModels: async () => ({
        models: [
          {
            id: "gpt",
            label: "GPT",
            isDefault: true,
            thinkingOptions: [{ id: "high", label: "High", isDefault: true }],
          },
        ],
        error: null,
      }),
      listModes: async () => ({
        modes: [{ id: "full-access", label: "Full access" }],
        error: null,
      }),
    },
  };
  return { paseo: api as unknown as PaseoApi, calls };
}

function context(
  paseo: PaseoApi,
  labels: Record<string, string> = {
    "agentstorm.board": "1",
    "agentstorm.board-admin": "1",
  },
): AgentToolContext {
  return {
    agent: {
      id: "agent_admin",
      workspaceId: "wks_1",
      parentAgentId: null,
      provider: "codex",
      cwd: "/tmp/demo",
      title: "admin",
      background: true,
      metadata: { labels },
    },
    paseo,
    signal: new AbortController().signal,
  } as unknown as AgentToolContext;
}

async function seedTask(
  service: TaskBoardService,
  store: BoardStore,
  options: {
    title: string;
    kind?: "task" | "task-planning";
    hierarchyParentId?: string | null;
    agentId?: string;
  },
) {
  const task = await service.create({
    title: options.title,
    kind: options.kind,
    hierarchyParentId: options.hierarchyParentId,
  });
  if (options.agentId) {
    await store.transact((document) => {
      const assigned = assignBoardTask(
        document,
        task.id,
        assignment,
        task.revision,
        new Date().toISOString(),
      );
      const started = attachExecution(
        assigned.document,
        task.id,
        executionFor(options.agentId!),
        new Date().toISOString(),
      );
      return { document: started.document, result: null };
    });
  }
  return task;
}

function toolByName(paseo: PaseoApi, service: TaskBoardService, name: string) {
  const def = createBoardAdminTools(service).find(
    (entry) => entry.name === name,
  );
  if (!def) throw new Error(`missing tool ${name}`);
  return async (input: unknown): Promise<AgentToolResult> =>
    await def.execute(input, context(paseo));
}

describe("board tools", () => {
  it("injects the full management surface for admins and only declare for workers", () => {
    const service = {} as TaskBoardService;
    const declare = createBoardDeclareTool(service);
    const admin = createBoardAdminTools(service);
    const adminNames = toolsForLabels(
      { "agentstorm.board": "1", "agentstorm.board-admin": "1" },
      declare,
      admin,
    ).map((entry) => entry.name);
    const workerNames = toolsForLabels(
      { "agentstorm.board": "1" },
      declare,
      admin,
    ).map((entry) => entry.name);

    expect(adminNames).toEqual(
      expect.arrayContaining([
        "board_list",
        "board_status",
        "board_logs",
        "board_create",
        "board_assign",
        "board_start",
        "board_stop",
        "board_send",
        "board_done",
        "board_declare",
      ]),
    );
    expect(workerNames).toEqual(["board_declare"]);
  });

  it("rejects management tools for a non-admin agent", async () => {
    const service = new TaskBoardService(new BoardStore(), new AgentIndex());
    const { paseo } = fakePaseo({
      adminLabels: { "agentstorm.board": "1" },
    });
    const def = createBoardAdminTools(service).find(
      (entry) => entry.name === "board_list",
    )!;
    const result = await def.execute({}, context(paseo));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "E_FORBIDDEN" });
  });

  it("returns readable errors for unknown cards", async () => {
    const service = new TaskBoardService(new BoardStore(), new AgentIndex());
    const { paseo } = fakePaseo();
    const result = await toolByName(
      paseo,
      service,
      "board_get",
    )({
      taskId: "btask_missing",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "E_TASK_NOT_FOUND",
    });
  });

  it("filters list results by hierarchy parent and includes agent state", async () => {
    const store = new BoardStore();
    const service = new TaskBoardService(store, new AgentIndex());
    const { paseo } = fakePaseo();
    const parent = await seedTask(service, store, { title: "Parent" });
    await seedTask(service, store, {
      title: "Child",
      hierarchyParentId: parent.id,
      agentId: "agent_child",
    });

    const result = await toolByName(
      paseo,
      service,
      "board_list",
    )({
      parentId: parent.id,
    });
    const content = result.structuredContent as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(content.tasks).toHaveLength(1);
    expect(content.tasks[0]).toMatchObject({ title: "Child" });
    expect(content.tasks[0]!.agent).toMatchObject({
      agentId: "agent_child",
      lifecycle: "running",
      modeId: "full-access",
    });
  });

  it("reports lifecycle, permissions and usage in board_status", async () => {
    const store = new BoardStore();
    const service = new TaskBoardService(store, new AgentIndex());
    const { paseo } = fakePaseo();
    const task = await seedTask(service, store, {
      title: "Child",
      agentId: "agent_child",
    });
    const result = await toolByName(
      paseo,
      service,
      "board_status",
    )({
      taskId: task.id,
    });
    expect(result.structuredContent).toMatchObject({
      agent: {
        lifecycle: "running",
        modeId: "full-access",
        pendingPermissions: [],
        activeTurn: { turnId: "turn-1" },
        lastError: null,
        lastUsage: { inputTokens: 10, outputTokens: 5 },
        archivedAt: null,
      },
    });
  });

  it("maps assistant, user, tool and error logs without reasoning", async () => {
    const store = new BoardStore();
    const service = new TaskBoardService(store, new AgentIndex());
    const longText = "a".repeat(600);
    const { paseo } = fakePaseo({
      timeline: [
        {
          timestamp: "2026-11-13T10:00:00.000Z",
          item: { type: "assistant_message", text: longText },
        },
        {
          timestamp: "2026-11-13T10:00:01.000Z",
          item: { type: "user_message", text: "do it" },
        },
        {
          timestamp: "2026-11-13T10:00:02.000Z",
          item: { type: "reasoning", text: "hidden chain" },
        },
        {
          timestamp: "2026-11-13T10:00:03.000Z",
          item: {
            type: "tool_call",
            callId: "call-1",
            name: "bash",
            status: "failed",
            error: "command failed",
          },
        },
        {
          timestamp: "2026-11-13T10:00:04.000Z",
          item: { type: "error", message: "turn failed" },
        },
      ],
    });
    const task = await seedTask(service, store, {
      title: "Child",
      agentId: "agent_child",
    });
    const result = await toolByName(
      paseo,
      service,
      "board_logs",
    )({
      taskId: task.id,
      limit: 20,
      filter: "all",
    });
    const entries = (
      result.structuredContent as { entries: Array<Record<string, unknown>> }
    ).entries;
    expect(entries.map((entry) => entry.kind)).toEqual([
      "assistant",
      "user",
      "tool",
      "error",
    ]);
    expect((entries[0]!.text as string).length).toBe(500);
    expect(entries[2]).toMatchObject({
      name: "bash",
      status: "failed",
      error: "command failed",
    });
    expect(JSON.stringify(entries)).not.toContain("hidden chain");
  });

  it("rejects logs for a card without an agent", async () => {
    const service = new TaskBoardService(new BoardStore(), new AgentIndex());
    const { paseo } = fakePaseo();
    const task = await service.create({ title: "Unassigned" });
    const result = await toolByName(
      paseo,
      service,
      "board_logs",
    )({
      taskId: task.id,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "E_NOT_ASSIGNED",
    });
  });

  it("includes live and historical permissions in the permission filter", async () => {
    const store = new BoardStore();
    const service = new TaskBoardService(store, new AgentIndex());
    const { paseo } = fakePaseo({
      pendingPermissions: [
        {
          id: "perm_live",
          kind: "permission",
          name: "bash",
          title: "Run bash",
        },
      ],
    });
    const task = await seedTask(service, store, {
      title: "Child",
      agentId: "agent_child",
    });
    await store.transact((document) => {
      const outcome = applyPermissionBefore(
        document,
        task.id,
        {
          id: "perm_old",
          kind: "permission",
          name: "write",
          title: "Write file",
        },
        new Date().toISOString(),
      );
      return { document: outcome.document, result: null };
    });
    const result = await toolByName(
      paseo,
      service,
      "board_logs",
    )({
      taskId: task.id,
      filter: "permissions",
    });
    const entries = (
      result.structuredContent as {
        entries: Array<{ kind: string; status?: string; text?: string }>;
      }
    ).entries;
    expect(entries.some((entry) => entry.kind === "permission")).toBe(true);
    expect(entries.some((entry) => entry.text === "Run bash")).toBe(true);
    expect(entries.some((entry) => entry.status === "requested")).toBe(true);
  });

  it("resolves agent profiles when assigning", async () => {
    const service = new TaskBoardService(new BoardStore(), new AgentIndex());
    const { paseo } = fakePaseo({
      profiles: [
        {
          id: "profile_1",
          name: "Fast",
          provider: "codex",
          model: "gpt",
          modeId: "full-access",
          thinkingOptionId: "high",
        },
      ],
    });
    const task = await service.create({ title: "Assign me" });
    const result = await toolByName(
      paseo,
      service,
      "board_assign",
    )({
      taskId: task.id,
      projectId: "prj_1",
      workspaceId: "wks_1",
      agent: { kind: "create", profileId: "profile_1" },
      start: false,
    });
    expect(result.isError).toBeUndefined();
    const assigned = await service.get(task.id);
    expect(assigned.assignment?.agent).toMatchObject({
      kind: "create",
      provider: "codex",
      model: "gpt",
      modeId: "full-access",
      thinkingOptionId: "high",
      title: "Fast",
    });
  });

  it("reports a missing profile", async () => {
    const service = new TaskBoardService(new BoardStore(), new AgentIndex());
    const { paseo } = fakePaseo();
    const task = await service.create({ title: "Assign me" });
    const result = await toolByName(
      paseo,
      service,
      "board_assign",
    )({
      taskId: task.id,
      projectId: "prj_1",
      workspaceId: "wks_1",
      agent: { kind: "create", profileId: "missing" },
      start: false,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "E_PROFILE_NOT_FOUND",
    });
  });

  it("sends messages and waits for the child turn", async () => {
    const store = new BoardStore();
    const service = new TaskBoardService(store, new AgentIndex());
    const { paseo, calls } = fakePaseo();
    const task = await seedTask(service, store, {
      title: "Child",
      agentId: "agent_child",
    });
    const result = await toolByName(
      paseo,
      service,
      "board_send",
    )({
      taskId: task.id,
      message: "keep going",
      waitSeconds: 10,
    });
    expect(calls.send).toEqual(["keep going"]);
    expect(result.structuredContent).toMatchObject({
      wait: { status: "idle", lastMessage: "finished" },
    });
  });

  it("waits for review and completes a card", async () => {
    const store = new BoardStore();
    const service = new TaskBoardService(store, new AgentIndex());
    const { paseo } = fakePaseo();
    const task = await seedTask(service, store, {
      title: "Child",
      agentId: "agent_child",
    });
    const current = await service.get(task.id);
    await service.setStatus(paseo, task.id, "in_review", current.revision);

    const waited = await toolByName(
      paseo,
      service,
      "board_wait",
    )({
      taskId: task.id,
      until: ["review"],
      timeoutMs: 1_000,
    });
    expect(waited.structuredContent).toMatchObject({ reached: "review" });

    const done = await toolByName(
      paseo,
      service,
      "board_done",
    )({
      taskId: task.id,
    });
    expect(done.isError).toBeUndefined();
    expect((await service.get(task.id)).status).toBe("done");
  });

  it("caps send and wait durations", () => {
    const service = {} as TaskBoardService;
    const tools = createBoardAdminTools(service);
    const send = tools.find((entry) => entry.name === "board_send")!;
    const wait = tools.find((entry) => entry.name === "board_wait")!;
    expect(
      send.input.safeParse({
        taskId: "btask_1",
        message: "hi",
        waitSeconds: 301,
      }).success,
    ).toBe(false);
    expect(
      wait.input.safeParse({ taskId: "btask_1", timeoutMs: 120_001 }).success,
    ).toBe(false);
  });

  it("reports NO_BOUND_TASK when declaration is not bound", async () => {
    const service = new TaskBoardService(new BoardStore(), new AgentIndex());
    const { paseo } = fakePaseo();
    const task = await service.create({ title: "Unbound" });
    const declare = createBoardDeclareTool(service);
    const result = await declare.execute(
      { kind: "progress", summary: "working" },
      context(paseo),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "NO_BOUND_TASK",
    });
    expect(task.id).toBeTruthy();
  });

  it("declares progress for a bound worker", async () => {
    const store = new BoardStore();
    const service = new TaskBoardService(store, new AgentIndex());
    const { paseo } = fakePaseo();
    const task = await seedTask(service, store, {
      title: "Child",
      agentId: "agent_child",
    });
    const declare = createBoardDeclareTool(service);
    const result = await declare.execute(
      { kind: "progress", summary: "halfway" },
      {
        ...context(paseo),
        agent: { ...context(paseo).agent, id: "agent_child" },
      } as AgentToolContext,
    );
    expect(result.isError).toBeUndefined();
    expect((await service.get(task.id)).progress?.summary).toBe("halfway");
  });

  it("creates planning children with the planning kind", async () => {
    const service = new TaskBoardService(new BoardStore(), new AgentIndex());
    const { paseo } = fakePaseo();
    const result = await toolByName(
      paseo,
      service,
      "board_create",
    )({
      title: "Plan",
      kind: "task-planning",
    });
    expect(result.structuredContent).toMatchObject({
      task: { kind: "task-planning", status: "planning" },
    });
  });

  it("reads board events and provider catalogs", async () => {
    const store = new BoardStore();
    const service = new TaskBoardService(store, new AgentIndex());
    const { paseo } = fakePaseo();
    const task = await seedTask(service, store, {
      title: "Child",
      agentId: "agent_child",
    });
    await service.create({ title: "event source" });

    const events = await toolByName(
      paseo,
      service,
      "board_events",
    )({
      taskId: task.id,
      limit: 10,
    });
    const eventEntries = (
      events.structuredContent as {
        events: Array<{ kind: string; taskId?: string }>;
      }
    ).events;
    expect(eventEntries.length).toBeGreaterThanOrEqual(1);
    expect(eventEntries.at(-1)?.kind).toBe("created");

    const providers = await toolByName(
      paseo,
      service,
      "board_providers",
    )({
      provider: "codex",
    });
    expect(providers.structuredContent).toMatchObject({
      catalog: { provider: "codex" },
    });
  });
});
