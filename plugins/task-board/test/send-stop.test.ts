import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { createBoardTask } from "../shared/core/board/state";
import type {
  BoardAssignment,
  BoardExecution,
  BoardStatus,
} from "../shared/core/board/types";
import { AgentIndex } from "../server/agent-index";
import { TaskBoardService } from "../server/service";
import { BoardStore, readEvents } from "../server/store";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "task-board-send-stop-"));
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
  agent: { kind: "existing", agentId: "agent_1" },
};

const execution: BoardExecution = {
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
  agentId: "agent_1",
  agentTitle: "TASK-1",
  provider: "codex",
  model: null,
  agentCreated: false,
  startedAt: "2026-11-13T10:00:00.000Z",
};

interface FakeQuestion {
  header: string;
  question: string;
  options?: Array<{ label: string }>;
  allowOther?: boolean;
  isOther?: boolean;
  multiSelect?: boolean;
}

interface FakePermission {
  id: string;
  provider: string;
  name: string;
  kind: string;
  title: string;
  input?: { questions?: FakeQuestion[] };
}

interface FakeAgentState {
  status: "running" | "idle";
  activeTurn: { turnId: string; startedAt: string } | null;
  pendingPermissions: FakePermission[];
  provider?: string;
  cancelError?: Error;
  cancelKeepsRunning?: boolean;
  cancelDelayMs?: number;
  respondError?: Error;
  respondKeepsPending?: boolean;
}

function fakePaseo(state: FakeAgentState) {
  const calls = {
    send: [] as string[],
    cancel: [] as string[],
    reload: [] as string[],
    respond: [] as Array<{
      requestId: string;
      response: {
        behavior: string;
        updatedInput?: { answers?: Record<string, string> };
      };
    }>,
  };
  const snapshot = () => ({
    id: "agent_1",
    provider: state.provider ?? "codex",
    status: state.status,
    pendingPermissions: state.pendingPermissions,
    activeTurn: state.activeTurn,
    archivedAt: null,
  });
  const handle = {
    id: "agent_1",
    current: () => snapshot(),
    refresh: async () => ({ agent: snapshot() }),
    send: async (text: string) => {
      calls.send.push(text);
      state.status = "running";
      state.activeTurn = {
        turnId: "turn-2",
        startedAt: new Date().toISOString(),
      };
      state.pendingPermissions = [];
    },
    respondToPermission: async ({
      requestId,
      response,
    }: {
      requestId: string;
      response: {
        behavior: string;
        updatedInput?: { answers?: Record<string, string> };
      };
    }) => {
      calls.respond.push({ requestId, response });
      if (state.respondError) throw state.respondError;
      if (!state.respondKeepsPending) {
        state.pendingPermissions = state.pendingPermissions.filter(
          (request) => request.id !== requestId,
        );
        state.status = "running";
        state.activeTurn ??= {
          turnId: "turn-1",
          startedAt: new Date().toISOString(),
        };
      }
    },
    reload: async () => {
      calls.reload.push("agent_1");
      return { agent: snapshot() };
    },
    waitForFinish: async () => ({ status: "idle" }),
  };
  const paseo = {
    agents: {
      ref: () => handle,
    },
  } as unknown as PaseoApi;
  return { paseo, calls, state };
}

function fakeCanceller(state: FakeAgentState, calls: { cancel: string[] }) {
  return async (agentId: string) => {
    calls.cancel.push(agentId);
    if (state.cancelDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, state.cancelDelayMs));
    }
    if (state.cancelError) throw state.cancelError;
    if (!state.cancelKeepsRunning) {
      state.status = "idle";
      state.activeTurn = null;
      state.pendingPermissions = [];
    }
  };
}

async function seedTask(
  store: BoardStore,
  options: {
    status: BoardStatus;
    blockReason?: "question" | "manual";
    pendingRequestId?: string;
  },
) {
  const now = "2026-11-13T10:00:00.000Z";
  return store.transact((document) => {
    const created = createBoardTask(
      document,
      {
        title: "Send and stop",
        status: options.status,
        assignment,
      },
      { id: "btask_send_stop", now },
    );
    const task = created.document.tasks.find(
      (entry) => entry.id === "btask_send_stop",
    );
    if (!task) throw new Error("seed task missing");
    task.execution = execution;
    if (options.blockReason) task.blockReason = options.blockReason;
    if (options.pendingRequestId) {
      task.pendingPermission = {
        requestId: options.pendingRequestId,
        kind: "question",
        title: "Pick a branch",
        at: now,
      };
    }
    return { document: created.document, result: task };
  });
}

