import { describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import { registerHooks } from "../server/hooks";
import type { TaskBoardService } from "../server/service";

const declareTool = { name: "board_declare" } as AgentToolDefinition;
const adminTool = { name: "board_list" } as AgentToolDefinition;

function register() {
  const hooks = new Map<
    string,
    (payload: unknown, context: unknown) => unknown
  >();
  const service = {
    bindAgent: vi.fn(async () => undefined),
    bindAgentFromOpen: vi.fn(async () => undefined),
    onTurnBefore: vi.fn(async () => undefined),
    onTurnAfter: vi.fn(async () => undefined),
    onPermissionBefore: vi.fn(async () => undefined),
    onPermissionAfter: vi.fn(async () => undefined),
    onAgentClose: vi.fn(async () => undefined),
  } as unknown as TaskBoardService;
  const server = {
    addHook: (
      name: string,
      handler: (payload: unknown, context: unknown) => unknown,
    ) => hooks.set(name, handler),
  } as unknown as PluginServerContext;
  registerHooks(
    server,
    service,
    declareTool,
    [adminTool],
    async () => undefined,
  );
  return { hooks, service };
}

const context = { paseo: {} };

describe("board hooks", () => {
  it("injects board_declare for board labels", async () => {
    const { hooks, service } = register();
    const result = (await hooks.get("agent.open.before")!(
      {
        request: {
          agentId: "agent_worker",
          labels: { "paseo.board": "1", "paseo.task-id": "btask_1" },
          tools: [],
          purpose: "message",
        },
      },
      context,
    )) as { tools: AgentToolDefinition[] };

    expect(result.tools.map((tool) => tool.name)).toEqual(["board_declare"]);
    expect(service.bindAgentFromOpen).toHaveBeenCalledWith("agent_worker", {
      "paseo.board": "1",
      "paseo.task-id": "btask_1",
    });
  });

  it("injects admin tools for admin labels", async () => {
    const { hooks } = register();
    const result = (await hooks.get("agent.open.before")!(
      {
        request: {
          agentId: "agent_admin",
          labels: {
            "paseo.board": "1",
            "paseo.board-admin": "1",
          },
          tools: [],
          purpose: "message",
        },
      },
      context,
    )) as { tools: AgentToolDefinition[] };

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "board_list",
      "board_declare",
    ]);
  });

  it("binds an agent from metadata", async () => {
    const { hooks, service } = register();
    await hooks.get("agent.create.after")!(
      {
        agent: {
          id: "agent_worker",
          metadata: { "paseo.task-board": { taskId: "btask_1" } },
        },
      },
      context,
    );

    expect(service.bindAgent).toHaveBeenCalledWith("btask_1", "agent_worker");
  });
});
