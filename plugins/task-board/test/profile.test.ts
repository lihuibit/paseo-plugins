import { describe, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import {
  createBoardTask,
  emptyBoardDocument,
} from "../shared/core/board/state";
import type { BoardAssignment } from "../shared/core/board/types";
import { createAgentForTask } from "../server/assigner";
import { AgentIndex } from "../server/agent-index";
import { TaskBoardService } from "../server/service";
import { BoardStore } from "../server/store";

const task = createBoardTask(
  emptyBoardDocument(),
  { title: "Profile task" },
  { id: "btask_profile1", now: "2026-11-13T00:00:00.000Z" },
).task;

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
    title: "Profile agent",
    provider: "codex",
    model: "workbuddy/deepseek-v4.1-flash",
    modeId: "auto-review",
    thinkingOptionId: "high",
    options: { sandbox_mode: "read-only" },
  },
};

describe("Paseo Agent Profiles", () => {
  it("reads top-level agentProfiles and applies options", async () => {
    const fake = {
      config: {
        get: async () => ({
          requestId: "r1",
          config: {
            agentProfiles: [
              {
                id: "agent_profile_brick",
                name: "搬砖工",
                provider: "codex",
                model: "workbuddy/deepseek-v4.1-flash",
                modeId: "auto-review",
                thinkingOptionId: "high",
              },
            ],
          },
        }),
      },
    } as unknown as PaseoApi;
    const service = new TaskBoardService(new BoardStore(), new AgentIndex());
    await expect(service.listProfiles(fake)).resolves.toEqual([
      {
        id: "agent_profile_brick",
        name: "搬砖工",
        provider: "codex",
        model: "workbuddy/deepseek-v4.1-flash",
        modeId: "auto-review",
        thinkingOptionId: "high",
      },
    ]);
  });

  it("falls back to daemon.agentProfiles", async () => {
    const fake = {
      config: {
        get: async () => ({
          requestId: "r1",
          config: {
            daemon: {
              agentProfiles: [{ id: "p1", name: "Legacy", provider: "claude" }],
            },
          },
        }),
      },
    } as unknown as PaseoApi;
    const service = new TaskBoardService(new BoardStore(), new AgentIndex());
    await expect(service.listProfiles(fake)).resolves.toEqual([
      { id: "p1", name: "Legacy", provider: "claude" },
    ]);
  });

  it("uses featureValues when the profile has no options", async () => {
    const fake = {
      config: {
        get: async () => ({
          requestId: "r1",
          config: {
            agentProfiles: [
              {
                id: "p1",
                name: "Legacy",
                provider: "codex",
                featureValues: { sandbox_mode: "read-only" },
              },
            ],
          },
        }),
      },
    } as unknown as PaseoApi;
    const service = new TaskBoardService(new BoardStore(), new AgentIndex());
    await expect(service.listProfiles(fake)).resolves.toEqual([
      {
        id: "p1",
        name: "Legacy",
        provider: "codex",
        options: { sandbox_mode: "read-only" },
      },
    ]);
  });

  it("merges profile options into the created Agent config", async () => {
    let captured: Record<string, unknown> | null = null;
    const workspace = {
      refresh: async () => ({}),
      agents: {
        create: async (options: Record<string, unknown>) => {
          captured = options;
          return { id: "agent_profile_created", refresh: async () => null };
        },
      },
    };
    const fake = {
      workspaces: { ref: () => workspace },
    } as unknown as PaseoApi;

    const created = await createAgentForTask(fake, task, assignment);
    expect(created.execution.agentId).toBe("agent_profile_created");
    expect(captured).toMatchObject({
      config: {
        provider: "codex/workbuddy/deepseek-v4.1-flash",
        modeId: "auto-review",
        thinkingOptionId: "high",
        options: { sandbox_mode: "read-only" },
      },
      labels: {
        "agentstorm.board": "1",
        "agentstorm.task-id": "btask_profile1",
      },
      background: false,
    });
  });
});
