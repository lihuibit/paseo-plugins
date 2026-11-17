import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createBoardTask } from "../shared/core/board/state";
import type {
  BoardAssignment,
  BoardExecution,
} from "../shared/core/board/types";
import { AgentIndex } from "../server/agent-index";
import { TaskBoardService } from "../server/service";
import { BoardStore, readEvents } from "../server/store";

// Requires a Paseo 0.16 install with its server test utils. On machines without
// one, set PASEO_E2E_SERVER_ROOT or the suite skips instead of failing.
const PASEO_SERVER_ROOT =
  process.env.PASEO_E2E_SERVER_ROOT ??
  "/home/ubuntu/.npm-global/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/test-utils";
const describeDaemon = existsSync(PASEO_SERVER_ROOT) ? describe : describe.skip;
const PASSWORD_HASH =
  "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";

interface TestDaemon {
  port: number;
  paseoHome: string;
  daemon: {
    agentManager: { rescueTimeouts: { interruptSessionMs: number } };
  };
  close(): Promise<void>;
}

interface TestSession {
  id: string;
  activeForegroundTurnId: string | null;
  pendingPermissions: unknown[];
  emitEvent(event: unknown): Promise<void>;
  startTurn?: (prompt: string) => Promise<{ turnId: string }>;
  interrupt?: () => Promise<void>;
}

interface TestAgentClient {
  createSession(...args: unknown[]): Promise<TestSession>;
  resumeSession(...args: unknown[]): Promise<TestSession>;
}

interface AgentHandle {
  refresh(): Promise<{
    agent: { status: string; pendingPermissions: unknown[] };
  } | null>;
}

async function loadTestUtils() {
  const daemonModule = await import(
    pathToFileURL(join(PASEO_SERVER_ROOT, "paseo-daemon.js")).href
  );
  const fakeModule = await import(
    pathToFileURL(join(PASEO_SERVER_ROOT, "fake-agent-client.js")).href
  );
  return {
    createTestPaseoDaemon: daemonModule.createTestPaseoDaemon as (
      options: unknown,
    ) => Promise<TestDaemon>,
    createTestAgentClient: fakeModule.createTestAgentClient as (
      provider: string,
      options?: unknown,
    ) => TestAgentClient,
  };
}

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "task-board-daemon-e2e-"));
  process.env.PASEO_HOME = home;
});

afterEach(async () => {
  delete process.env.PASEO_HOME;
  await rm(home, { recursive: true, force: true });
});

function executionFor(agentId: string, provider: string): BoardExecution {
  return {
    kind: "agent",
    project: {
      projectId: "prj_1",
      projectName: "Demo",
      projectRoot: home,
    },
    workspace: {
      workspaceId: "wks_1",
      workspaceName: "demo",
      workspaceDirectory: home,
      created: false,
    },
    agentId,
    agentTitle: "TASK-1",
    provider,
    model: null,
    agentCreated: false,
    startedAt: "2026-11-13T10:00:00.000Z",
  };
}

function assignmentFor(): BoardAssignment {
  return {
    mode: "agent",
    projectId: "prj_1",
    projectName: "Demo",
    projectRoot: home,
    workspaceId: "wks_1",
    workspaceName: "demo",
    workspaceDirectory: home,
    agent: { kind: "existing", agentId: "placeholder" },
  };
}

async function seed(store: BoardStore, agentId: string, provider: string) {
  const now = "2026-11-13T10:00:00.000Z";
  return store.transact((document) => {
    const created = createBoardTask(
      document,
      {
        title: "Cancel me",
        status: "in_progress",
        assignment: assignmentFor(),
      },
      { id: "btask_daemon", now },
    );
    const task = created.document.tasks.find(
      (entry) => entry.id === "btask_daemon",
    );
    if (!task) throw new Error("seed missing");
    task.execution = executionFor(agentId, provider);
    return { document: created.document, result: task };
  });
}

