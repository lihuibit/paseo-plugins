import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { BOARD_ADMIN_LABEL, BOARD_LABEL } from "../shared/core/board/types";
import { toolsForLabels } from "./board-tools";
import type { TaskBoardService } from "./service";

export function registerHooks(
  server: PluginServerContext,
  service: TaskBoardService,
  declareTool: AgentToolDefinition,
  adminTools: AgentToolDefinition[],
  ensureReady: (paseo: PaseoApi) => Promise<void>,
): void {
  server.addHook("agent.create.after", async ({ agent }, context) => {
    await ensureReady(context.paseo);
    const metadata = agent.metadata["agentstorm.task-board"];
    if (!metadata || typeof metadata !== "object") return;
    const taskId = (metadata as Record<string, unknown>).taskId;
    if (typeof taskId === "string" && taskId.length > 0) {
      await service.bindAgent(taskId, agent.id);
    }
  });

  server.addHook("agent.open.before", async ({ request }, context) => {
    const isBoard = request.labels[BOARD_LABEL] === "1";
    const isAdmin = request.labels[BOARD_ADMIN_LABEL] === "1";
    if (!isBoard && !isAdmin) return;
    await ensureReady(context.paseo);
    await service.bindAgentFromOpen(request.agentId, { ...request.labels });
    if (request.purpose === "history") return;
    const injected = toolsForLabels(
      request.labels,
      declareTool,
      adminTools,
    ).filter(
      (tool) => !request.tools.some((existing) => existing.name === tool.name),
    );
    return {
      ...request,
      tools: [...request.tools, ...injected],
    };
  });

  server.addHook("agent.turn.before", async ({ agent, turnId }, context) => {
    await ensureReady(context.paseo);
    await service.onTurnBefore(agent, turnId);
  });

  server.addHook(
    "agent.turn.after",
    async ({ agent, turnId, outcome }, context) => {
      await ensureReady(context.paseo);
      await service.onTurnAfter(agent, turnId, outcome);
    },
  );

  server.addHook(
    "agent.permission.before",
    async ({ agent, request }, context) => {
      await ensureReady(context.paseo);
      await service.onPermissionBefore(agent, {
        id: request.id,
        kind: request.kind,
        name: request.name,
        title: request.title,
        description: request.description,
      });
    },
  );

  server.addHook(
    "agent.permission.after",
    async ({ agent, requestId, resolution }, context) => {
      await ensureReady(context.paseo);
      await service.onPermissionAfter(agent, requestId, {
        behavior: resolution.behavior,
        message:
          resolution.behavior === "deny" ? resolution.message : undefined,
      });
    },
  );

  server.addHook("agent.close.after", async ({ agent }, context) => {
    await ensureReady(context.paseo);
    await service.onAgentClose(context.paseo, agent, "agent.close.after");
  });

  server.addHook("agent.archive.after", async ({ agent }, context) => {
    await ensureReady(context.paseo);
    await service.onAgentClose(context.paseo, agent, "agent.archive.after");
  });
}
