import { describe, expect, it } from "vitest";
import {
  advanceRecurring,
  applyAgentMissing,
  applyPermissionAfter,
  applyPermissionBefore,
  assignBoardTask,
  attachExecution,
  cancelBoardTask,
  createBoardTask,
  deleteBoardTask,
  emptyBoardDocument,
  hierarchySummary,
  markScheduleFired,
  setBoardStatus,
  setBoardTrigger,
  setHierarchyParent,
  unassignBoardTask,
} from "../src/board/state";
import {
  isTaskDue,
  nextCadenceRunAt,
  nextCronRunAt,
  nextRunAtForTrigger,
} from "../src/board/schedule";
import { preferredTaskForAgent } from "../src/board/agent-index";
import type {
  BoardAssignment,
  BoardExecution,
  BoardTaskDocument,
} from "../src/board/types";

const T0 = "2026-11-13T10:00:00.000Z";
const T1 = "2026-11-13T10:00:30.000Z";
const T2 = "2026-11-13T10:02:00.000Z";

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
  startedAt: T0,
};

function startedTask(): { document: BoardTaskDocument; taskId: string } {
  const created = createBoardTask(
    emptyBoardDocument(),
    { title: "Permission card" },
    { id: "btask_0000000000000001", now: T0 },
  );
  const assigned = assignBoardTask(
    created.document,
    created.task.id,
    assignment,
    0,
    T0,
  );
  const started = attachExecution(
    assigned.document,
    created.task.id,
    execution,
    T0,
  );
  return { document: started.document, taskId: created.task.id };
}

describe("permission hooks", () => {
  it("blocks with question/permission and restores when allowed", () => {
    const { document, taskId } = startedTask();
    const blocked = applyPermissionBefore(
      document,
      taskId,
      {
        id: "perm_1",
        kind: "question",
        name: "AskUserQuestion",
        title: "Choose a release branch",
        description: "main or release/1.4?",
      },
      T1,
    );
    expect(blocked.task.status).toBe("blocked");
    expect(blocked.task.blockReason).toBe("question");
    expect(blocked.task.blockDetail).toContain("main or release/1.4?");
    expect(blocked.task.pendingPermission).toMatchObject({
      requestId: "perm_1",
      kind: "question",
    });

    const duplicate = applyPermissionBefore(
      blocked.document,
      taskId,
      { id: "perm_1", kind: "question", name: "AskUserQuestion" },
      T1,
    );
    expect(duplicate.changed).toBe(false);

    const allowed = applyPermissionAfter(
      duplicate.document,
      taskId,
      "perm_1",
      { behavior: "allow" },
      T2,
    );
    expect(allowed.resumed).toBe(true);
    expect(allowed.task.status).toBe("in_progress");
    expect(allowed.task.blockReason).toBeUndefined();
    expect(allowed.task.pendingPermission).toBeUndefined();
  });

  it("keeps blocked(permission) when denied and ignores out-of-order ids", () => {
    const { document, taskId } = startedTask();
    const blocked = applyPermissionBefore(
      document,
      taskId,
      { id: "perm_2", kind: "tool", name: "shell" },
      T1,
    );
    expect(blocked.task.blockReason).toBe("permission");

    const stale = applyPermissionAfter(
      blocked.document,
      taskId,
      "perm_old",
      { behavior: "allow" },
      T2,
    );
    expect(stale.changed).toBe(false);
    expect(stale.task.status).toBe("blocked");

    const denied = applyPermissionAfter(
      stale.document,
      taskId,
      "perm_2",
      { behavior: "deny", message: "not allowed" },
      T2,
    );
    expect(denied.task.status).toBe("blocked");
    expect(denied.task.blockReason).toBe("permission");
    expect(denied.task.blockDetail).toBe("not allowed");
    expect(denied.task.pendingPermission).toBeUndefined();
  });

  it("marks a missing agent but leaves in_review untouched", () => {
    const { document, taskId } = startedTask();
    const missing = applyAgentMissing(document, taskId, T1);
    expect(missing.task.status).toBe("blocked");
    expect(missing.task.blockReason).toBe("agent_missing");

    const reviewed = {
      ...document,
      tasks: document.tasks.map((task) =>
        task.id === taskId ? { ...task, status: "in_review" as const } : task,
      ),
    };
    const untouched = applyAgentMissing(reviewed, taskId, T2);
    expect(untouched.task.status).toBe("in_review");
  });
});

describe("agent ownership", () => {
  it("follows the latest non-terminal card when an agent is reused", () => {
    const first = createBoardTask(
      emptyBoardDocument(),
      { title: "First", status: "in_review" },
      { id: "btask_first", now: T0 },
    );
    const firstTask = first.document.tasks[0]!;
    firstTask.execution = execution;
    firstTask.updatedAt = T0;

    const second = createBoardTask(
      first.document,
      { title: "Second", status: "in_progress" },
      { id: "btask_second", now: T1 },
    );
    const secondTask = second.document.tasks[1]!;
    secondTask.execution = execution;
    secondTask.updatedAt = T1;

    expect(preferredTaskForAgent(second.document.tasks, "agent_1")?.id).toBe(
      "btask_second",
    );

    const done = setBoardStatus(
      second.document,
      "btask_second",
      "done",
      secondTask.revision,
      T2,
    );
    expect(preferredTaskForAgent(done.document.tasks, "agent_1")?.id).toBe(
      "btask_first",
    );
  });
});