function questionClient(
  createTestAgentClient: (provider: string) => TestAgentClient,
  provider: string,
) {
  const base = createTestAgentClient(provider);
  const state = {
    questions: 0,
    starts: 0,
    prompts: [] as string[],
    refuseInterrupt: false,
  };
  const wrap = (session: TestSession): TestSession => {
    let request: (Record<string, unknown> & { id: string }) | null = null;
    session.startTurn = async (prompt: string) => {
      const turnId = `${provider}-turn-${state.starts}`;
      state.starts += 1;
      state.prompts.push(prompt);
      session.activeForegroundTurnId = turnId;
      await session.emitEvent({
        type: "thread_started",
        provider,
        sessionId: session.id,
      });
      await session.emitEvent({ type: "turn_started", provider });
      if (state.questions === 0) {
        state.questions += 1;
        request = {
          id: `${provider}-question-1`,
          provider,
          name: `${provider} question`,
          kind: "question",
          title: "Question",
          input: {
            questions: [
              {
                id: "0",
                header: "Question 1",
                question: "Which branch?",
                options: [{ label: "main" }, { label: "dev" }],
              },
            ],
          },
        };
        session.pendingPermissions = [request];
        await session.emitEvent({
          type: "permission_requested",
          provider,
          request,
        });
      } else {
        await session.emitEvent({
          type: "timeline",
          provider,
          item: {
            type: "assistant_message",
            text: "continued",
            messageId: `${provider}-message`,
          },
        });
        await session.emitEvent({
          type: "turn_completed",
          provider,
          usage: { inputTokens: 1, outputTokens: 1 },
        });
        session.activeForegroundTurnId = null;
      }
      return { turnId };
    };
    session.interrupt = async () => {
      if (state.refuseInterrupt) throw new Error("Provider ignored interrupt");
      if (request) {
        await session.emitEvent({
          type: "permission_resolved",
          provider,
          requestId: request.id,
          resolution: {
            behavior: "deny",
            interrupt: true,
            message: "Interrupted",
          },
        });
        session.pendingPermissions = [];
      }
      await session.emitEvent({
        type: "turn_canceled",
        provider,
        reason: "interrupted",
      });
      session.activeForegroundTurnId = null;
    };
    return session;
  };
  const createSession = base.createSession.bind(base);
  base.createSession = async (config: unknown, context: unknown) =>
    wrap(await createSession(config, context));
  const resumeSession = base.resumeSession.bind(base);
  base.resumeSession = async (
    handle: unknown,
    overrides: unknown,
    context: unknown,
  ) => wrap(await resumeSession(handle, overrides, context));
  return { client: base, state };
}

async function waitForQuestion(handle: AgentHandle) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const refreshed = await handle.refresh();
    if (
      refreshed?.agent.pendingPermissions?.length === 1 &&
      refreshed.agent.status === "running"
    ) {
      return refreshed.agent;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("agent did not reach a pending question");
}

