import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import {
  applyTurnAfter,
  attachExecution,
  assignBoardTask,
} from "../shared/core/board/state";
import type {
  BoardAssignment,
  BoardExecution,
} from "../shared/core/board/types";
import { AgentIndex } from "../server/agent-index";
import { TaskBoardService } from "../server/service";
import { BoardStore } from "../server/store";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "task-board-declare-"));
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
  agentCreated: true,
  startedAt: new Date().toISOString(),
};

async function startedTask() {
  const store = new BoardStore();
  const service = new TaskBoardService(
    store,
    new AgentIndex(),
    undefined,
    undefined,
    async () => undefined,
  );
  const task = await service.create({ title: "Declare contract" });
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
      execution,
      new Date().toISOString(),
    );
    return { document: started.document, result: null };
  });
  return { service, store, taskId: task.id };
}

function fakePaseo(): PaseoApi {
  return {
    agents: {
      ref: () => ({
        refresh: async () => ({
          agent: {
            id: "agent_1",
            status: "idle",
            pendingPermissions: [],
            activeTurn: null,
            archivedAt: null,
          },
        }),
        reload: async () => null,
        archive: async () => ({ archivedAt: new Date().toISOString() }),
      }),
    },
  } as unknown as PaseoApi;
}

async function reviewedTask() {
  const { service, store, taskId } = await startedTask();
  await store.transact((document) => {
    const outcome = applyTurnAfter(
      document,
      taskId,
      "turn-1",
      { kind: "completed" },
      new Date().toISOString(),
    );
    return { document: outcome.document, result: null };
  });
  return { service, taskId, task: await service.get(taskId) };
}

describe("task-board.declare", () => {
  it("writes waiting, progress, blocked, clear and review", async () => {
    const { service, taskId } = await startedTask();

    const waiting = await service.declare(taskId, "agent_1", {
      kind: "waiting",
      summary: "Waiting on CI",
    });
    expect(waiting.status).toBe("in_progress");
    expect(waiting.declaration).toMatchObject({
      kind: "waiting",
      summary: "Waiting on CI",
    });

    const progress = await service.declare(taskId, "agent_1", {
      kind: "progress",
      summary: "Running tests",
      stage: "test",
    });
    expect(progress.status).toBe("in_progress");
    expect(progress.progress).toMatchObject({
      summary: "Running tests",
      stage: "test",
    });
    expect(progress.revision).toBe(waiting.revision);

    const blocked = await service.declare(taskId, "agent_1", {
      kind: "blocked",
      summary: "Need a decision",
      blockReason: "human_required",
      humanRequest: {
        title: "Choose a database",
        instructions: "Pick sqlite or postgres",
        action: { kind: "manual" },
      },
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockReason).toBe("human_required");
    expect(blocked.declaration?.humanRequest?.requestedAt).toBeTruthy();

    const cleared = await service.declare(taskId, "agent_1", {
      kind: "clear",
    });
    expect(cleared.declaration).toBeUndefined();

    const review = await service.declare(taskId, "agent_1", {
      kind: "review",
      summary: "Ready",
    });
    expect(review.status).toBe("in_review");
    expect(review.declaration?.kind).toBe("review");
  });

  it("rejects a declaration from an unbound agent", async () => {
    const { service, taskId } = await startedTask();
    await expect(
      service.declare(taskId, "agent_other", { kind: "review" }),
    ).rejects.toMatchObject({ code: "E_NO_BOUND_TASK" });
  });

  it("unassigns and deletes after an internal stop bumped the revision", async () => {
    const unassigned = await reviewedTask();
    expect(unassigned.task.status).toBe("in_review");
    const cleared = await unassigned.service.unassign(
      fakePaseo(),
      unassigned.taskId,
      unassigned.task.revision,
    );
    expect(cleared.status).toBe("planning");
    expect(cleared.execution).toBeNull();

    const deleted = await reviewedTask();
    const result = await deleted.service.delete(
      fakePaseo(),
      deleted.taskId,
      deleted.task.revision,
    );
    expect(result.deleted).toBe(true);
    await expect(deleted.service.get(deleted.taskId)).rejects.toMatchObject({
      code: "E_TASK_NOT_FOUND",
    });
  });
});
