import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { BoardError } from "../shared/core/board/errors";
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

interface FakeAgentState {
  status: "running" | "idle";
  activeTurn: { turnId: string; startedAt: string } | null;
  pendingPermissions: Array<{
    id: string;
    provider: string;
    name: string;
    kind: string;
    title: string;
  }>;
  cancelError?: Error;
  cancelKeepsRunning?: boolean;
}

function fakePaseo(state: FakeAgentState) {
  const calls = {
    send: [] as string[],
    cancel: [] as string[],
    reload: [] as string[],
    refresh: 0,
  };
  const snapshot = () => ({
    id: "agent_1",
    provider: "codex",
    status: state.status,
    pendingPermissions: state.pendingPermissions,
    activeTurn: state.activeTurn,
    archivedAt: null,
  });
  const handle = {
    id: "agent_1",
    current: () => snapshot(),
    refresh: async () => {
      calls.refresh += 1;
      return { agent: snapshot() };
    },
    send: async (text: string) => {
      calls.send.push(text);
      state.status = "running";
      state.activeTurn = {
        turnId: "turn-2",
        startedAt: new Date().toISOString(),
      };
      state.pendingPermissions = [];
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

function questionRequest() {
  return {
    id: "permission-question-1",
    provider: "codex",
    name: "request_user_input_async",
    kind: "question",
    title: "Question",
    input: {
      questions: [{ id: "0", header: "Question 1", question: "Branch?" }],
    },
  };
}

describe("send and stop against a blocked agent", () => {
  it("send interrupts a pending question, sends the message, and restores in_progress", async () => {
    const store = new BoardStore();
    await seedTask(store, {
      status: "blocked",
      blockReason: "question",
      pendingRequestId: "permission-question-1",
    });
    const { paseo, calls, state } = fakePaseo({
      status: "running",
      activeTurn: {
        turnId: "turn-1",
        startedAt: "2026-11-13T10:00:00.000Z",
      },
      pendingPermissions: [questionRequest()],
    });
    const service = new TaskBoardService(
      store,
      new AgentIndex(),
      undefined,
      undefined,
      fakeCanceller(state, calls),
    );

    const result = await service.sendMessage(
      paseo,
      "btask_send_stop",
      "Use the dev branch",
    );

    expect(calls.cancel).toEqual(["agent_1"]);
    expect(calls.reload).toEqual([]);
    expect(calls.send).toEqual(["Use the dev branch"]);
    expect(state.pendingPermissions).toEqual([]);
    expect(result.interrupted).toBe(true);
    expect(result.task.status).toBe("in_progress");
    expect(result.task.blockReason).toBeUndefined();
    expect(result.task.pendingPermission).toBeUndefined();
    const events = await readEvents({
      limit: 50,
      taskId: "btask_send_stop",
    });
    expect(events.some((event) => event.kind === "sent")).toBe(true);
  });

  it("send returns a readable error and does not send when cancel is refused", async () => {
    const store = new BoardStore();
    await seedTask(store, {
      status: "blocked",
      blockReason: "question",
      pendingRequestId: "permission-question-1",
    });
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
    const service = new TaskBoardService(
      store,
      new AgentIndex(),
      undefined,
      undefined,
      fakeCanceller(state, calls),
    );

    let failure: unknown;
    try {
      await service.sendMessage(paseo, "btask_send_stop", "Use the dev branch");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(BoardError);
    const boardError = failure as BoardError;
    expect(boardError.code).toBe("E_AGENT_BLOCKED");
    expect(boardError.message).toContain("waiting for an answer");
    expect(boardError.message).not.toContain(
      "cancellation was not acknowledged",
    );
    expect(calls.send).toEqual([]);

    const task = await service.get("btask_send_stop");
    expect(task.status).toBe("blocked");
    expect(task.blockReason).toBe("manual");
    expect(task.blockDetail).toContain("waiting for an answer");
    const events = await readEvents({
      limit: 50,
      taskId: "btask_send_stop",
    });
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
    const service = new TaskBoardService(
      store,
      new AgentIndex(),
      undefined,
      undefined,
      fakeCanceller(state, calls),
    );

    const result = await service.sendMessage(
      paseo,
      "btask_send_stop",
      "Continue",
    );

    expect(calls.cancel).toEqual([]);
    expect(calls.reload).toEqual([]);
    expect(calls.send).toEqual(["Continue"]);
    expect(result.interrupted).toBe(false);
    expect(result.task.status).toBe("in_progress");
  });

  it("stop calls cancel, records stopped, and blocks the card as manual", async () => {
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
    const service = new TaskBoardService(
      store,
      new AgentIndex(),
      undefined,
      undefined,
      fakeCanceller(state, calls),
    );

    const task = await service.stop(paseo, "btask_send_stop");

    expect(calls.cancel).toEqual(["agent_1"]);
    expect(calls.reload).toEqual([]);
    expect(task.status).toBe("blocked");
    expect(task.blockReason).toBe("manual");
    const events = await readEvents({
      limit: 50,
      taskId: "btask_send_stop",
    });
    expect(events.some((event) => event.kind === "stopped")).toBe(true);
  });

  it("stop reports a refusal without writing a stopped event", async () => {
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
    const service = new TaskBoardService(
      store,
      new AgentIndex(),
      undefined,
      undefined,
      fakeCanceller(state, calls),
    );

    await expect(service.stop(paseo, "btask_send_stop")).rejects.toMatchObject({
      code: "E_AGENT_BLOCKED",
      message: expect.stringContaining("waiting for an answer"),
    });

    const task = await service.get("btask_send_stop");
    expect(task.status).toBe("blocked");
    expect(task.blockReason).toBe("manual");
    expect(task.blockDetail).toContain("waiting for an answer");
    const events = await readEvents({
      limit: 50,
      taskId: "btask_send_stop",
    });
    expect(events.some((event) => event.kind === "stopped")).toBe(false);
    expect(events.some((event) => event.kind === "stop_failed")).toBe(true);
  });

  it("send refuses to continue when cancel leaves the agent running", async () => {
    const store = new BoardStore();
    await seedTask(store, {
      status: "blocked",
      blockReason: "question",
      pendingRequestId: "permission-question-1",
    });
    const { paseo, calls, state } = fakePaseo({
      status: "running",
      activeTurn: {
        turnId: "turn-1",
        startedAt: "2026-11-13T10:00:00.000Z",
      },
      pendingPermissions: [questionRequest()],
      cancelKeepsRunning: true,
    });
    const service = new TaskBoardService(
      store,
      new AgentIndex(),
      undefined,
      undefined,
      fakeCanceller(state, calls),
    );

    await expect(
      service.sendMessage(paseo, "btask_send_stop", "Use the dev branch"),
    ).rejects.toMatchObject({
      code: "E_AGENT_BLOCKED",
      message: expect.stringContaining("still running"),
    });

    expect(calls.send).toEqual([]);
  });
});