describeDaemon("isolated daemon cancel", () => {
  it.each(["codex", "claude", "pi"])(
    "%s stop cancels a pending question",
    async (provider) => {
      const { createTestPaseoDaemon, createTestAgentClient } =
        await loadTestUtils();
      const { client: fakeClient, state } = questionClient(
        createTestAgentClient,
        provider,
      );
      const daemon = await createTestPaseoDaemon({
        agentClients: { [provider]: fakeClient },
        mcpEnabled: false,
        isDev: true,
      });
      daemon.daemon.agentManager.rescueTimeouts.interruptSessionMs = 200;
      const client = new DaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        clientId: `i22-${provider}`,
        reconnect: { enabled: false },
      });
      try {
        await client.connect();
        const paseo = createPaseoApi(client);
        const handle = await paseo.agents.create({
          config: { provider: `${provider}/test-model`, modeId: "default" },
          cwd: home,
          title: "question agent",
        });
        await handle.send("ask me");
        await waitForQuestion(handle);

        const store = new BoardStore();
        const service = new TaskBoardService(
          store,
          new AgentIndex(),
          undefined,
          undefined,
          (agentId) => client.cancelAgent(agentId),
        );
        await seed(store, handle.id, provider);
        const task = await service.stop(paseo, "btask_daemon");
        const refreshed = await handle.refresh();

        expect(task.status).toBe("blocked");
        expect(task.blockReason).toBe("manual");
        expect(refreshed?.agent.status).not.toBe("running");
        expect(refreshed?.agent.pendingPermissions).toEqual([]);
        const events = await readEvents({ limit: 50, taskId: "btask_daemon" });
        expect(events.some((event) => event.kind === "stopped")).toBe(true);
        expect(state.starts).toBe(1);
      } finally {
        await client.close();
        await daemon.close();
      }
    },
    30_000,
  );

  it("send interrupts a pending question and continues the conversation", async () => {
    const { createTestPaseoDaemon, createTestAgentClient } =
      await loadTestUtils();
    const { client: fakeClient, state } = questionClient(
      createTestAgentClient,
      "codex",
    );
    const daemon = await createTestPaseoDaemon({
      agentClients: { codex: fakeClient },
      mcpEnabled: false,
      isDev: true,
    });
    daemon.daemon.agentManager.rescueTimeouts.interruptSessionMs = 200;
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "i22-send",
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      const paseo = createPaseoApi(client);
      const handle = await paseo.agents.create({
        config: { provider: "codex/test-model", modeId: "default" },
        cwd: home,
        title: "question agent",
      });
      await handle.send("ask me");
      await waitForQuestion(handle);

      const store = new BoardStore();
      const service = new TaskBoardService(
        store,
        new AgentIndex(),
        undefined,
        undefined,
        (agentId) => client.cancelAgent(agentId),
      );
      await seed(store, handle.id, "codex");
      const result = await service.sendMessage(
        paseo,
        "btask_daemon",
        "use dev",
      );
      const refreshed = await handle.refresh();

      expect(result.interrupted).toBe(true);
      expect(result.task.status).toBe("in_progress");
      expect(refreshed?.agent.pendingPermissions).toEqual([]);
      for (let attempt = 0; attempt < 40 && state.starts < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (state.starts < 2) {
        const later = await handle.refresh();
        console.log("send state", {
          starts: state.starts,
          prompts: state.prompts,
          status: later?.agent.status,
          pending: later?.agent.pendingPermissions,
          activeTurn: later?.agent.activeTurn,
        });
        await handle.send("direct retry");
        for (let attempt = 0; attempt < 40 && state.starts < 2; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        console.log("direct retry state", {
          starts: state.starts,
          prompts: state.prompts,
          status: (await handle.refresh())?.agent.status,
        });
      }
      expect(state.starts).toBe(2);
    } finally {
      await client.close();
      await daemon.close();
    }
  }, 30_000);

  it("a second daemon client can cancel without reloading the session", async () => {
    const { createTestPaseoDaemon, createTestAgentClient } =
      await loadTestUtils();
    const { client: fakeClient, state } = questionClient(
      createTestAgentClient,
      "codex",
    );
    const daemon = await createTestPaseoDaemon({
      agentClients: { codex: fakeClient },
      mcpEnabled: false,
      isDev: true,
    });
    daemon.daemon.agentManager.rescueTimeouts.interruptSessionMs = 200;
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "i22-main",
      reconnect: { enabled: false },
    });
    const cancelClient = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "i22-cancel",
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      await cancelClient.connect();
      const paseo = createPaseoApi(client);
      const handle = await paseo.agents.create({
        config: { provider: "codex/test-model", modeId: "default" },
        cwd: home,
        title: "question agent",
      });
      await handle.send("ask me");
      await waitForQuestion(handle);
      await cancelClient.cancelAgent(handle.id);
      const stopped = await handle.refresh();
      expect(stopped?.agent.pendingPermissions).toEqual([]);
      expect(stopped?.agent.status).not.toBe("running");

      await handle.send("use dev");
      for (let attempt = 0; attempt < 40 && state.starts < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(state.starts).toBe(2);
      expect(state.prompts).toEqual(["ask me", "use dev"]);
    } finally {
      await cancelClient.close();
      await client.close();
      await daemon.close();
    }
  }, 30_000);

  it("a refused cancel returns a readable error", async () => {
    const { createTestPaseoDaemon, createTestAgentClient } =
      await loadTestUtils();
    const { client: fakeClient, state } = questionClient(
      createTestAgentClient,
      "claude",
    );
    state.refuseInterrupt = true;
    const daemon = await createTestPaseoDaemon({
      agentClients: { claude: fakeClient },
      mcpEnabled: false,
      isDev: true,
    });
    daemon.daemon.agentManager.rescueTimeouts.interruptSessionMs = 200;
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "i22-refused",
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      const paseo = createPaseoApi(client);
      const handle = await paseo.agents.create({
        config: { provider: "claude/test-model", modeId: "default" },
        cwd: home,
        title: "question agent",
      });
      await handle.send("ask me");
      await waitForQuestion(handle);

      const store = new BoardStore();
      const service = new TaskBoardService(
        store,
        new AgentIndex(),
        undefined,
        undefined,
        (agentId) => client.cancelAgent(agentId),
      );
      await seed(store, handle.id, "claude");
      await expect(
        service.sendMessage(paseo, "btask_daemon", "use dev"),
      ).rejects.toMatchObject({
        code: "E_AGENT_BLOCKED",
        message: expect.stringContaining("waiting for an answer"),
      });
      const task = await service.get("btask_daemon");
      expect(task.status).toBe("blocked");
      expect(task.blockReason).toBe("manual");
      const events = await readEvents({ limit: 50, taskId: "btask_daemon" });
      expect(events.some((event) => event.kind === "stop_failed")).toBe(true);
      expect(events.some((event) => event.kind === "stopped")).toBe(false);
    } finally {
      await client.close();
      await daemon.close();
    }
  }, 30_000);

  it("the default daemon canceller reads config.json and local credentials", async () => {
    const { createTestPaseoDaemon, createTestAgentClient } =
      await loadTestUtils();
    const { client: fakeClient } = questionClient(
      createTestAgentClient,
      "codex",
    );
    const daemon = await createTestPaseoDaemon({
      agentClients: { codex: fakeClient },
      mcpEnabled: false,
      isDev: true,
      auth: { password: PASSWORD_HASH },
    });
    daemon.daemon.agentManager.rescueTimeouts.interruptSessionMs = 200;
    await writeFile(
      join(daemon.paseoHome, "config.json"),
      JSON.stringify({
        daemon: { listen: `127.0.0.1:${daemon.port}` },
      }),
    );
    process.env.PASEO_HOME = daemon.paseoHome;
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "i22-default-canceller",
      localCredential: async () =>
        (
          await readFile(join(daemon.paseoHome, "local-credential"), "utf8")
        ).trim(),
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      const paseo = createPaseoApi(client);
      const handle = await paseo.agents.create({
        config: { provider: "codex/test-model", modeId: "default" },
        cwd: home,
        title: "question agent",
      });
      await handle.send("ask me");
      await waitForQuestion(handle);

      const store = new BoardStore();
      const service = new TaskBoardService(store, new AgentIndex());
      await seed(store, handle.id, "codex");
      const task = await service.stop(paseo, "btask_daemon");
      const refreshed = await handle.refresh();
      expect(task.status).toBe("blocked");
      expect(refreshed?.agent.status).not.toBe("running");
      expect(refreshed?.agent.pendingPermissions).toEqual([]);
    } finally {
      await client.close();
      await daemon.close();
    }
  }, 30_000);
});
