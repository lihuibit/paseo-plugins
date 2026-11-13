import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentIndex } from "../server/agent-index";
import { TaskBoardService } from "../server/service";
import { BoardStore } from "../server/store";
import { attachExecution } from "../shared/core/board/state";
import type { BoardTask } from "../shared/core/board/types";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "task-board-archive-"));
  process.env.PASEO_HOME = home;
});

afterEach(async () => {
  delete process.env.PASEO_HOME;
  await rm(home, { recursive: true, force: true });
});

function execution(agentId: string) {
  return {
    kind: "agent" as const,
    project: {
      projectId: "prj_test",
      projectName: "project",
      projectRoot: "/tmp/project",
    },
    workspace: {
      workspaceId: "wks_test",
      workspaceName: "workspace",
      workspaceDirectory: "/tmp/project",
      created: false,
    },
    agentId,
    agentTitle: "board agent",
    provider: "codex",
    model: "test-model",
    agentCreated: true,
    startedAt: new Date().toISOString(),
  };
}

function fakePaseo(
  options: {
    archivedAt?: string | null;
    archiveError?: Error;
  } = {},
) {
  const calls = { reload: 0, archive: 0 };
  const api = {
    agents: {
      ref: (agentId: string) => ({
        id: agentId,
        archivedAt: options.archivedAt ?? null,
        reload: async () => {
          calls.reload += 1;
          return null;
        },
        archive: async () => {
          calls.archive += 1;
          if (options.archiveError) throw options.archiveError;
          return { archivedAt: "2026-11-13T10:01:00.000Z" };
        },
      }),
    },
  };
  return { paseo: api as unknown as PaseoApi, calls };
}

async function seedTask(
  service: TaskBoardService,
  store: BoardStore,
  index: AgentIndex,
  agentId: string,
): Promise<BoardTask> {
  const task = await service.create({ title: `Card for ${agentId}` });
  const now = new Date().toISOString();
  await store.transact((document) => {
    const outcome = attachExecution(document, task.id, execution(agentId), now);
    return { document: outcome.document, result: outcome.task };
  });
  await index.bind(agentId, task.id);
  return service.get(task.id);
}

describe("finishing a card archives its agent", () => {
  it("archives and unbinds on done", async () => {
    const store = new BoardStore();
    const index = new AgentIndex();
    const service = new TaskBoardService(store, index);
    const task = await seedTask(service, store, index, "agent_done");
    const { paseo, calls } = fakePaseo();

    const done = await service.setStatus(paseo, task.id, "done", task.revision);

    expect(done.status).toBe("done");
    expect(done.execution?.agentId).toBe("agent_done");
    expect(calls.archive).toBe(1);
    expect(index.taskIdFor("agent_done")).toBeNull();
  });

  it("keeps the card status when archiving fails", async () => {
    const store = new BoardStore();
    const index = new AgentIndex();
    const service = new TaskBoardService(store, index);
    const task = await seedTask(service, store, index, "agent_fail");
    const { paseo, calls } = fakePaseo({
      archiveError: new Error("host unavailable"),
    });

    const done = await service.setStatus(paseo, task.id, "done", task.revision);

    expect(done.status).toBe("done");
    expect(calls.archive).toBe(1);
    expect(index.taskIdFor("agent_fail")).toBeNull();
  });

  it("treats a missing agent as already archived", async () => {
    const store = new BoardStore();
    const index = new AgentIndex();
    const service = new TaskBoardService(store, index);
    const task = await seedTask(service, store, index, "agent_missing");
    const { paseo } = fakePaseo({
      archiveError: new Error("Agent not found: agent_missing"),
    });

    await expect(
      service.setStatus(paseo, task.id, "done", task.revision),
    ).resolves.toMatchObject({ status: "done" });
  });

  it("skips archive when the agent is already archived", async () => {
    const store = new BoardStore();
    const index = new AgentIndex();
    const service = new TaskBoardService(store, index);
    const task = await seedTask(service, store, index, "agent_archived");
    const { paseo, calls } = fakePaseo({
      archivedAt: "2026-11-13T09:00:00.000Z",
    });

    await service.setStatus(paseo, task.id, "done", task.revision);

    expect(calls.archive).toBe(0);
  });

  it("archives on cancel", async () => {
    const store = new BoardStore();
    const index = new AgentIndex();
    const service = new TaskBoardService(store, index);
    const task = await seedTask(service, store, index, "agent_cancel");
    const { paseo, calls } = fakePaseo();

    const cancelled = await service.cancel(paseo, task.id, task.revision);

    expect(cancelled.status).toBe("cancelled");
    expect(calls.archive).toBe(1);
    expect(index.taskIdFor("agent_cancel")).toBeNull();
  });

  it("cancels even when archiving fails", async () => {
    const store = new BoardStore();
    const index = new AgentIndex();
    const service = new TaskBoardService(store, index);
    const task = await seedTask(service, store, index, "agent_cancel_fail");
    const { paseo } = fakePaseo({
      archiveError: new Error("host unavailable"),
    });

    await expect(
      service.cancel(paseo, task.id, task.revision),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("archives before deleting the card", async () => {
    const store = new BoardStore();
    const index = new AgentIndex();
    const service = new TaskBoardService(store, index);
    const task = await seedTask(service, store, index, "agent_delete");
    const { paseo, calls } = fakePaseo();

    const result = await service.delete(paseo, task.id, task.revision);

    expect(result.deleted).toBe(true);
    expect(calls.archive).toBe(1);
    await expect(service.get(task.id)).rejects.toMatchObject({
      code: "E_TASK_NOT_FOUND",
    });
  });

  it("deletes even when archiving fails", async () => {
    const store = new BoardStore();
    const index = new AgentIndex();
    const service = new TaskBoardService(store, index);
    const task = await seedTask(service, store, index, "agent_delete_fail");
    const { paseo } = fakePaseo({
      archiveError: new Error("host unavailable"),
    });

    await expect(
      service.delete(paseo, task.id, task.revision),
    ).resolves.toMatchObject({ deleted: true });
  });
});