function questionRequest(
  options: {
    provider?: string;
    id?: string;
    kind?: string;
    questions?: FakeQuestion[];
  } = {},
): FakePermission {
  return {
    id: options.id ?? "permission-question-1",
    provider: options.provider ?? "codex",
    name: "request_user_input_async",
    kind: options.kind ?? "question",
    title: "Question",
    input: {
      questions: options.questions ?? [
        { header: "Question 1", question: "Branch?" },
      ],
    },
  };
}

function serviceFor(
  store: BoardStore,
  state: FakeAgentState,
  calls: { cancel: string[] },
  fallbackTimeoutMs = 15_000,
) {
  return new TaskBoardService(
    store,
    new AgentIndex(),
    undefined,
    undefined,
    fakeCanceller(state, calls),
    fallbackTimeoutMs,
  );
}

async function blockedQuestion(
  request: FakePermission,
  state: Partial<FakeAgentState> = {},
) {
  const store = new BoardStore();
  await seedTask(store, {
    status: "blocked",
    blockReason: "question",
    pendingRequestId: request.id,
  });
  const fake = fakePaseo({
    status: "running",
    activeTurn: {
      turnId: "turn-1",
      startedAt: "2026-11-13T10:00:00.000Z",
    },
    pendingPermissions: [request],
    provider: request.provider,
    ...state,
  });
  return { store, ...fake };
}

describe("send answers a pending question before cancelling", () => {
  it("codex uses Question N keys, does not cancel, and restores in_progress", async () => {
    const request = questionRequest();
    const { store, paseo, calls, state } = await blockedQuestion(request);
    const service = serviceFor(store, state, calls);

    const result = await service.sendMessage(
      paseo,
      "btask_send_stop",
      "Use the dev branch",
    );

    expect(calls.respond).toHaveLength(1);
    expect(calls.respond[0]?.requestId).toBe(request.id);
    expect(calls.respond[0]?.response.updatedInput?.answers).toEqual({
      "Question 1": "Use the dev branch",
    });
    expect(calls.cancel).toEqual([]);
    expect(calls.send).toEqual([]);
    expect(result.answered).toBe(true);
    expect(result.interrupted).toBe(false);
    expect(result.task.status).toBe("in_progress");
    expect(result.task.blockReason).toBeUndefined();
    const events = await readEvents({ limit: 50, taskId: "btask_send_stop" });
    expect(events.some((event) => event.kind === "answered")).toBe(true);
  });

  it("claude keys by the full question text", async () => {
    const request = questionRequest({
      provider: "claude",
      questions: [{ header: "Branch", question: "Which branch?" }],
    });
    const { store, paseo, calls, state } = await blockedQuestion(request);
    const service = serviceFor(store, state, calls);

    await service.sendMessage(paseo, "btask_send_stop", "dev");

    expect(calls.respond[0]?.response.updatedInput?.answers).toEqual({
      "Which branch?": "dev",
    });
    expect(calls.cancel).toEqual([]);
  });

  it("pi keys by the header and never cancels first", async () => {
    const request = questionRequest({
      provider: "pi",
      questions: [{ header: "Branch", question: "Which branch?" }],
    });
    const { store, paseo, calls, state } = await blockedQuestion(request);
    const service = serviceFor(store, state, calls);

    await service.sendMessage(paseo, "btask_send_stop", "dev");

    expect(calls.respond[0]?.response.updatedInput?.answers).toEqual({
      Branch: "dev",
    });
    expect(calls.cancel).toEqual([]);
    expect(calls.send).toEqual([]);
  });

  it("codex splits a multi-question answer by line", async () => {
    const request = questionRequest({
      questions: [
        { header: "Question 1", question: "Branch?" },
        { header: "Question 2", question: "Command?" },
      ],
    });
    const { store, paseo, calls, state } = await blockedQuestion(request);
    const service = serviceFor(store, state, calls);

    await service.sendMessage(paseo, "btask_send_stop", "dev\nrun tests");

    expect(calls.respond[0]?.response.updatedInput?.answers).toEqual({
      "Question 1": "dev",
      "Question 2": "run tests",
    });
    expect(calls.cancel).toEqual([]);
  });

  it("claude splits a multi-question answer by paragraph", async () => {
    const request = questionRequest({
      provider: "claude",
      questions: [
        { header: "Branch", question: "Which branch?" },
        { header: "Command", question: "Which command?" },
      ],
    });
    const { store, paseo, calls, state } = await blockedQuestion(request);
    const service = serviceFor(store, state, calls);

    await service.sendMessage(paseo, "btask_send_stop", "dev\n\nrun tests");

    expect(calls.respond[0]?.response.updatedInput?.answers).toEqual({
      "Which branch?": "dev",
      "Which command?": "run tests",
    });
    expect(calls.cancel).toEqual([]);
  });

  it("accepts an exact option when freeform is disabled", async () => {
    const request = questionRequest({
      questions: [
        {
          header: "Mode",
          question: "Pick a mode",
          options: [{ label: "safe" }, { label: "fast" }],
          allowOther: false,
        },
      ],
    });
    const { store, paseo, calls, state } = await blockedQuestion(request);
    const service = serviceFor(store, state, calls);

    await service.sendMessage(paseo, "btask_send_stop", "fast");

    expect(calls.respond[0]?.response.updatedInput?.answers).toEqual({
      "Question 1": "fast",
    });
    expect(calls.cancel).toEqual([]);
  });

  it("pi joins multi-select labels with a comma and space", async () => {
    const request = questionRequest({
      provider: "pi",
      questions: [
        {
          header: "Tags",
          question: "Pick tags",
          options: [{ label: "api" }, { label: "ui" }],
          multiSelect: true,
          allowOther: true,
        },
      ],
    });
    const { store, paseo, calls, state } = await blockedQuestion(request);
    const service = serviceFor(store, state, calls);

    await service.sendMessage(paseo, "btask_send_stop", "api,ui");

    expect(calls.respond[0]?.response.updatedInput?.answers).toEqual({
      Tags: "api, ui",
    });
    expect(calls.cancel).toEqual([]);
  });
});

