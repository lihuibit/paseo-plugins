import { describe, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { BoardTaskSchema } from "../shared/core/board/types";
import type { BoardAssignment } from "../shared/core/board/types";
import { boardLabels, createAgentForTask } from "../server/assigner";

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
    thinkingOptionId: "high",
  },
};

function task(kind: "task" | "task-planning") {
  return BoardTaskSchema.parse({
    id: kind === "task-planning" ? "btask_planning" : "btask_worker",
    displayId: kind === "task-planning" ? "TASK-1" : "TASK-2",
    title: "Card",
    kind,
    status: "planning",
    createdAt: "2026-11-13T10:00:00.000Z",
    updatedAt: "2026-11-13T10:00:00.000Z",
  });
}

function fakePaseo(captured: { createOptions?: Record<string, unknown> }) {
  const api = {
    workspaces: {
      ref: () => ({
        refresh: async () => ({ id: "wks_1" }),
        agents: {
          create: async (options: Record<string, unknown>) => {
            captured.createOptions = options;
            return {
              id: "agent_new",
              refresh: async () => null,
            };
          },
        },
      }),
    },
  };
  return api as unknown as PaseoApi;
}

describe("board agent ownership", () => {
  it("labels workers with the board only", () => {
    const labels = boardLabels(task("task"));
    expect(labels).toMatchObject({
      "paseo.board": "1",
      "paseo.task-id": "btask_worker",
      "paseo.kind": "task",
    });
    expect(labels["paseo.board-admin"]).toBeUndefined();
  });

  it("labels planning agents as board admins", () => {
    const labels = boardLabels(task("task-planning"));
    expect(labels).toMatchObject({
      "paseo.board": "1",
      "paseo.board-admin": "1",
      "paseo.task-id": "btask_planning",
      "paseo.kind": "task-planning",
    });
  });

  it("injects the planning prompt and task metadata into a new planning agent", async () => {
    const captured: { createOptions?: Record<string, unknown> } = {};
    const planning = task("task-planning");
    await createAgentForTask(fakePaseo(captured), planning, assignment, {
      planningPrompt: "Custom {{taskId}}",
    });

    const options = captured.createOptions as {
      config: { systemPrompt: string };
      labels: Record<string, string>;
      metadata: Record<string, unknown>;
    };
    expect(
      options.config.systemPrompt.startsWith("Custom btask_planning"),
    ).toBe(true);
    expect(options.labels["paseo.board-admin"]).toBe("1");
    expect(options.labels["paseo.kind"]).toBe("task-planning");
    expect(options.metadata["paseo.task-id"]).toBe("btask_planning");
  });

  it("(no metadata key change) keeps the existing plugin metadata", async () => {
    const captured: { createOptions?: Record<string, unknown> } = {};
    await createAgentForTask(fakePaseo(captured), task("task"), assignment);
    const options = captured.createOptions as {
      metadata: Record<string, unknown>;
    };
    expect(Object.keys(options.metadata).length).toBeGreaterThanOrEqual(2);
  });

  it("creates a visible agent so workspace activity includes it", async () => {
    const captured: { createOptions?: Record<string, unknown> } = {};
    await createAgentForTask(fakePaseo(captured), task("task"), assignment);
    expect(captured.createOptions?.background).toBe(false);
  });

  it("keeps the background retry fallback for Paseo 0.15.x", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const api = {
      workspaces: {
        ref: () => ({
          refresh: async () => ({ id: "wks_1" }),
          agents: {
            create: async (options: Record<string, unknown>) => {
              calls.push(options);
              if (calls.length === 1) {
                throw new Error(
                  "background is workspace creation intent; configure the selected workspace at creation.",
                );
              }
              return { id: "agent_retry", refresh: async () => null };
            },
          },
        }),
      },
    } as unknown as PaseoApi;

    const created = await createAgentForTask(api, task("task"), assignment);
    expect(created.execution.agentId).toBe("agent_retry");
    expect(calls[0]?.background).toBe(false);
    expect(calls[1]?.background).toBeUndefined();
    expect(calls[1]?.metadata).toBeDefined();
  });
});
