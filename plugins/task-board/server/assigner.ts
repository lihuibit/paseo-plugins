import type { PaseoApi, PaseoAgentHandle } from "@getpaseo/client";
import { BoardError } from "../shared/core/board/errors";
import {
  BOARD_ADMIN_LABEL,
  BOARD_KIND_LABEL,
  BOARD_LABEL,
  BOARD_METADATA_KEY,
  BOARD_TASK_LABEL,
  type BoardAssignment,
  type BoardExecution,
  type BoardTask,
} from "../shared/core/board/types";
import { buildBoardSystemPrompt } from "./system-prompt";

export interface ResolvedTarget {
  projectId: string;
  projectName: string;
  projectRoot: string;
  workspaceId: string;
  workspaceName: string;
  workspaceDirectory: string;
}

export async function resolveAssignmentTarget(
  paseo: PaseoApi,
  projectId: string,
  workspaceId: string,
): Promise<ResolvedTarget> {
  const [projects, workspaces] = await Promise.all([
    paseo.projects.list(),
    paseo.workspaces.list({ includeBackground: true, page: { limit: 200 } }),
  ]);
  const project = projects.projects.find(
    (entry) => entry.projectId === projectId,
  );
  if (!project) {
    throw new BoardError("E_VALIDATION_FAILED", "Project not found", {
      projectId,
    });
  }
  const workspace = workspaces.entries.find(
    (entry) => entry.id === workspaceId,
  );
  if (!workspace) {
    throw new BoardError("E_VALIDATION_FAILED", "Workspace not found", {
      workspaceId,
    });
  }
  if (workspace.projectId !== projectId) {
    throw new BoardError(
      "E_VALIDATION_FAILED",
      "Workspace does not belong to the project",
      { projectId, workspaceId },
    );
  }
  if (workspace.archivingAt) {
    throw new BoardError("E_VALIDATION_FAILED", "Workspace is archived", {
      workspaceId,
    });
  }
  const directory = workspace.workspaceDirectory ?? workspace.projectRootPath;
  if (!directory) {
    throw new BoardError("E_VALIDATION_FAILED", "Workspace has no directory", {
      workspaceId,
    });
  }
  return {
    projectId: project.projectId,
    projectName: project.projectDisplayName,
    projectRoot: project.projectRootPath,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceDirectory: directory,
  };
}

function composeProvider(provider: string, model?: string): string {
  if (!model) return provider;
  return provider.includes("/") ? provider : `${provider}/${model}`;
}

export async function createAgentForTask(
  paseo: PaseoApi,
  task: BoardTask,
  assignment: BoardAssignment,
  options: { planningPrompt?: string } = {},
): Promise<{ handle: PaseoAgentHandle; execution: BoardExecution }> {
  if (assignment.agent.kind !== "create") {
    throw new BoardError("E_VALIDATION_FAILED", "Expected a create target");
  }
  const workspace = await paseo.workspaces
    .ref(assignment.workspaceId)
    .refresh();
  if (!workspace) {
    throw new BoardError(
      "E_AGENT_MISSING",
      "Workspace is no longer available",
      {
        workspaceId: assignment.workspaceId,
      },
    );
  }

  const agentInput = assignment.agent;
  const provider = composeProvider(agentInput.provider, agentInput.model);
  const handle = await paseo.workspaces
    .ref(assignment.workspaceId)
    .agents.create({
      config: {
        provider,
        modeId: agentInput.modeId,
        thinkingOptionId: agentInput.thinkingOptionId,
        options: agentInput.options,
        systemPrompt: buildBoardSystemPrompt(task, options),
      },
      title: agentInput.title ?? `${task.displayId} ${task.title}`,
      labels: boardLabels(task),
      metadata: {
        [BOARD_TASK_LABEL]: task.id,
        [BOARD_METADATA_KEY]: {
          taskId: task.id,
          displayId: task.displayId,
          pluginId: "agentstorm-task-board",
        },
      },
      background: true,
    });
  await handle.refresh();

  return {
    handle,
    execution: {
      kind: "agent",
      project: {
        projectId: assignment.projectId,
        projectName: assignment.projectName,
        projectRoot: assignment.projectRoot,
      },
      workspace: {
        workspaceId: assignment.workspaceId,
        workspaceName: assignment.workspaceName,
        workspaceDirectory: assignment.workspaceDirectory,
        created: false,
      },
      agentId: handle.id,
      agentTitle: agentInput.title ?? `${task.displayId} ${task.title}`,
      provider: agentInput.provider,
      model: agentInput.model ?? null,
      agentCreated: true,
      startedAt: new Date().toISOString(),
    },
  };
}

export async function executionForExistingAgent(
  paseo: PaseoApi,
  task: BoardTask,
  assignment: BoardAssignment,
): Promise<{ handle: PaseoAgentHandle; execution: BoardExecution }> {
  if (assignment.agent.kind !== "existing") {
    throw new BoardError("E_VALIDATION_FAILED", "Expected an existing target");
  }
  const agentId = assignment.agent.agentId;
  const handle = paseo.agents.ref(agentId);
  const refreshed = await handle.refresh();
  if (!refreshed || refreshed.agent.archivedAt) {
    throw new BoardError("E_AGENT_MISSING", "Agent is missing or archived", {
      agentId,
    });
  }
  return {
    handle,
    execution: {
      kind: "agent",
      project: {
        projectId: assignment.projectId,
        projectName: assignment.projectName,
        projectRoot: assignment.projectRoot,
      },
      workspace: {
        workspaceId: assignment.workspaceId,
        workspaceName: assignment.workspaceName,
        workspaceDirectory: assignment.workspaceDirectory,
        created: false,
      },
      agentId,
      agentTitle: refreshed.agent.title,
      provider: refreshed.agent.provider,
      model: refreshed.agent.model,
      agentCreated: false,
      startedAt: new Date().toISOString(),
    },
  };
}

export function boardLabels(
  task: Pick<BoardTask, "id" | "kind">,
): Record<string, string> {
  return {
    [BOARD_LABEL]: "1",
    [BOARD_TASK_LABEL]: task.id,
    [BOARD_KIND_LABEL]: task.kind,
    ...(task.kind === "task-planning" ? { [BOARD_ADMIN_LABEL]: "1" } : {}),
  };
}
