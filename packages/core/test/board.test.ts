import { describe, expect, it } from "vitest";
import {
  applyDeclaration,
  applyProgress,
  applyTurnAfter,
  assignBoardTask,
  attachExecution,
  createBoardTask,
  emptyBoardDocument,
  markStopRequested,
  setBoardStatus,
  syncTurnBefore,
  updateBoardTask,
} from "../src/board/state";
import { rebuildAgentIndex, taskIdFromAgent } from "../src/board/agent-index";
import { BoardError } from "../src/board/errors";
import type {
  BoardAssignment,
  BoardExecution,
  BoardTaskDocument,
} from "../src/board/types";

const T0 = "2026-11-13T10:00:00.000Z";
const T1 = "2026-11-13T10:00:30.000Z";
const T2 = "2026-11-13T10:02:00.000Z";

function withTask(): {
  document: BoardTaskDocument;
  taskId: string;
} {
  const created = createBoardTask(
    emptyBoardDocument(),
    { title: "Ship the board" },
    { id: "btask_0000000000000001", now: T0 },
  );
  return { document: created.document, taskId: created.task.id };
}

const assignment: BoardAssignment = {
  mode: "agent",
  projectId: "prj_1",
  projectName: "Demo",
  projectRoot: "/tmp/demo",
  workspaceId: "wks_1",
  workspaceName: "demo",
  workspaceDirectory: "/tmp/demo",
  agent: {
    kind: "create",
    provider: "codex",
    model: "gpt",
    modeId: "full-access",
  },
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
  model: "gpt",
  agentCreated: true,
  startedAt: T0,
};

