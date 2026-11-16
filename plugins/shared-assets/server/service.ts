import { appendFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  PluginHandlerContext,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import { fail, ok, PluginError, type RpcEnvelope } from "../shared/core/errors";
import type { Binding, ProjectSummary } from "../shared/core/types";
import type {
  DriftItem,
  ProjectAttention,
  ProjectAttentionItem,
  ProviderId,
  WorkspaceSummary,
} from "../shared/core/types";
import {
  assetsListRpc,
  assetReadRpc,
  batchPublishCommitRpc,
  batchPublishPreviewRpc,
  configureRpc,
  diffRpc,
  driftIgnoreRpc,
  driftListRpc,
  driftResolveRpc,
  driftUnignoreRpc,
  instructionsSetEnabledRpc,
  instructionsStatusRpc,
  ignoreRulesGetRpc,
  ignoreRulesSetRpc,
  mergeApplyRpc,
  mergePreviewRpc,
  migrateLegacyRpc,
  projectsListRpc,
  providersListRpc,
  publishCommitRpc,
  publishPreviewRpc,
  relationshipsAdoptRpc,
  relationshipsBatchUnlinkRpc,
  relationshipsListRpc,
  relationshipsReadLocalRpc,
  relationshipsUnlinkRpc,
  skillsListRpc,
  skillsSetEnabledRpc,
  statusRpc,
  syncRpc,
  unbindRpc,
  workspacePullRpc,
} from "../shared/contracts";
import { cloneRepository } from "./git";
import {
  aheadBehind,
  currentBranch,
  headRevision,
  isDirty,
  remoteRevision,
  runGit,
} from "./git";
import {
  instructionStatus,
  removeInstructionProjections,
  setInstructionsEnabled,
} from "./instructions";
import { ensureDataDirs, logPath, repoDir } from "./plugin-data";
import { commitPublish, previewPublish } from "./publish";
import {
  readConfig,
  requireBinding,
  saveBinding,
  withProjectLock,
  writeConfig,
} from "./registry";
import {
  readAsset,
  scanAllAssets,
  scanDocs,
  scanKnowledge,
  scanSkills,
  loadManifest,
} from "./repo";
import { listSkills, removeSkillProjections, setSkillEnabled } from "./skills";
import {
  listProjects as listPaseoProjects,
  listWorkspaces,
  requireProject,
  requireWorkspaceDirectory,
  workspaceSummary,
} from "./workspace";
import { fileExists } from "./fs-utils";
import { listDrift } from "./drift";
import { assetDiff } from "./diff";
import { applyMerge, previewMerge } from "./merge";
import { commitBatchPublish, previewBatchPublish } from "./batch-publish";
import {
  readDriftIgnores,
  readSharedIgnoreRules,
  writeDriftIgnores,
  writeSharedIgnoreRules,
} from "./ignore";
import { overwriteDrift } from "./drift-actions";
import { materializeWorkspace } from "./materialize";
import { migrateLegacy } from "./migration";
import { listProviderStatuses } from "./providers";
import { resolveAssetForWorkspace } from "./asset-files";
import { clearBaselines } from "./baseline";
import {
  adoptRelationship,
  listRelationships,
  readLocalAsset,
  unlinkRelationship,
} from "./relationships";

async function logRpc(message: string): Promise<void> {
  try {
    await mkdir(dirname(logPath()), { recursive: true });
    await appendFile(logPath(), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never mask the RPC result.
  }
}

async function respond<T>(work: () => Promise<T>): Promise<RpcEnvelope<T>> {
  try {
    return ok(await work());
  } catch (error) {
    if (error instanceof PluginError) {
      await logRpc(`error ${error.code}: ${error.message}`);
      return fail(
        error.code,
        error.message,
        error.details,
        error.retryable,
      ) as RpcEnvelope<T>;
    }
    const message = error instanceof Error ? error.message : String(error);
    await logRpc(`error E_INTERNAL: ${message}`);
    return fail("E_INTERNAL", message) as RpcEnvelope<T>;
  }
}

function emptyState(): Binding["state"] {
  return {
    localRevision: null,
    remoteRevision: null,
    lastFetchedAt: null,
    lastSyncedAt: null,
    operation: "idle",
    dirty: false,
    ahead: 0,
    behind: 0,
    lastError: null,
  };
}

function validateRepoUrl(repoUrl: string): string {
  const value = repoUrl.trim();
  const hasControl = [...value].some(
    (character) => character.charCodeAt(0) < 0x20,
  );
  if (!value || value.startsWith("-") || hasControl) {
    throw new PluginError("E_VALIDATION_FAILED", "Invalid Git repository URL");
  }
  return value;
}

async function swapCheckout(temp: string, target: string): Promise<void> {
  const backup = `${target}.bak-${Date.now()}`;
  let moved = false;
  try {
    if (await fileExists(target)) {
      await rename(target, backup);
      moved = true;
    }
    await rename(temp, target);
    if (moved) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (moved) {
      await rm(target, { recursive: true, force: true }).catch(() => {});
      await rename(backup, target).catch(() => {});
    }
    throw error;
  }
}

async function projects(
  paseo: PluginHandlerContext["paseo"],
): Promise<ProjectSummary[]> {
  const [paseoProjects, workspaces] = await Promise.all([
    listPaseoProjects(paseo),
    listWorkspaces(paseo),
  ]);
  const config = await readConfig();
  const summaries: ProjectSummary[] = paseoProjects
    .map((project) => {
      const binding = config.bindings[project.projectId];
      const workspacesForProject = workspaces
        .filter((workspace) => workspace.projectId === project.projectId)
        .map(workspaceSummary)
        .sort((a, b) => {
          if (a.background !== b.background) return a.background ? 1 : -1;
          if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      const workspace = activeWorkspace(workspacesForProject);
      return {
        projectId: project.projectId,
        displayName: project.projectCustomName ?? project.projectDisplayName,
        rootPath: project.projectRootPath,
        bound: binding !== undefined,
        libraryId: binding?.libraryId ?? null,
        syncMode: binding?.syncMode ?? null,
        workspaces: workspacesForProject,
        workspaceId: workspace?.workspaceId ?? null,
        workspaceName: workspace?.name ?? null,
        workspaceDirectory: workspace?.directory ?? null,
        repoUrl: binding?.repoUrl ?? null,
        branch: binding?.branch ?? null,
        state: binding?.state ?? null,
        attention: emptyAttention(),
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const enriched = await Promise.all(
    summaries.map(async (summary) => {
      const binding = config.bindings[summary.projectId];
      if (!binding) return summary;
      const next = { ...summary, attention: emptyAttention() };
      try {
        const current = await status(summary.projectId);
        next.state = current.binding.state;
      } catch {
        // A missing checkout keeps the stored state; the row still renders.
      }
      if (!summary.workspaceDirectory) return next;
      try {
        const drift = await listDrift(
          summary.projectId,
          summary.workspaceDirectory,
          true,
        );
        next.attention = attentionFromDrift(drift);
      } catch {
        // Drift is advisory; an unreadable checkout must not hide the project.
      }
      return next;
    }),
  );
  return enriched;
}

function activeWorkspace(
  workspaces: readonly WorkspaceSummary[],
): WorkspaceSummary | null {
  return (
    workspaces.find(
      (workspace) => !workspace.background && workspace.kind === "directory",
    ) ??
    workspaces.find((workspace) => !workspace.background) ??
    workspaces[0] ??
    null
  );
}

function emptyAttention(): ProjectAttention {
  return { items: [], conflicts: 0, unpublished: 0, ignored: 0 };
}

function attentionFromDrift(drift: readonly DriftItem[]): ProjectAttention {
  const items: ProjectAttentionItem[] = drift.map((item) => ({
    kind: item.kind,
    provider: item.provider,
    scope: item.scope,
    name: item.name,
    reason: item.status,
    ignored: item.ignored,
  }));
  const active = items.filter((item) => !item.ignored);
  return {
    items,
    conflicts: active.filter((item) => item.reason === "diverged").length,
    unpublished: active.filter((item) => item.reason === "unpublished-local")
      .length,
    ignored: items.filter((item) => item.ignored).length,
  };
}

async function configure(
  input: RpcInput<typeof configureRpc>,
  paseo: PluginHandlerContext["paseo"],
): Promise<{ binding: Binding }> {
  const project = await requireProject(paseo, input.projectId);
  const repoUrl = validateRepoUrl(input.repoUrl);
  const branch = input.branch?.trim() || null;
  const target = repoDir(input.projectId);

  return withProjectLock(input.projectId, async () => {
    const config = await readConfig();
    const existing = config.bindings[input.projectId];
    const repositoryChanged =
      existing !== undefined &&
      (existing.repoUrl !== repoUrl || existing.branch !== branch);
    if (
      existing &&
      existing.repoUrl === repoUrl &&
      existing.branch === branch
    ) {
      existing.syncMode = input.syncMode;
      existing.revision += 1;
      await saveBinding(existing);
      if (repositoryChanged) {
        await clearProjectBaselines(paseo, input.projectId);
      }
      await materializeAll(paseo, input.projectId);
      return { binding: existing };
    }

    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.tmp-${Date.now()}`;
    await cloneRepository(repoUrl, temp, branch);
    try {
      const manifest = await loadManifest(temp);
      await swapCheckout(temp, target);
      const resolvedBranch = branch ?? (await currentBranch(target));
      const head = await headRevision(target);
      const now = new Date().toISOString();
      const binding: Binding = {
        projectId: input.projectId,
        projectRoot: project.projectRootPath,
        libraryId: manifest.libraryId,
        displayName: manifest.displayName,
        repoUrl,
        branch,
        syncMode: input.syncMode,
        configuredAt: existing?.configuredAt ?? now,
        revision: (existing?.revision ?? 0) + 1,
        state: {
          ...emptyState(),
          localRevision: head,
          remoteRevision: resolvedBranch
            ? await remoteRevision(target, resolvedBranch)
            : null,
          lastFetchedAt: now,
          lastSyncedAt: now,
        },
      };
      await saveBinding(binding);
      await clearProjectBaselines(paseo, input.projectId);
      await materializeAll(paseo, input.projectId);
      return { binding };
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
  });
}

async function status(projectId: string) {
  const binding = await requireBinding(projectId);
  const directory = repoDir(projectId);
  const state = { ...binding.state };
  const checkoutExists = await fileExists(directory);
  if (checkoutExists) {
    state.localRevision = await headRevision(directory);
    state.dirty = await isDirty(directory);
    const branch = binding.branch ?? (await currentBranch(directory));
    if (branch) {
      state.remoteRevision = await remoteRevision(directory, branch);
      const counts = await aheadBehind(directory, branch);
      state.ahead = counts.ahead;
      state.behind = counts.behind;
    }
  } else {
    state.localRevision = null;
    state.remoteRevision = null;
    state.dirty = false;
    state.ahead = 0;
    state.behind = 0;
    state.lastError = {
      code: "E_NOT_CONFIGURED",
      message: "The checkout is missing; run configure again",
      retryable: false,
    };
  }

  let sharedExists = false;
  const assetCounts = { skills: 0, knowledge: 0, docs: 0 };
  if (checkoutExists) {
    sharedExists = await fileExists(join(directory, "team-assets.json"));
    const [skills, knowledge, docs] = await Promise.all([
      scanSkills(directory),
      scanKnowledge(directory),
      scanDocs(directory),
    ]);
    assetCounts.skills = skills.assets.length;
    assetCounts.knowledge = knowledge.length;
    assetCounts.docs = docs.length;
  }
  return { binding: { ...binding, state }, sharedExists, assetCounts };
}

async function sync(
  projectId: string,
): Promise<{ binding: Binding; changed: boolean }> {
  return withProjectLock(projectId, async () => {
    const binding = await requireBinding(projectId);
    const directory = repoDir(projectId);
    if (!(await fileExists(directory))) {
      throw new PluginError(
        "E_NOT_CONFIGURED",
        "The checkout is missing; run configure again",
      );
    }
    if (await isDirty(directory)) {
      throw new PluginError(
        "E_LOCAL_CHANGES",
        "The shared checkout has uncommitted changes; commit or discard them before syncing",
      );
    }
    const before = await headRevision(directory);
    const now = new Date().toISOString();
    try {
      await runGit(directory, ["fetch", "--prune", "origin"]);
      binding.state.lastFetchedAt = now;
      const branch = binding.branch ?? (await currentBranch(directory));
      if (!branch)
        throw new PluginError(
          "E_BRANCH_NOT_FOUND",
          "The checkout is in detached HEAD",
        );
      const remote = await remoteRevision(directory, branch);
      if (remote && remote !== before) {
        const merge = await runGit(
          directory,
          ["merge", "--ff-only", `origin/${branch}`],
          {
            allowFailure: true,
          },
        );
        if (merge.code !== 0) {
          binding.state.lastError = {
            code: "E_REVISION_CONFLICT",
            message: "The local checkout has diverged from the remote branch",
            retryable: false,
          };
          await saveBinding(binding);
          throw new PluginError(
            "E_REVISION_CONFLICT",
            "The local checkout has diverged from the remote branch; merge manually",
            { output: merge.stderr },
          );
        }
      }
      const after = await headRevision(directory);
      const counts = await aheadBehind(directory, branch);
      binding.state = {
        ...binding.state,
        localRevision: after,
        remoteRevision: await remoteRevision(directory, branch),
        lastFetchedAt: now,
        lastSyncedAt: now,
        dirty: false,
        ahead: counts.ahead,
        behind: counts.behind,
        lastError: null,
        operation: "idle",
      };
      binding.revision += 1;
      await saveBinding(binding);
      return { binding, changed: before !== after };
    } catch (error) {
      if (error instanceof PluginError) {
        binding.state.operation = "idle";
        binding.state.lastError = {
          code: error.code,
          message: error.message,
          details: error.details,
          retryable: error.retryable,
        };
        await saveBinding(binding);
      }
      throw error;
    }
  });
}

async function materializeAll(
  paseo: PluginHandlerContext["paseo"],
  projectId: string,
): Promise<void> {
  const binding = await requireBinding(projectId);
  const workspaces = (await listWorkspaces(paseo)).filter(
    (workspace) => workspace.projectId === projectId,
  );
  for (const workspace of workspaces) {
    const directory = workspace.workspaceDirectory ?? binding.projectRoot;
    try {
      await materializeWorkspace(projectId, directory);
    } catch (error) {
      await logRpc(
        `warning materialize ${projectId} ${directory}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function clearProjectBaselines(
  paseo: PluginHandlerContext["paseo"],
  projectId: string,
): Promise<void> {
  const binding = await requireBinding(projectId);
  const workspaces = (await listWorkspaces(paseo)).filter(
    (workspace) => workspace.projectId === projectId,
  );
  for (const workspace of workspaces) {
    const directory = workspace.workspaceDirectory ?? binding.projectRoot;
    await clearBaselines(directory).catch(() => {});
  }
}

async function unbind(
  projectId: string,
  force: boolean,
  paseo: PluginHandlerContext["paseo"],
) {
  return withProjectLock(projectId, async () => {
    const config = await readConfig();
    const binding = config.bindings[projectId];
    if (!binding)
      return { configured: false, removedProjections: [], preserved: [] };

    const directory = repoDir(projectId);
    if (!force && (await fileExists(directory))) {
      const branch = binding.branch ?? (await currentBranch(directory));
      const counts = branch
        ? await aheadBehind(directory, branch)
        : { ahead: 0, behind: 0 };
      if ((await isDirty(directory)) || counts.ahead > 0) {
        throw new PluginError(
          "E_LOCAL_CHANGES",
          "The checkout has local changes or unpushed commits; push them or pass force to discard",
          { ahead: counts.ahead },
        );
      }
    }

    const removedProjections: string[] = [];
    const preserved: string[] = [];
    const skillRecords = config.skills[projectId] ?? [];
    if (skillRecords.length > 0) {
      const result = await removeSkillProjections(projectId, skillRecords);
      removedProjections.push(...result.removed);
      preserved.push(...result.preserved);
    }

    const storedInstructions = config.instructions[projectId];
    const instructionWorkspace = storedInstructions?.canonical?.targetPath
      ? dirname(dirname(storedInstructions.canonical.targetPath))
      : storedInstructions?.providers[0]?.provider === "codex"
        ? dirname(storedInstructions.providers[0].targetPath)
        : storedInstructions?.providers[0]
          ? dirname(dirname(storedInstructions.providers[0].targetPath))
          : null;
    if (instructionWorkspace) {
      const result = await removeInstructionProjections(
        projectId,
        instructionWorkspace,
      );
      removedProjections.push(...result.removed);
      preserved.push(...result.preserved);
    }

    await clearProjectBaselines(paseo, projectId);
    const latest = await readConfig();
    delete latest.bindings[projectId];
    delete latest.skills[projectId];
    delete latest.instructions[projectId];
    await saveConfig(latest);
    await rm(directory, { recursive: true, force: true });
    return { configured: true, removedProjections, preserved };
  });
}

async function saveConfig(
  config: Awaited<ReturnType<typeof readConfig>>,
): Promise<void> {
  await ensureDataDirs();
  await writeConfig(config);
}

async function workspaceDirectory(
  paseo: PluginHandlerContext["paseo"],
  projectId: string,
  workspaceId: string,
): Promise<string> {
  return requireWorkspaceDirectory(paseo, projectId, workspaceId);
}

export function registerHandlers(server: PluginServerContext): void {
  server.handle(projectsListRpc, async (_input, context) =>
    respond(() => projects(context.paseo)),
  );

  server.handle(configureRpc, async (input, context) =>
    respond(() => configure(input, context.paseo)),
  );

  server.handle(statusRpc, async (input) =>
    respond(() => status(input.projectId)),
  );

  server.handle(syncRpc, async (input, context) =>
    respond(async () => {
      const result = await sync(input.projectId);
      await materializeAll(context.paseo, input.projectId);
      return result;
    }),
  );

  server.handle(unbindRpc, async (input, context) =>
    respond(() => unbind(input.projectId, input.force, context.paseo)),
  );

  server.handle(assetsListRpc, async (input) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return scanAllAssets(repoDir(input.projectId));
    }),
  );

  server.handle(skillsListRpc, async (input, context) =>
    respond(async () => {
      const workspace = input.workspaceId
        ? await workspaceDirectory(
            context.paseo,
            input.projectId,
            input.workspaceId,
          )
        : null;
      return listSkills(input.projectId, workspace);
    }),
  );

  server.handle(skillsSetEnabledRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return withProjectLock(input.projectId, async () => {
        const workspace = await workspaceDirectory(
          context.paseo,
          input.projectId,
          input.workspaceId,
        );
        return setSkillEnabled({ ...input, workspaceDirectory: workspace });
      });
    }),
  );

  server.handle(relationshipsListRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      const workspace = await workspaceDirectory(
        context.paseo,
        input.projectId,
        input.workspaceId,
      );
      return listRelationships({
        projectId: input.projectId,
        workspaceDirectory: workspace,
        kind: input.kind,
        provider: (input.provider ?? null) as ProviderId | null,
      });
    }),
  );

  server.handle(relationshipsReadLocalRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      const workspace = await workspaceDirectory(
        context.paseo,
        input.projectId,
        input.workspaceId,
      );
      return readLocalAsset({
        workspaceDirectory: workspace,
        kind: input.kind,
        provider: (input.provider ?? null) as ProviderId | null,
        localAssetId: input.localAssetId,
        path: input.path,
      });
    }),
  );

  server.handle(relationshipsAdoptRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return withProjectLock(input.projectId, async () => {
        const workspace = await workspaceDirectory(
          context.paseo,
          input.projectId,
          input.workspaceId,
        );
        return adoptRelationship({
          projectId: input.projectId,
          workspaceDirectory: workspace,
          kind: input.kind,
          provider: (input.provider ?? null) as ProviderId | null,
          assetId: input.assetId,
          localAssetId: input.localAssetId,
          mode: input.mode,
        });
      });
    }),
  );

  server.handle(relationshipsUnlinkRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return withProjectLock(input.projectId, async () => {
        const workspace = await workspaceDirectory(
          context.paseo,
          input.projectId,
          input.workspaceId,
        );
        return unlinkRelationship({
          projectId: input.projectId,
          workspaceDirectory: workspace,
          kind: input.kind,
          provider: (input.provider ?? null) as ProviderId | null,
          assetId: input.assetId,
          deleteLocal: input.deleteLocal,
        });
      });
    }),
  );

  server.handle(relationshipsBatchUnlinkRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return withProjectLock(input.projectId, async () => {
        const workspace = await workspaceDirectory(
          context.paseo,
          input.projectId,
          input.workspaceId,
        );
        const items = [];
        const failed = [];
        for (const assetId of input.assetIds) {
          try {
            items.push(
              await unlinkRelationship({
                projectId: input.projectId,
                workspaceDirectory: workspace,
                kind: input.kind,
                provider: (input.provider ?? null) as ProviderId | null,
                assetId,
                deleteLocal: input.deleteLocal,
              }),
            );
          } catch (error) {
            failed.push({
              assetId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return { items, failed };
      });
    }),
  );

  server.handle(instructionsStatusRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      const workspace = await workspaceDirectory(
        context.paseo,
        input.projectId,
        input.workspaceId,
      );
      return instructionStatus(input.projectId, workspace);
    }),
  );

  server.handle(instructionsSetEnabledRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return withProjectLock(input.projectId, async () => {
        const workspace = await workspaceDirectory(
          context.paseo,
          input.projectId,
          input.workspaceId,
        );
        return setInstructionsEnabled({
          ...input,
          workspaceDirectory: workspace,
        });
      });
    }),
  );

  server.handle(assetReadRpc, async (input) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return readAsset(repoDir(input.projectId), input.assetId, input.path);
    }),
  );

  server.handle(publishPreviewRpc, async (input) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return previewPublish(input);
    }),
  );

  server.handle(publishCommitRpc, async (input) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return withProjectLock(input.projectId, async () => {
        const result = await commitPublish(input);
        const config = await readConfig();
        const binding = config.bindings[input.projectId];
        if (binding) {
          binding.state.localRevision = result.commit;
          binding.state.ahead += 1;
          binding.state.dirty = false;
          binding.revision += 1;
          await saveBinding(binding);
        }
        return result;
      });
    }),
  );

  server.handle(providersListRpc, async () =>
    respond(() => listProviderStatuses()),
  );

  server.handle(driftListRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      const workspace = await workspaceDirectory(
        context.paseo,
        input.projectId,
        input.workspaceId,
      );
      return listDrift(input.projectId, workspace, input.includeIgnored);
    }),
  );

  server.handle(diffRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      const workspace = await workspaceDirectory(
        context.paseo,
        input.projectId,
        input.workspaceId,
      );
      return assetDiff({
        projectId: input.projectId,
        workspaceDirectory: workspace,
        assetId: input.assetId,
        path: input.path,
        provider: input.provider,
      });
    }),
  );

  server.handle(mergePreviewRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      const workspace = await workspaceDirectory(
        context.paseo,
        input.projectId,
        input.workspaceId,
      );
      return previewMerge({
        projectId: input.projectId,
        workspaceDirectory: workspace,
        assetId: input.assetId,
        path: input.path,
        provider: input.provider,
      });
    }),
  );

  server.handle(mergeApplyRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return withProjectLock(input.projectId, async () => {
        const workspace = await workspaceDirectory(
          context.paseo,
          input.projectId,
          input.workspaceId,
        );
        return applyMerge({
          projectId: input.projectId,
          workspaceDirectory: workspace,
          assetId: input.assetId,
          path: input.path,
          provider: input.provider,
          resolutions: input.resolutions,
          expectedLocalDigest: input.expectedLocalDigest,
          expectedRemoteDigest: input.expectedRemoteDigest,
        });
      });
    }),
  );

  server.handle(batchPublishPreviewRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      const workspace = await workspaceDirectory(
        context.paseo,
        input.projectId,
        input.workspaceId,
      );
      return previewBatchPublish({
        projectId: input.projectId,
        workspaceDirectory: workspace,
        items: input.items,
      });
    }),
  );

  server.handle(batchPublishCommitRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return withProjectLock(input.projectId, async () => {
        const workspace = await workspaceDirectory(
          context.paseo,
          input.projectId,
          input.workspaceId,
        );
        const result = await commitBatchPublish({
          projectId: input.projectId,
          workspaceDirectory: workspace,
          items: input.items,
          expectedRevision: input.expectedRevision,
          message: input.message,
        });
        if (result.commit) {
          const config = await readConfig();
          const binding = config.bindings[input.projectId];
          if (binding) {
            binding.state.localRevision = result.commit;
            binding.state.ahead += 1;
            binding.state.dirty = false;
            binding.revision += 1;
            await saveBinding(binding);
          }
        }
        return result;
      });
    }),
  );

  server.handle(ignoreRulesGetRpc, async (input) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return readSharedIgnoreRules(input.projectId);
    }),
  );

  server.handle(ignoreRulesSetRpc, async (input) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return withProjectLock(input.projectId, async () => {
        const result = await writeSharedIgnoreRules(
          input.projectId,
          input.raw,
          input.message,
        );
        if (result.errors.length > 0) {
          throw new PluginError(
            "E_VALIDATION_FAILED",
            "Ignore rules contain errors",
            { errors: result.errors },
          );
        }
        if (result.commit) {
          const config = await readConfig();
          const binding = config.bindings[input.projectId];
          if (binding) {
            binding.state.localRevision = result.commit;
            binding.state.ahead += 1;
            binding.state.dirty = false;
            binding.revision += 1;
            await saveBinding(binding);
          }
        }
        return result;
      });
    }),
  );

  server.handle(driftIgnoreRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return withProjectLock(input.projectId, async () => {
        const workspace = await workspaceDirectory(
          context.paseo,
          input.projectId,
          input.workspaceId,
        );
        const resolved = await resolveAssetForWorkspace({
          projectId: input.projectId,
          workspaceDirectory: workspace,
          assetId: input.assetId,
          provider: input.provider,
        });
        const entries = await readDriftIgnores(workspace);
        const targetPath = input.path ?? resolved.targetPath;
        if (
          !entries.some(
            (entry) =>
              entry.assetId === input.assetId && entry.path === targetPath,
          )
        ) {
          entries.push({
            assetId: input.assetId,
            path: targetPath,
            reason: input.reason ?? "kept local content",
            ignoredAt: new Date().toISOString(),
          });
          await writeDriftIgnores(workspace, entries);
        }
        return listDrift(input.projectId, workspace);
      });
    }),
  );

  server.handle(driftUnignoreRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return withProjectLock(input.projectId, async () => {
        const workspace = await workspaceDirectory(
          context.paseo,
          input.projectId,
          input.workspaceId,
        );
        const resolved = await resolveAssetForWorkspace({
          projectId: input.projectId,
          workspaceDirectory: workspace,
          assetId: input.assetId,
          provider: input.provider,
        });
        const targetPath = input.path ?? resolved.targetPath;
        const entries = (await readDriftIgnores(workspace)).filter(
          (entry) =>
            !(entry.assetId === input.assetId && entry.path === targetPath),
        );
        await writeDriftIgnores(workspace, entries);
        return listDrift(input.projectId, workspace);
      });
    }),
  );

  server.handle(driftResolveRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return withProjectLock(input.projectId, async () => {
        const workspace = await workspaceDirectory(
          context.paseo,
          input.projectId,
          input.workspaceId,
        );
        if (input.action === "overwrite") {
          const result = await overwriteDrift({
            projectId: input.projectId,
            workspaceDirectory: workspace,
            assetId: input.assetId,
            path: input.path ?? undefined,
            provider: input.provider,
          });
          return {
            action: input.action,
            ...result,
            items: await listDrift(input.projectId, workspace),
          };
        }
        const resolved = await resolveAssetForWorkspace({
          projectId: input.projectId,
          workspaceDirectory: workspace,
          assetId: input.assetId,
          provider: input.provider,
        });
        const targetPath = input.path ?? resolved.targetPath;
        const entries = await readDriftIgnores(workspace);
        if (
          !entries.some(
            (entry) =>
              entry.assetId === input.assetId && entry.path === targetPath,
          )
        ) {
          entries.push({
            assetId: input.assetId,
            path: targetPath,
            reason: "kept local content",
            ignoredAt: new Date().toISOString(),
          });
          await writeDriftIgnores(workspace, entries);
        }
        return {
          action: input.action,
          updatedFiles: [],
          keptFiles: [resolved.targetPath],
          removedFiles: [],
          items: await listDrift(input.projectId, workspace),
        };
      });
    }),
  );

  server.handle(workspacePullRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return withProjectLock(input.projectId, async () => {
        const workspace = await workspaceDirectory(
          context.paseo,
          input.projectId,
          input.workspaceId,
        );
        return materializeWorkspace(input.projectId, workspace);
      });
    }),
  );

  server.handle(migrateLegacyRpc, async (input, context) =>
    respond(async () => {
      await requireBinding(input.projectId);
      return withProjectLock(input.projectId, async () => {
        const workspace = await workspaceDirectory(
          context.paseo,
          input.projectId,
          input.workspaceId,
        );
        const report = await migrateLegacy({
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          workspaceDirectory: workspace,
          dryRun: input.dryRun,
        });
        if (report.commit) {
          const config = await readConfig();
          const binding = config.bindings[input.projectId];
          if (binding) {
            binding.state.localRevision = report.commit;
            binding.state.ahead += 1;
            binding.state.dirty = false;
            binding.revision += 1;
            await saveBinding(binding);
          }
        }
        return report;
      });
    }),
  );
}

/**
 * Auto mode only fetches and fast-forwards. Dirty checkouts are skipped so a
 * background tick can never discard local work.
 */
export async function runAutoSync(): Promise<void> {
  const config = await readConfig().catch(() => null);
  if (!config) return;
  for (const binding of Object.values(config.bindings)) {
    if (binding.syncMode !== "auto") continue;
    const directory = repoDir(binding.projectId);
    if (!(await fileExists(directory))) continue;
    try {
      if (await isDirty(directory)) continue;
      await sync(binding.projectId);
    } catch (error) {
      await logRpc(
        `auto-sync ${binding.projectId} skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