describe("schedule math", () => {
  it("computes every/cron cadences and one-shot due checks", () => {
    expect(
      nextCadenceRunAt(
        { type: "every", everyMs: 10_000 },
        new Date("2026-11-13T10:00:00Z"),
      ),
    ).toBe("2026-11-13T10:00:10.000Z");
    expect(
      nextCronRunAt("*/15 * * * *", new Date("2026-11-13T10:07:00Z"), "UTC"),
    ).toBe("2026-11-13T10:15:00.000Z");
    expect(
      nextCronRunAt("0 9 * * 1", new Date("2026-11-13T10:07:00Z"), "UTC"),
    ).toBe("2026-11-16T09:00:00.000Z");

    const created = createBoardTask(
      emptyBoardDocument(),
      {
        title: "Scheduled",
        trigger: { kind: "scheduled", runAt: "2026-11-13T10:05:00.000Z" },
        status: "todo",
      },
      { id: "btask_sched", now: T0 },
    );
    expect(isTaskDue(created.task, new Date("2026-11-13T10:04:59Z"))).toBe(
      false,
    );
    expect(isTaskDue(created.task, new Date("2026-11-13T10:05:00Z"))).toBe(
      true,
    );
    const fired = markScheduleFired(
      created.document,
      created.task.id,
      null,
      T1,
    );
    expect(isTaskDue(fired.task, new Date("2026-11-13T10:06:00Z"))).toBe(false);
  });

  it("advances recurring counters and keeps manual triggers idle", () => {
    expect(
      nextRunAtForTrigger(
        {
          kind: "recurring",
          cadence: { type: "every", everyMs: 60_000 },
          session: "new",
        },
        new Date(T0),
      ),
    ).toBe("2026-11-13T10:01:00.000Z");
    expect(nextRunAtForTrigger({ kind: "manual" }, new Date(T0))).toBeNull();

    const created = createBoardTask(
      emptyBoardDocument(),
      { title: "Recurring", assignment, status: "todo" },
      { id: "btask_parent", now: T0 },
    );
    const advanced = advanceRecurring(
      created.document,
      created.task.id,
      "2026-11-13T10:05:00.000Z",
      T1,
      "spawned",
    );
    expect(advanced.task.derivedCount).toBe(1);
    expect(advanced.task.nextRunAt).toBe("2026-11-13T10:05:00.000Z");
  });
});

describe("hierarchy, cancel and unassign", () => {
  it("sets hierarchy, rejects cycles, summarizes children and detaches on delete", () => {
    const parent = createBoardTask(
      emptyBoardDocument(),
      { title: "Parent" },
      { id: "btask_parent", now: T0 },
    );
    const child = createBoardTask(
      parent.document,
      { title: "Child" },
      { id: "btask_child", now: T0 },
    );
    const linked = setHierarchyParent(
      child.document,
      child.task.id,
      parent.task.id,
      0,
      T1,
    );
    expect(linked.task.hierarchyParentId).toBe(parent.task.id);

    expect(() =>
      setHierarchyParent(linked.document, parent.task.id, child.task.id, 0, T2),
    ).toThrowError(/cycle/);

    const summary = hierarchySummary(linked.document.tasks, parent.task.id);
    expect(summary.total).toBe(1);
    expect(summary.planning).toBe(1);
    expect(summary.percent).toBe(0);

    const deleted = deleteBoardTask(linked.document, parent.task.id, 0, T2);
    expect(deleted.document.tasks[0]?.hierarchyParentId).toBeNull();
  });

  it("cancels to final and clears scheduling; unassign returns to planning", () => {
    const { document, taskId } = startedTask();
    const scheduled = setBoardTrigger(
      document,
      taskId,
      {
        kind: "recurring",
        cadence: { type: "every", everyMs: 60_000 },
        session: "new",
      },
      document.tasks[0]?.revision ?? 0,
      T1,
    );
    const cancelled = cancelBoardTask(
      scheduled.document,
      taskId,
      scheduled.task.revision,
      T2,
    );
    expect(cancelled.task.status).toBe("cancelled");
    expect(cancelled.task.executionArchive).toBe("final");
    expect(cancelled.task.trigger).toBeUndefined();
    expect(cancelled.task.nextRunAt).toBeNull();

    const { document: doc2, taskId: id2 } = startedTask();
    const unassigned = unassignBoardTask(
      doc2,
      id2,
      doc2.tasks[0]?.revision,
      T2,
    );
    expect(unassigned.task.status).toBe("planning");
    expect(unassigned.task.execution).toBeNull();
    expect(unassigned.task.assignment).toBeUndefined();
    expect(unassigned.task.trigger).toBeUndefined();
  });
});
