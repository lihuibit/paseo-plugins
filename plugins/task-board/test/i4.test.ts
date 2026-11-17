import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { createBoardTask } from "../shared/core/board/state";
import type {
  BoardAssignment,
  BoardExecution,
  Trigger,
} from "../shared/core/board/types";
import { AgentIndex } from "../server/agent-index";
import { WeComNotifier, type NotificationRecord } from "../server/notifier";
import { SchedulerLock } from "../server/scheduler";
import { BoardSettingsStore } from "../server/settings";
import { TaskBoardService } from "../server/service";
import { BoardStore } from "../server/store";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "task-board-i4-"));
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
  archivedAt?: string | null;
  status?: "running" | "idle" | "closed" | "initializing" | "error";
  missing?: boolean;
  pendingPermissions?: Array<{
    id: string;
    kind: string;
    name: string;
    title?: string;
    description?: string;
  }>;
}

function fakePaseo(state: FakeAgentState = {}) {
  const calls = {
    send: [] as string[],
    reload: [] as string[],
    archive: [] as string[],
  };
  const api = {
    agents: {
      ref: (agentId: string) => ({
        id: agentId,
        refresh: async () => {
          if (state.missing) return null;
          return {
            agent: {
              id: agentId,
              archivedAt: state.archivedAt ?? null,
              status: state.status ?? "running",
              pendingPermissions: state.pendingPermissions ?? [],
            },
          };
        },
        send: async (text: string) => {
          calls.send.push(text);
        },
        reload: async () => {
          calls.reload.push(agentId);
          return null;
        },
        archive: async () => {
          calls.archive.push(agentId);
          return { archivedAt: new Date().toISOString() };
        },
      }),
    },
  };
  return { paseo: api as unknown as PaseoApi, calls };
}

async function seedTask(
  store: BoardStore,
  input: {
    id: string;
    title: string;
    status?: "planning" | "todo" | "in_progress";
    assignment?: BoardAssignment;
    trigger?: Trigger;
    nextRunAt?: string;
    execution?: BoardExecution;
  },
) {
  const now = "2026-11-13T10:00:00.000Z";
  return store.transact((document) => {
    const created = createBoardTask(
      document,
      {
        title: input.title,
        status: input.status ?? "todo",
        assignment: input.assignment,
        trigger: input.trigger,
        nextRunAt: input.nextRunAt,
      },
      { id: input.id, now },
    );
    if (input.execution) {
      const task = created.document.tasks.find(
        (entry) => entry.id === input.id,
      );
      if (task) task.execution = input.execution;
    }
    return { document: created.document, result: created.task };
  });
}

