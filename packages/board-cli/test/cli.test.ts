import { describe, expect, it } from "vitest";
import { runCli, type CliDeps, type CliIO } from "../src/cli.js";
import type { BoardRpcClient } from "../src/client.js";
import { ConnectionError } from "../src/errors.js";
import type {
  BoardTask,
  Candidates,
  StatusResult,
  TaskSummary,
} from "../src/types.js";

const baseTask: BoardTask = {
  id: "btask_1",
  displayId: "TASK-1",
  title: "First task",
  kind: "task",
  status: "todo",
  priority: "high",
  labels: [],
  projectId: null,
  hierarchyParentId: null,
  revision: 3,
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:05:00.000Z",
  execution: {
    kind: "agent",
    agentId: "agent-1",
    agentTitle: "TASK-1",
    provider: "codex",
    model: "gpt",
    agentCreated: true,
    startedAt: "2026-11-13T10:00:00.000Z",
    lastLifecycle: "running",
    project: {
      projectId: "prj_1",
      projectName: "Demo",
      projectRoot: "/tmp/demo",
    },
    workspace: {
      workspaceId: "wks_1",
      workspaceName: "main",
      workspaceDirectory: "/tmp/demo",
      created: false,
    },
  },
  activity: [],
};

const parentTask: BoardTask = {
  ...baseTask,
  id: "btask_parent",
  displayId: "TASK-0",
  title: "Parent task",
  execution: null,
};

type Handler = (input: unknown) => unknown;