describe("board task lifecycle", () => {
  it("creates planning cards with increasing display ids", () => {
    const first = createBoardTask(
      emptyBoardDocument(),
      { title: "First" },
      { id: "btask_1", now: T0 },
    );
    const second = createBoardTask(
      first.document,
      { title: "Second" },
      { id: "btask_2", now: T0 },
    );
    expect(first.task.status).toBe("planning");
    expect(first.task.displayId).toBe("TASK-1");
    expect(second.task.displayId).toBe("TASK-2");
    expect(first.task.revision).toBe(0);
  });

  it("rejects stale revisions with a 409 envelope detail", () => {
    const { document, taskId } = withTask();
    const updated = updateBoardTask(
      document,
      taskId,
      { title: "Changed" },
      0,
      T0,
    );
    expect(updated.task.revision).toBe(1);
    try {
      updateBoardTask(updated.document, taskId, { title: "Stale" }, 0, T0);
      throw new Error("expected a conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(BoardError);
      expect((error as BoardError).code).toBe("E_REVISION_CONFLICT");
      expect((error as BoardError).details?.httpStatus).toBe(409);
    }
  });

  it("assigns to todo, starts to in_progress and counts runs", () => {
    const { document, taskId } = withTask();
    const assigned = assignBoardTask(document, taskId, assignment, 0, T0);
    expect(assigned.task.status).toBe("todo");
    expect(assigned.task.revision).toBe(1);

    const started = attachExecution(assigned.document, taskId, execution, T0);
    expect(started.task.status).toBe("in_progress");
    expect(started.task.runCount).toBe(1);
    expect(started.task.execution?.agentId).toBe("agent_1");
  });

  it("marks a stop as blocked(manual) and keeps it stopped on canceled", () => {
    const { document, taskId } = withTask();
    const started = attachExecution(
      assignBoardTask(document, taskId, assignment, 0, T0).document,
      taskId,
      execution,
      T0,
    );
    const stopped = markStopRequested(started.document, taskId, T1);
    expect(stopped.task.status).toBe("blocked");
    expect(stopped.task.blockReason).toBe("manual");

    const after = applyTurnAfter(
      stopped.document,
      taskId,
      "turn-1",
      { kind: "canceled", reason: "interrupted" },
      T1,
    );
    expect(after.task.status).toBe("blocked");
    expect(after.task.blockReason).toBe("manual");
    expect(after.task.pendingStopAt).toBeUndefined();
  });

  it("moves completed turns to in_review and failed turns to blocked", () => {
    const { document, taskId } = withTask();
    const started = attachExecution(
      assignBoardTask(document, taskId, assignment, 0, T0).document,
      taskId,
      execution,
      T0,
    );
    const completed = applyTurnAfter(
      started.document,
      taskId,
      "turn-1",
      { kind: "completed" },
      T1,
    );
    expect(completed.task.status).toBe("in_review");
    expect(completed.task.revision).toBe(started.task.revision + 1);

    const failed = applyTurnAfter(
      started.document,
      taskId,
      "turn-2",
      { kind: "failed", error: { message: "provider exited" } },
      T1,
    );
    expect(failed.task.status).toBe("blocked");
    expect(failed.task.blockReason).toBe("agent_error");
    expect(failed.task.blockDetail).toBe("provider exited");
  });

  it("deduplicates identical turn ids", () => {
    const { document, taskId } = withTask();
    const started = attachExecution(
      assignBoardTask(document, taskId, assignment, 0, T0).document,
      taskId,
      execution,
      T0,
    );
    const first = applyTurnAfter(
      started.document,
      taskId,
      "turn-1",
      { kind: "completed" },
      T1,
    );
    const second = applyTurnAfter(
      first.document,
      taskId,
      "turn-1",
      { kind: "failed", error: { message: "late duplicate" } },
      T2,
    );
    expect(second.task.status).toBe("in_review");
    expect(second.changed).toBe(false);
  });

  it("turn.before clears manual blocks and declarations", () => {
    const { document, taskId } = withTask();
    const started = attachExecution(
      assignBoardTask(document, taskId, assignment, 0, T0).document,
      taskId,
      execution,
      T0,
    );
    const blocked = applyDeclaration(
      started.document,
      taskId,
      "agent_1",
      { kind: "blocked", blockReason: "question", summary: "Pick one" },
      T1,
    );
    expect(blocked.task.status).toBe("blocked");
    const resumed = syncTurnBefore(blocked.document, taskId, "turn-2", T2);
    expect(resumed.task.status).toBe("in_progress");
    expect(resumed.task.blockReason).toBeUndefined();
    expect(resumed.task.declaration).toBeUndefined();
  });

  it("declares review, waiting and progress with the documented revisions", () => {
    const { document, taskId } = withTask();
    const started = attachExecution(
      assignBoardTask(document, taskId, assignment, 0, T0).document,
      taskId,
      execution,
      T0,
    );

    const waiting = applyDeclaration(
      started.document,
      taskId,
      "agent_1",
      { kind: "waiting", summary: "Waiting on CI" },
      T1,
    );
    expect(waiting.task.status).toBe("in_progress");
    expect(waiting.task.revision).toBe(started.task.revision);

    const progress = applyProgress(
      waiting.document,
      taskId,
      { summary: "Building", stage: "build" },
      T1,
    );
    expect(progress.task.status).toBe("in_progress");
    expect(progress.task.revision).toBe(started.task.revision);
    expect(progress.task.progress?.summary).toBe("Building");

    const throttled = applyProgress(
      progress.document,
      taskId,
      { summary: "Still building" },
      T1,
    );
    expect(throttled.recorded).toBe(false);
    const later = applyProgress(
      throttled.document,
      taskId,
      { summary: "Done building" },
      T2,
    );
    expect(later.recorded).toBe(true);
    expect(later.task.revision).toBe(started.task.revision);

    const review = applyDeclaration(
      later.document,
      taskId,
      "agent_1",
      { kind: "review", summary: "Ready" },
      T2,
    );
    expect(review.task.status).toBe("in_review");
    expect(review.task.revision).toBe(started.task.revision + 1);
  });

  it("keeps terminal cards untouched by declarations", () => {
    const { document, taskId } = withTask();
    const done = setBoardStatus(document, taskId, "done", 0, T1);
    const declared = applyDeclaration(
      done.document,
      taskId,
      "agent_1",
      { kind: "review" },
      T2,
    );
    expect(declared.task.status).toBe("done");
    expect(declared.terminal).toBe(true);
  });
});

describe("agent ownership index", () => {
  it("resolves labels and structured metadata", () => {
    expect(
      taskIdFromAgent({
        id: "a1",
        labels: { "agentstorm.board": "1", "agentstorm.task-id": "btask_1" },
      }),
    ).toBe("btask_1");
    expect(
      taskIdFromAgent({
        id: "a2",
        metadata: { "agentstorm.task-board": { taskId: "btask_2" } },
      }),
    ).toBe("btask_2");
    expect(taskIdFromAgent({ id: "a3" })).toBeNull();
  });

  it("rebuilds only known, unarchived board agents", () => {
    const { document } = withTask();
    const index = rebuildAgentIndex(document.tasks, [
      {
        id: "a1",
        labels: {
          "agentstorm.board": "1",
          "agentstorm.task-id": "btask_0000000000000001",
        },
      },
      {
        id: "a2",
        labels: { "agentstorm.board": "1", "agentstorm.task-id": "missing" },
      },
      { id: "a3", labels: {} },
      {
        id: "a4",
        labels: {
          "agentstorm.board": "1",
          "agentstorm.task-id": "btask_0000000000000001",
        },
        archivedAt: T1,
      },
    ]);
    expect(index).toEqual({ a1: "btask_0000000000000001" });
  });
});