describe("send falls back to one cancel plus polling", () => {
  it("cannot split a multi-question message: cancel once, poll, then send", async () => {
    const request = questionRequest({
      questions: [
        { header: "Question 1", question: "Branch?" },
        { header: "Question 2", question: "Command?" },
      ],
    });
    const { store, paseo, calls, state } = await blockedQuestion(request, {
      cancelDelayMs: 20,
    });
    const service = serviceFor(store, state, calls, 500);

    const result = await service.sendMessage(
      paseo,
      "btask_send_stop",
      "only one line",
    );

    expect(calls.cancel).toEqual(["agent_1"]);
    expect(calls.send).toEqual(["only one line"]);
    expect(calls.respond).toEqual([]);
    expect(result.interrupted).toBe(true);
    expect(result.answered).toBe(false);
    expect(result.task.status).toBe("in_progress");
    const events = await readEvents({ limit: 50, taskId: "btask_send_stop" });
    expect(events.some((event) => event.kind === "answer_failed")).toBe(true);
  });

  it("an option mismatch falls back to cancel plus send", async () => {
    const request = questionRequest({
      questions: [
        {
          header: "Mode",
          question: "Pick a mode",
          options: [{ label: "safe" }, { label: "fast" }],
          allowOther: false,
        },
      ],
    });
    const { store, paseo, calls, state } = await blockedQuestion(request, {
      cancelDelayMs: 10,
    });
    const service = serviceFor(store, state, calls, 500);

    const result = await service.sendMessage(
      paseo,
      "btask_send_stop",
      "unsupported choice",
    );

    expect(calls.cancel).toEqual(["agent_1"]);
    expect(calls.send).toEqual(["unsupported choice"]);
    expect(calls.respond).toEqual([]);
    expect(result.interrupted).toBe(true);
  });

  it("an unknown provider falls back to cancel plus send", async () => {
    const request = questionRequest({ provider: "other" });
    const { store, paseo, calls, state } = await blockedQuestion(request, {
      cancelDelayMs: 10,
    });
    const service = serviceFor(store, state, calls, 500);

    await service.sendMessage(paseo, "btask_send_stop", "dev");

    expect(calls.cancel).toEqual(["agent_1"]);
    expect(calls.send).toEqual(["dev"]);
    expect(calls.respond).toEqual([]);
  });

  it("multiple pending permissions fall back to cancel plus send", async () => {
    const request = questionRequest();
    const tool: FakePermission = {
      id: "permission-tool-1",
      provider: "codex",
      name: "Bash",
      kind: "tool",
      title: "Run command",
    };
    const store = new BoardStore();
    await seedTask(store, {
      status: "blocked",
      blockReason: "question",
      pendingRequestId: request.id,
    });
    const { paseo, calls, state } = fakePaseo({
      status: "running",
      activeTurn: {
        turnId: "turn-1",
        startedAt: "2026-11-13T10:00:00.000Z",
      },
      pendingPermissions: [request, tool],
      cancelDelayMs: 10,
    });
    const service = serviceFor(store, state, calls, 500);

    await service.sendMessage(paseo, "btask_send_stop", "dev");

    expect(calls.cancel).toEqual(["agent_1"]);
    expect(calls.send).toEqual(["dev"]);
    expect(calls.respond).toEqual([]);
  });

  it("respondToPermission failure falls back to cancel plus send", async () => {
    const request = questionRequest();
    const { store, paseo, calls, state } = await blockedQuestion(request, {
      respondError: new Error("question answer rejected"),
      cancelDelayMs: 10,
    });
    const service = serviceFor(store, state, calls, 500);

    await service.sendMessage(paseo, "btask_send_stop", "dev");

    expect(calls.respond).toHaveLength(1);
    expect(calls.cancel).toEqual(["agent_1"]);
    expect(calls.send).toEqual(["dev"]);
  });

  it("cancel is sent once and polling stops at the fallback timeout", async () => {
    const request = questionRequest({
      questions: [
        { header: "Question 1", question: "Branch?" },
        { header: "Question 2", question: "Command?" },
      ],
    });
    const { store, paseo, calls, state } = await blockedQuestion(request, {
      cancelKeepsRunning: true,
    });
    const service = serviceFor(store, state, calls, 50);

    await expect(
      service.sendMessage(paseo, "btask_send_stop", "only one line"),
    ).rejects.toMatchObject({
      code: "E_AGENT_BLOCKED",
      message: expect.stringContaining("Cannot interrupt agent"),
    });

    expect(calls.cancel).toEqual(["agent_1"]);
    expect(calls.send).toEqual([]);
    const task = await service.get("btask_send_stop");
    expect(task.status).toBe("blocked");
    expect(task.blockReason).toBe("manual");
    const events = await readEvents({ limit: 50, taskId: "btask_send_stop" });
    expect(events.some((event) => event.kind === "stop_failed")).toBe(true);
    expect(events.some((event) => event.kind === "stopped")).toBe(false);
  });

  it("send does not cancel when the agent has no active turn", async () => {
    const store = new BoardStore();
    await seedTask(store, { status: "in_progress" });
    const { paseo, calls, state } = fakePaseo({
      status: "idle",
      activeTurn: null,
      pendingPermissions: [],
    });
    const service = serviceFor(store, state, calls);

    const result = await service.sendMessage(
      paseo,
      "btask_send_stop",
      "Continue",
    );

    expect(calls.cancel).toEqual([]);
    expect(calls.respond).toEqual([]);
    expect(calls.send).toEqual(["Continue"]);
    expect(result.interrupted).toBe(false);
    expect(result.answered).toBe(false);
    expect(result.task.status).toBe("in_progress");
  });
});