function fakeClient(handlers: Record<string, Handler> = {}) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const client: BoardRpcClient = {
    async call(method, input) {
      calls.push({ method, input });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected method ${method}`);
      return handler(input);
    },
    async close() {},
  };
  return { client, calls };
}

function defaultHandlers(): Record<string, Handler> {
  return {
    "task-board.list": () => ({
      tasks: [baseTask, parentTask],
      counts: { todo: 1 },
    }),
    "task-board.get": () => ({ task: baseTask }),
    "task-board.list-summary": () => ({
      tasks: [summaryOf(baseTask)],
      total: 1,
      counts: { todo: 1 },
    }),
    "task-board.status": () => ({
      task: summaryOf(baseTask),
      agent: null,
      recentActivity: [],
    }),
  };
}

function summaryOf(task: BoardTask): TaskSummary {
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
    agent: null,
  };
}

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const value: CliIO = {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    isTTY: false,
    columns: 100,
  };
  return {
    io: value,
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

async function run(
  args: string[],
  handlers: Record<string, Handler> = defaultHandlers(),
) {
  const { client, calls } = fakeClient(handlers);
  const output = io();
  const deps: CliDeps = {
    createClient: async () => client,
    env: { PASEO_BOARD_PASSWORD: "secret" },
  };
  const code = await runCli(
    ["--url", "http://127.0.0.1:6767", ...args],
    output.io,
    deps,
  );
  return { code, ...output, calls };
}

describe("paseo-board CLI", () => {
  it("lists tasks as parseable JSON", async () => {
    const result = await run(["list", "--status", "todo", "--json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout()) as {
      tasks: TaskSummary[];
      total: number;
      counts: Record<string, number>;
    };
    expect(parsed.tasks[0]?.displayId).toBe("TASK-1");
    expect(parsed.total).toBe(1);
    expect(parsed.counts).toEqual({ todo: 1 });
    expect(result.calls).toContainEqual({
      method: "task-board.list-summary",
      input: { includeFinished: true, status: "todo", limit: 50 },
    });
  });

  it("resolves a display id and forwards the status tail", async () => {
    const status: StatusResult = {
      task: {
        ...baseTask,
        parentTaskId: null,
        blockReason: null,
        blockDetail: null,
        progress: null,
        declaration: null,
        execution: {
          agentId: "agent-1",
          agentTitle: "TASK-1",
          provider: "codex",
          model: "gpt",
          lastLifecycle: "running",
          startedAt: "2026-11-13T10:00:00.000Z",
        },
        agent: {
          agentId: "agent-1",
          title: "TASK-1",
          lifecycle: "running",
          provider: "codex",
          model: "gpt",
          modeId: "full-access",
          workspaceId: "wks_1",
          pendingPermissions: [],
          activeTurn: { turnId: "turn-1", startedAt: null },
          lastError: null,
          lastUsage: null,
          archivedAt: null,
          background: true,
        },
      },
      agent: null,
      recentActivity: ["a", "b"],
    };
    const result = await run(["status", "TASK-1", "--tail", "7", "--json"], {
      ...defaultHandlers(),
      "task-board.status": () => status,
    });
    expect(result.code).toBe(0);
    expect(result.calls).toContainEqual({
      method: "task-board.status",
      input: { taskId: "btask_1", tail: 7 },
    });
    const parsed = JSON.parse(result.stdout()) as StatusResult;
    expect(parsed.task.title).toBe("First task");
    expect(parsed.recentActivity).toEqual(["a", "b"]);
  });

  it("passes log tail and filter through", async () => {
    const result = await run(
      ["logs", "TASK-1", "--tail", "3", "--filter", "tools", "--json"],
      {
        ...defaultHandlers(),
        "task-board.logs": () => ({
          taskId: "btask_1",
          agentId: "agent-1",
          filter: "tools",
          entries: [],
          hasOlder: false,
          error: null,
        }),
      },
    );
    expect(result.code).toBe(0);
    expect(result.calls).toContainEqual({
      method: "task-board.logs",
      input: { taskId: "btask_1", limit: 3, filter: "tools" },
    });
  });

  it("creates a planning child with repeated acceptance criteria", async () => {
    const result = await run(
      [
        "create",
        "Child",
        "--kind",
        "task-planning",
        "--parent",
        "TASK-0",
        "--acceptance",
        "one",
        "--acceptance",
        "two",
        "--json",
      ],
      {
        ...defaultHandlers(),
        "task-board.create": () => ({
          task: { ...baseTask, displayId: "TASK-2" },
        }),
      },
    );
    expect(result.code).toBe(0);
    expect(result.calls).toContainEqual({
      method: "task-board.create",
      input: {
        title: "Child",
        acceptanceCriteria: ["one", "two"],
        kind: "task-planning",
        hierarchyParentId: "btask_parent",
      },
    });
  });

  it("updates status with the current revision", async () => {
    const result = await run(
      ["update", "TASK-1", "--status", "done", "--json"],
      {
        ...defaultHandlers(),
        "task-board.set-status": () => ({
          task: { ...baseTask, status: "done", revision: 4 },
        }),
      },
    );
    expect(result.code).toBe(0);
    expect(result.calls).toContainEqual({
      method: "task-board.set-status",
      input: { taskId: "btask_1", expectedRevision: 3, status: "done" },
    });
  });

  it("maps a profile name onto assign fields", async () => {
    const candidates: Candidates = {
      projects: [
        {
          projectId: "prj_1",
          name: "Demo",
          rootPath: "/tmp/demo",
          workspaces: [
            {
              workspaceId: "wks_1",
              name: "main",
              directory: "/tmp/demo",
              kind: "worktree",
              background: false,
            },
          ],
          agents: [],
        },
      ],
      profiles: [
        {
          id: "profile-1",
          name: "搬砖工",
          provider: "codex",
          model: "gpt",
          modeId: "full-access",
          thinkingOptionId: "high",
        },
      ],
      providers: [],
    };
    const result = await run(
      [
        "assign",
        "TASK-1",
        "--project",
        "Demo",
        "--workspace",
        "main",
        "--profile",
        "搬砖工",
        "--json",
      ],
      {
        ...defaultHandlers(),
        "task-board.candidates": () => candidates,
        "task-board.assign": () => ({ task: baseTask }),
      },
    );
    expect(result.code).toBe(0);
    expect(result.calls).toContainEqual({
      method: "task-board.assign",
      input: {
        taskId: "btask_1",
        expectedRevision: 3,
        projectId: "prj_1",
        workspaceId: "wks_1",
        agent: {
          kind: "create",
          provider: "codex",
          model: "gpt",
          modeId: "full-access",
          thinkingOptionId: "high",
          title: "搬砖工",
        },
        message: undefined,
        start: false,
      },
    });
  });

  it("declares with the bound agent id", async () => {
    const result = await run(
      ["declare", "TASK-1", "review", "--summary", "done", "--json"],
      {
        ...defaultHandlers(),
        "task-board.declare": () => ({
          task: { ...baseTask, status: "in_review" },
          accepted: true,
        }),
      },
    );
    expect(result.code).toBe(0);
    expect(result.calls).toContainEqual({
      method: "task-board.declare",
      input: {
        taskId: "btask_1",
        agentId: "agent-1",
        kind: "review",
        summary: "done",
      },
    });
  });

  it("sends with the default wait cap", async () => {
    const result = await run(["send", "TASK-1", "hello", "--wait", "--json"], {
      ...defaultHandlers(),
      "task-board.send": () => ({
        task: baseTask,
        wait: { status: "idle", lastMessage: "ok", error: null },
      }),
    });
    expect(result.code).toBe(0);
    expect(result.calls).toContainEqual({
      method: "task-board.send",
      input: { taskId: "btask_1", message: "hello", waitSeconds: 300 },
    });
  });

  it("converts wait seconds to milliseconds", async () => {
    const result = await run(
      ["wait", "TASK-1", "--until", "review,idle", "--timeout", "7", "--json"],
      {
        ...defaultHandlers(),
        "task-board.wait": () => ({
          reached: "review",
          task: baseTask,
          agent: null,
        }),
      },
    );
    expect(result.code).toBe(0);
    expect(result.calls).toContainEqual({
      method: "task-board.wait",
      input: {
        taskId: "btask_1",
        until: ["review", "idle"],
        timeoutMs: 7_000,
      },
    });
  });

  it("reports a missing task with exit code 1", async () => {
    const result = await run(["show", "TASK-999", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain("Task not found: TASK-999");
    expect(result.stdout()).toBe("");
  });

  it("reports usage errors with exit code 2", async () => {
    const unknown = await run(["list", "--bogus"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr()).toContain("Unknown option: --bogus");

    const missing = await run(["create"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr()).toContain("Missing title");
  });

  it("reports connection errors with exit code 3", async () => {
    const output = io();
    const code = await runCli(
      ["--url", "http://127.0.0.1:6767", "list"],
      output.io,
      {
        createClient: async () => {
          throw new ConnectionError("Cannot connect to Paseo daemon");
        },
        env: {},
      },
    );
    expect(code).toBe(3);
    expect(output.stderr()).toContain("Cannot connect to Paseo daemon");
  });
});
