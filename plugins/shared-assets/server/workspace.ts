import { realpath } from "node:fs/promises";
import type { PaseoApi, PaseoProject, PaseoWorkspace } from "@getpaseo/client";
import { PluginError } from "../shared/core/errors";
import type { WorkspaceSummary } from "../shared/core/types";

export async function listProjects(paseo: PaseoApi): Promise<PaseoProject[]> {
  const result = await paseo.projects.list();
  return result.projects;
}

export async function listWorkspaces(
  paseo: PaseoApi,
): Promise<PaseoWorkspace[]> {
  const result = await paseo.workspaces.list();
  return result.entries;
}

export async function requireProject(
  paseo: PaseoApi,
  projectId: string,
): Promise<PaseoProject> {
  const project = (await listProjects(paseo)).find(
    (entry) => entry.projectId === projectId,
  );
  if (!project)
    throw new PluginError(
      "E_VALIDATION_FAILED",
      `Unknown project: ${projectId}`,
    );
  return project;
}

export function workspaceSummary(workspace: PaseoWorkspace): WorkspaceSummary {
  return {
    workspaceId: workspace.id,
    name: workspace.title ?? workspace.name,
    directory: workspace.workspaceDirectory ?? workspace.projectRootPath,
    kind: workspace.workspaceKind,
    background: workspace.background === true,
  };
}

export async function requireWorkspaceDirectory(
  paseo: PaseoApi,
  projectId: string,
  workspaceId: string,
): Promise<string> {
  const project = await requireProject(paseo, projectId);
  const workspace = (await listWorkspaces(paseo)).find(
    (entry) => entry.id === workspaceId,
  );
  if (!workspace || workspace.projectId !== projectId) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      `Workspace ${workspaceId} does not belong to ${projectId}`,
    );
  }
  const directory = workspace.workspaceDirectory ?? project.projectRootPath;
  const resolved = await realpath(directory).catch(() => null);
  if (!resolved) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      `Workspace directory does not exist: ${directory}`,
    );
  }
  return resolved;
}