describe("stop", () => {
  it("calls cancel, records stopped, and blocks the card as manual", async () => {
    const store = new BoardStore();
    await seedTask(store, { status: "in_progress" });
    const { paseo, calls, state } = fakePaseo({
      status: "running",
      activeTurn: {
        turnId: "turn-1",
        startedAt: "2026-11-13T10:00:00.000Z",
      },
      pendingPermissions: [questionRequest()],
    });
    const service = serviceFor(store, state, calls);

    const task = await service.stop(paseo, "btask_send_stop");

    expect(calls.cancel).toEqual(["agent_1"]);
    expect(task.status).toBe("blocked");
    expect(task.blockReason).toBe("manual");
    const events = await readEvents({ limit: 50, taskId: "btask_send_stop" });
    expect(events.some((event) => event.kind === "stopped")).toBe(true);
  });

  it("reports a refusal without writing a stopped event", async () => {
    const store = new BoardStore();
    await seedTask(store, { status: "in_progress" });
    const { paseo, calls, state } = fakePaseo({
      status: "running",
      activeTurn: {
        turnId: "turn-1",
        startedAt: "2026-11-13T10:00:00.000Z",
      },
      pendingPermissions: [questionRequest()],
      cancelError: new Error(
        "Cannot stop agent agent_1 because its active run cancellation was not acknowledged",
      ),
    });
    const service = serviceFor(store, state, calls);

    await expect(service.stop(paseo, "btask_send_stop")).rejects.toMatchObject({
      code: "E_AGENT_BLOCKED",
      message: expect.stringContaining("waiting for an answer"),
    });

    const task = await service.get("btask_send_stop");
    expect(task.status).toBe("blocked");
    expect(task.blockReason).toBe("manual");
    const events = await readEvents({ limit: 50, taskId: "btask_send_stop" });
    expect(events.some((event) => event.kind === "stopped")).toBe(false);
    expect(events.some((event) => event.kind === "stop_failed")).toBe(true);
  });
});
