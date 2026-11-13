import type {
  PluginHandlerContext,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import {
  BoardError,
  failBoard,
  okBoard,
  type BoardRpcEnvelope,
} from "./shared/core/board/errors";
import {
  assignRpc,
  cancelRpc,
  candidatesRpc,
  createRpc,
  declareRpc,
  deleteRpc,
  getRpc,
  healthRpc,
  hierarchyRpc,
  listRpc,
  migrateLegacyRpc,
  notificationsTestRpc,
  progressRpc,
  scheduleRpc,
  setHierarchyRpc,
  setStatusRpc,
  settingsGetRpc,
  settingsUpdateRpc,
  startRpc,
  stopRpc,
  unassignRpc,
  updateRpc,
} from "./shared/contracts";
import { AgentIndex } from "./server/agent-index";
import { createBoardDeclareTool } from "./server/board-tool";
import { registerHooks } from "./server/hooks";
import { ensureDataDir } from "./server/plugin-data";
import { WeComNotifier } from "./server/notifier";
import { Scheduler } from "./server/scheduler";
import { BoardSettingsStore } from "./server/settings";
import { TaskBoardService, type DeclareRequest } from "./server/service";
import { BoardStore } from "./server/store";

async function respond<T>(
  work: () => Promise<T>,
): Promise<BoardRpcEnvelope<T>> {
  try {
    return okBoard(await work());
  } catch (error) {
    if (error instanceof BoardError) {
      return failBoard(
        error.code,
        error.message,
        error.details,
        error.retryable,
      ) as BoardRpcEnvelope<T>;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[agentstorm-task-board] rpc error", error);
    return failBoard("E_INTERNAL", message) as BoardRpcEnvelope<T>;
  }
}

function toDeclareRequest(input: RpcInput<typeof declareRpc>): DeclareRequest {
  if (input.kind === "progress") {
    return {
      kind: "progress",
      summary: input.summary ?? "progress",
      stage: input.stage,
    };
  }
  if (input.kind === "blocked") {
    return {
      kind: "blocked",
      summary: input.summary,
      blockReason: input.blockReason,
      humanRequest: input.humanRequest,
    };
  }
  if (input.kind === "clear") {
    return { kind: "clear", summary: input.summary };
  }
  return { kind: input.kind, summary: input.summary };
}

export default function contribute(server: PluginServerContext) {
  const store = new BoardStore();
  const index = new AgentIndex();
  const settings = new BoardSettingsStore();
  const notifier = new WeComNotifier(settings);
  const service = new TaskBoardService(store, index, settings, notifier);
  const scheduler = new Scheduler(service);
  const declareTool = createBoardDeclareTool(service);
  let ready: Promise<void> | null = null;

  void ensureDataDir()
    .then(() => {
      console.log(
        `[agentstorm-task-board] server starting (pid ${process.pid}, PASEO_HOME=${process.env.PASEO_HOME ?? "unset"})`,
      );
    })
    .catch((error) => {
      console.error(
        "[agentstorm-task-board] cannot create plugin data directory",
        error,
      );
    });

  const ensureReady = (paseo: PluginHandlerContext["paseo"]) => {
    if (!ready) {
      ready = service
        .initialize(paseo)
        .then(() => {
          scheduler.start(paseo);
        })
        .catch((error) => {
          console.error("[agentstorm-task-board] initialization failed", error);
        });
    }
    return ready;
  };

  server.handle(listRpc, async (input, context) => {
    await ensureReady(context.paseo);
    return respond(() => service.list(input));
  });
  server.handle(getRpc, async ({ taskId }, context) => {
    await ensureReady(context.paseo);
    return respond(async () => ({ task: await service.get(taskId) }));
  });
  server.handle(createRpc, async (input, context) => {
    await ensureReady(context.paseo);
    return respond(async () => ({ task: await service.create(input) }));
  });
  server.handle(
    updateRpc,
    async ({ taskId, expectedRevision, patch }, context) => {
      await ensureReady(context.paseo);
      return respond(async () => ({
        task: await service.update(taskId, patch, expectedRevision),
      }));
    },
  );
  server.handle(
    setStatusRpc,
    async ({ taskId, expectedRevision, status }, context) => {
      await ensureReady(context.paseo);
      if (status === "cancelled") {
        return respond(async () => ({
          task: await service.cancel(context.paseo, taskId, expectedRevision),
        }));
      }
      return respond(async () => ({
        task: await service.setStatus(taskId, status, expectedRevision),
      }));
    },
  );
  server.handle(
    scheduleRpc,
    async ({ taskId, expectedRevision, trigger }, context) => {
      await ensureReady(context.paseo);
      return respond(async () => ({
        task: await service.schedule(taskId, trigger, expectedRevision),
      }));
    },
  );
  server.handle(
    setHierarchyRpc,
    async ({ taskId, expectedRevision, parentId }, context) => {
      await ensureReady(context.paseo);
      return respond(async () => ({
        task: await service.setHierarchy(taskId, parentId, expectedRevision),
      }));
    },
  );
  server.handle(hierarchyRpc, async ({ taskId }, context) => {
    await ensureReady(context.paseo);
    return respond(() => service.hierarchy(taskId));
  });
  server.handle(assignRpc, async (input, context) => {
    await ensureReady(context.paseo);
    return respond(async () => ({
      task: await service.assign(context.paseo, input),
    }));
  });
  server.handle(startRpc, async ({ taskId, message }, context) => {
    await ensureReady(context.paseo);
    return respond(async () => ({
      task: await service.start(context.paseo, taskId, message),
    }));
  });
  server.handle(stopRpc, async ({ taskId }, context) => {
    await ensureReady(context.paseo);
    return respond(async () => ({
      task: await service.stop(context.paseo, taskId),
    }));
  });
  server.handle(unassignRpc, async ({ taskId, expectedRevision }, context) => {
    await ensureReady(context.paseo);
    return respond(async () => ({
      task: await service.unassign(context.paseo, taskId, expectedRevision),
    }));
  });
  server.handle(cancelRpc, async ({ taskId, expectedRevision }, context) => {
    await ensureReady(context.paseo);
    return respond(async () => ({
      task: await service.cancel(context.paseo, taskId, expectedRevision),
    }));
  });
  server.handle(deleteRpc, async ({ taskId, expectedRevision }, context) => {
    await ensureReady(context.paseo);
    return respond(() =>
      service.delete(context.paseo, taskId, expectedRevision),
    );
  });
  server.handle(declareRpc, async (input, context) => {
    await ensureReady(context.paseo);
    return respond(async () => {
      const task = await service.declare(
        input.taskId,
        input.agentId,
        toDeclareRequest(input),
      );
      return { task, accepted: true };
    });
  });
  server.handle(progressRpc, async (input, context) => {
    await ensureReady(context.paseo);
    return respond(() =>
      service.progress(input.taskId, input.agentId, input.summary, input.stage),
    );
  });
  server.handle(candidatesRpc, async ({ projectId }, context) => {
    await ensureReady(context.paseo);
    return respond(() => service.candidates(context.paseo, projectId));
  });
  server.handle(healthRpc, async (_input, context) => {
    await ensureReady(context.paseo);
    return respond(() => service.health(context.paseo, scheduler.status()));
  });
  server.handle(settingsGetRpc, async (_input, context) => {
    await ensureReady(context.paseo);
    return respond(async () => ({ settings: await service.getSettings() }));
  });
  server.handle(settingsUpdateRpc, async ({ patch }, context) => {
    await ensureReady(context.paseo);
    return respond(async () => ({
      settings: await service.updateSettings(patch),
    }));
  });
  server.handle(notificationsTestRpc, async ({ webhookUrl }, context) => {
    await ensureReady(context.paseo);
    return respond(() => service.testNotification(webhookUrl));
  });
  server.handle(migrateLegacyRpc, async (input, context) => {
    await ensureReady(context.paseo);
    return respond(() => service.migrateLegacy(context.paseo, input));
  });

  registerHooks(server, service, declareTool, ensureReady);

  return async () => {
    console.log("[agentstorm-task-board] server stopping");
    await scheduler.stop();
    await notifier.flush();
  };
}