describe("settings and notifications", () => {
  it("persists WeCom settings in the plugin data directory", async () => {
    const settings = new BoardSettingsStore();
    await settings.update({
      wecom: { enabled: true, webhookUrl: "https://example.com/hook" },
    });
    const reloaded = new BoardSettingsStore();
    const value = await reloaded.read();
    expect(value.wecom.enabled).toBe(true);
    expect(value.wecom.webhookUrl).toBe("https://example.com/hook");
    const raw = JSON.parse(
      await readFile(
        join(home, "plugin-data/paseo-task-board/settings.json"),
        "utf8",
      ),
    ) as { wecom: { webhookUrl: string } };
    expect(raw.wecom.webhookUrl).toBe("https://example.com/hook");
  });

  it("retries failures, records attempts and dedupes the same revision", async () => {
    const settings = new BoardSettingsStore();
    await settings.update({
      wecom: { enabled: true, webhookUrl: "https://example.com/hook" },
    });
    let calls = 0;
    const records: NotificationRecord[] = [];
    const notifier = new WeComNotifier(settings, {
      retryDelaysMs: [0, 0],
      fetchImpl: (async () => {
        calls += 1;
        if (calls < 3) {
          return new Response("busy", { status: 500 });
        }
        return new Response(JSON.stringify({ errcode: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
      record: async (record) => {
        records.push(record);
      },
    });
    const store = new BoardStore();
    const task = await seedTask(store, {
      id: "btask_notify",
      title: "Notify me",
      status: "planning",
    });
    notifier.enqueue(task, "blocked");
    await notifier.flush();
    expect(calls).toBe(3);
    expect(records).toHaveLength(1);
    expect(records[0]?.ok).toBe(true);
    expect(records[0]?.attempts.map((entry) => entry.ok)).toEqual([
      false,
      false,
      true,
    ]);

    notifier.enqueue(task, "blocked");
    await notifier.flush();
    expect(calls).toBe(3);
  });

  it("records exhausted retries without throwing", async () => {
    const settings = new BoardSettingsStore();
    await settings.update({
      wecom: { enabled: true, webhookUrl: "https://example.com/hook" },
    });
    let calls = 0;
    const records: NotificationRecord[] = [];
    const notifier = new WeComNotifier(settings, {
      retryDelaysMs: [0, 0],
      fetchImpl: (async () => {
        calls += 1;
        return new Response("nope", { status: 503 });
      }) as typeof fetch,
      record: async (record) => {
        records.push(record);
      },
    });
    const store = new BoardStore();
    const task = await seedTask(store, {
      id: "btask_fail",
      title: "Always fails",
      status: "planning",
    });
    notifier.enqueue(task, "review");
    await notifier.flush();
    expect(calls).toBe(4);
    expect(records[0]?.ok).toBe(false);
    expect(records[0]?.attempts).toHaveLength(4);
  });

  it("rate-limits different events for the same task", async () => {
    const settings = new BoardSettingsStore();
    await settings.update({
      wecom: {
        enabled: true,
        webhookUrl: "https://example.com/hook",
        minIntervalMs: 5_000,
      },
    });
    const sleeps: number[] = [];
    const notifier = new WeComNotifier(settings, {
      now: () => new Date("2026-11-13T10:00:00.000Z"),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ errcode: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      record: async () => undefined,
    });
    const store = new BoardStore();
    const task = await seedTask(store, {
      id: "btask_rate",
      title: "Rate limited",
      status: "planning",
    });
    notifier.enqueue(task, "review");
    notifier.enqueue(task, "blocked");
    await notifier.flush();
    expect(sleeps.some((ms) => ms >= 4_000)).toBe(true);
  });
});

describe("scheduler lock", () => {
  it("allows only one holder and takes over a stale lock", async () => {
    let now = Date.parse("2026-11-13T10:00:00.000Z");
    const first = new SchedulerLock("instance-a", { now: () => now });
    const second = new SchedulerLock("instance-b", { now: () => now });
    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);

    now += 91_000;
    expect(await second.acquire()).toBe(true);
    const third = new SchedulerLock("instance-c", { now: () => now });
    expect(await third.acquire()).toBe(false);
    await second.release();
    expect(await third.acquire()).toBe(true);
  });
});

describe("scheduled runs", () => {
  it("fires a one-shot once and does not repeat after nextRunAt is cleared", async () => {
    const store = new BoardStore();
    const service = new TaskBoardService(store, new AgentIndex());
    const task = await seedTask(store, {
      id: "btask_once",
      title: "One shot",
      assignment,
      trigger: { kind: "scheduled", runAt: "2026-11-13T10:00:05.000Z" },
    });
    const { paseo, calls } = fakePaseo();
    await service.runDueScheduled(paseo, new Date("2026-11-13T10:00:06.000Z"));
    const after = await service.get(task.id);
    expect(after.status).toBe("in_progress");
    expect(after.runCount).toBe(1);
    expect(after.nextRunAt).toBeNull();
    expect(calls.send).toHaveLength(1);

    await service.runDueScheduled(paseo, new Date("2026-11-13T10:05:00.000Z"));
    expect((await service.get(task.id)).runCount).toBe(1);
    expect(calls.send).toHaveLength(1);
  });

  it("spawns recurring children and skips while the previous run is active", async () => {
    const store = new BoardStore();
    const service = new TaskBoardService(store, new AgentIndex());
    const parent = await seedTask(store, {
      id: "btask_recurring",
      title: "Recurring",
      assignment,
      trigger: {
        kind: "recurring",
        cadence: { type: "every", everyMs: 60_000 },
        session: "new",
      },
      nextRunAt: "2026-11-13T10:00:00.000Z",
    });
    const { paseo } = fakePaseo();
    await service.runDueScheduled(paseo, new Date("2026-11-13T10:00:06.000Z"));
    let state = await service.get(parent.id);
    expect(state.status).toBe("todo");
    expect(state.derivedCount).toBe(1);
    expect(Date.parse(state.nextRunAt ?? "")).toBeGreaterThan(
      Date.parse("2026-11-13T10:01:00.000Z"),
    );
    const document = await store.read();
    const child = document.tasks.find(
      (entry) => entry.parentTaskId === parent.id,
    );
    expect(child?.status).toBe("in_progress");

    const forced = await store.transact((doc) => ({
      document: {
        ...doc,
        tasks: doc.tasks.map((entry) =>
          entry.id === parent.id
            ? { ...entry, nextRunAt: "2026-11-13T10:01:00.000Z" }
            : entry,
        ),
      },
      result: null,
    }));
    expect(forced).toBeNull();
    await service.runDueScheduled(paseo, new Date("2026-11-13T10:01:01.000Z"));
    state = await service.get(parent.id);
    expect(state.derivedCount).toBe(1);
    expect(
      (await store.read()).tasks.filter(
        (entry) => entry.parentTaskId === parent.id,
      ),
    ).toHaveLength(1);
    expect(Date.parse(state.nextRunAt ?? "")).toBeGreaterThan(
      Date.parse("2026-11-13T10:02:00.000Z"),
    );
  });
});

describe("permission and close hooks through the service", () => {
  async function boundTask() {
    const store = new BoardStore();
    const service = new TaskBoardService(store, new AgentIndex());
    const task = await seedTask(store, {
      id: "btask_bound",
      title: "Bound",
      assignment,
      status: "in_progress",
      execution,
    });
    await service.bindAgent(task.id, "agent_1");
    return { store, service, task };
  }

  it("writes blocked and restores after an allow resolution", async () => {
    const { service, task } = await boundTask();
    const agent = {
      id: "agent_1",
      workspaceId: "wks_1",
      parentAgentId: null,
      provider: "codex",
      cwd: "/tmp/demo",
      title: "TASK-1",
      background: true,
      metadata: {},
    };
    await service.onPermissionBefore(agent, {
      id: "perm_1",
      kind: "question",
      name: "AskUserQuestion",
      title: "Pick a branch",
      description: "main or dev",
    });
    let current = await service.get(task.id);
    expect(current.status).toBe("blocked");
    expect(current.blockReason).toBe("question");
    expect(current.pendingPermission?.requestId).toBe("perm_1");

    await service.onPermissionAfter(agent, "perm_1", { behavior: "allow" });
    current = await service.get(task.id);
    expect(current.status).toBe("in_progress");
    expect(current.pendingPermission).toBeUndefined();
  });

  it("marks agent_missing on close only when the runtime is gone", async () => {
    const { service, task } = await boundTask();
    const agent = {
      id: "agent_1",
      workspaceId: "wks_1",
      parentAgentId: null,
      provider: "codex",
      cwd: "/tmp/demo",
      title: "TASK-1",
      background: true,
      metadata: {},
    };
    const alive = fakePaseo({ status: "idle" });
    await service.onAgentClose(alive.paseo, agent, "agent.close.after");
    expect((await service.get(task.id)).status).toBe("in_progress");

    const missing = fakePaseo({ missing: true });
    await service.onAgentClose(missing.paseo, agent, "agent.close.after");
    const current = await service.get(task.id);
    expect(current.status).toBe("blocked");
    expect(current.blockReason).toBe("agent_missing");
  });
});

describe("cancel and hierarchy", () => {
  it("archives on cancel and detaches children on delete", async () => {
    const store = new BoardStore();
    const service = new TaskBoardService(store, new AgentIndex());
    const parent = await seedTask(store, {
      id: "btask_parent",
      title: "Parent",
      status: "in_progress",
      assignment,
      execution,
    });
    const child = await seedTask(store, {
      id: "btask_child",
      title: "Child",
      status: "planning",
    });
    await service.setHierarchy(child.id, parent.id, child.revision);
    const tree = await service.hierarchy(parent.id);
    expect(tree.children.map((entry) => entry.id)).toEqual([child.id]);
    expect(tree.summary.total).toBe(1);

    const { paseo, calls } = fakePaseo();
    const cancelled = await service.cancel(paseo, parent.id, parent.revision);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.executionArchive).toBe("final");
    expect(calls.archive).toEqual(["agent_1"]);

    const deleted = await service.delete(
      paseo,
      child.id,
      (await service.get(child.id)).revision,
    );
    expect(deleted.deleted).toBe(true);
  });
});
