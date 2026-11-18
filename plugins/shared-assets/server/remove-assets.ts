import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PluginError } from "../shared/core/errors";
import {
  parseDocAssetId,
  parseSkillAssetId,
  PROJECT_DIR,
} from "../shared/core/paths";
import type { AssetKind, PluginConfig, ProviderId } from "../shared/core/types";
import type { RemoveSharedAssetsResult } from "../shared/contracts";
import { removeBaselinesFor } from "./baseline";
import { recordEvent } from "./events";
import { assertGitIdentity, headRevision, runGit } from "./git";
import { repoDir } from "./plugin-data";
import { readConfig, requireBinding, writeConfig } from "./registry";
import {
  entityDigest,
  providerSkillTarget,
  skillEntityPath,
  splitSkillRecords,
} from "./skill-entity";

const PUSH_HINT =
  "Commit created locally. Push manually with git push; this MVP never pushes automatically.";

export interface RemovalTarget {
  assetId: string;
  kind: AssetKind;
  name: string;
  path: string;
}

export interface RemovedSharedAsset {
  assetId: string;
  path: string;
}

export interface RemoveSharedAssetsInput {
  projectId: string;
  assetIds: string[];
  deleteLocal?: boolean;
  expectedRevision: string;
}

function nameFromAssetId(value: string): string | null {
  if (!value || value === "." || value === "..") return null;
  if (value.includes("/") || value.includes("\\") || value.includes("\0"))
    return null;
  return value;
}

/**
 * Maps every supported shared asset id to its repository path. Returning null
 * means the id is unknown or names a path outside the asset namespace.
 */
export function resolveRemovalTarget(assetId: string): RemovalTarget | null {
  if (assetId === "prompt") {
    return { assetId, kind: "prompt", name: "AGENTS.md", path: "AGENTS.md" };
  }
  const skill = parseSkillAssetId(assetId);
  if (skill) {
    const name = nameFromAssetId(skill.name);
    return name
      ? {
          assetId,
          kind: "skill",
          name,
          path: `skills/project/${name}`,
        }
      : null;
  }
  if (assetId.startsWith("knowledge/") || assetId.startsWith("knowledge:")) {
    const raw = assetId.startsWith("knowledge:")
      ? assetId.slice("knowledge:".length)
      : assetId.slice("knowledge/".length);
    const name = nameFromAssetId(raw.endsWith(".md") ? raw.slice(0, -3) : raw);
    return name
      ? {
          assetId,
          kind: "knowledge",
          name,
          path: `knowledge/${name}.md`,
        }
      : null;
  }
  const doc = parseDocAssetId(assetId);
  if (doc) {
    const name = nameFromAssetId(doc);
    return name ? { assetId, kind: "doc", name, path: `docs/${name}` } : null;
  }
  return null;
}

export function assertSafeRemovalPath(path: string): void {
  const segments = path.split("/");
  if (
    !path ||
    path === "team-assets.json" ||
    segments.includes("..") ||
    segments.includes(".git") ||
    path.startsWith("/")
  ) {
    throw new PluginError(
      "E_PATH_UNSAFE",
      `Refusing to remove protected repository path: ${path}`,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path)
    .then(() => true)
    .catch(() => false);
}

async function removeIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

async function cleanupSkill(input: {
  projectId: string;
  workspaceDirectory: string;
  target: RemovalTarget;
  deleteLocal: boolean;
  config: PluginConfig;
}): Promise<string[]> {
  const records = input.config.skills[input.projectId] ?? [];
  const { entities } = splitSkillRecords(records);
  const record = entities.find(
    (entry) => entry.assetId === input.target.assetId,
  );
  const entityPath =
    record?.entityPath ??
    skillEntityPath(input.workspaceDirectory, input.target.name);
  const providers = record?.providers ?? [];
  const destinationProvider: ProviderId = providers[0] ?? "codex";
  const kept: string[] = [];

  if (input.deleteLocal) {
    await removeIfExists(entityPath);
    for (const provider of providers) {
      await removeIfExists(
        providerSkillTarget(
          input.workspaceDirectory,
          provider,
          input.target.name,
        ),
      );
    }
  } else if (await exists(entityPath)) {
    const destination = providerSkillTarget(
      input.workspaceDirectory,
      destinationProvider,
      input.target.name,
    );
    const destinationInfo = await lstat(destination).catch(() => null);
    const sourceDigest = await entityDigest(entityPath);
    if (destinationInfo) {
      if (destinationInfo.isSymbolicLink()) {
        await rm(destination, { force: true });
      } else {
        const destinationDigest = await entityDigest(destination);
        if (destinationDigest === null || destinationDigest !== sourceDigest) {
          throw new PluginError(
            "E_VALIDATION_FAILED",
            `Cannot move the Skill back to ${destination}: a different local asset exists`,
          );
        }
        await rm(destination, { recursive: true, force: true });
      }
    }
    await mkdir(dirname(destination), { recursive: true });
    if (entityPath !== destination) await rename(entityPath, destination);
    kept.push(destination);
    for (const provider of providers) {
      if (provider === destinationProvider) continue;
      const path = providerSkillTarget(
        input.workspaceDirectory,
        provider,
        input.target.name,
      );
      const info = await lstat(path).catch(() => null);
      if (info?.isSymbolicLink()) await rm(path, { force: true });
    }
  }

  input.config.skills[input.projectId] = records.filter(
    (entry) => entry.assetId !== input.target.assetId,
  );
  await removeBaselinesFor({
    workspaceDirectory: input.workspaceDirectory,
    assetId: input.target.assetId,
    provider: null,
  });
  return kept;
}

async function cleanupDocument(input: {
  workspaceDirectory: string;
  target: RemovalTarget;
  deleteLocal: boolean;
}): Promise<string[]> {
  const localPath =
    input.target.kind === "knowledge"
      ? join(
          input.workspaceDirectory,
          PROJECT_DIR,
          "knowledge",
          `${input.target.name}.md`,
        )
      : join(input.workspaceDirectory, PROJECT_DIR, "docs", input.target.name);
  if (input.deleteLocal) await removeIfExists(localPath);
  await removeBaselinesFor({
    workspaceDirectory: input.workspaceDirectory,
    assetId: input.target.assetId,
    provider: null,
  });
  return input.deleteLocal || !(await exists(localPath)) ? [] : [localPath];
}

async function cleanupPrompt(input: {
  projectId: string;
  workspaceDirectory: string;
  deleteLocal: boolean;
  config: PluginConfig;
}): Promise<string[]> {
  const stored = input.config.instructions[input.projectId];
  const canonicalPath = join(
    input.workspaceDirectory,
    PROJECT_DIR,
    "AGENTS.md",
  );
  const kept: string[] = [];
  if (input.deleteLocal) {
    await removeIfExists(canonicalPath);
    for (const record of stored?.providers ?? []) {
      await removeIfExists(record.targetPath);
    }
  } else {
    if (await exists(canonicalPath)) kept.push(canonicalPath);
    for (const record of stored?.providers ?? []) {
      if (await exists(record.targetPath)) kept.push(record.targetPath);
    }
  }
  delete input.config.instructions[input.projectId];
  await removeBaselinesFor({
    workspaceDirectory: input.workspaceDirectory,
    assetId: "prompt",
    provider: null,
  });
  return kept;
}

async function cleanupLocal(input: {
  projectId: string;
  workspaceDirectory: string;
  target: RemovalTarget;
  deleteLocal: boolean;
  config: PluginConfig;
}): Promise<string[]> {
  if (input.target.kind === "skill") return await cleanupSkill(input);
  if (input.target.kind === "prompt") return await cleanupPrompt(input);
  return await cleanupDocument(input);
}

export async function removeSharedAssets(
  input: RemoveSharedAssetsInput,
): Promise<RemoveSharedAssetsResult> {
  const binding = await requireBinding(input.projectId);
  const checkout = repoDir(input.projectId);
  const revision = await headRevision(checkout);
  if (revision !== input.expectedRevision) {
    throw new PluginError(
      "E_REVISION_CONFLICT",
      "The shared checkout moved since the preview; refresh and try again",
      { currentRevision: revision },
    );
  }

  const failures: RemoveSharedAssetsResult["failures"] = [];
  const targets: RemovalTarget[] = [];
  const seen = new Set<string>();
  for (const assetId of input.assetIds) {
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    const target = resolveRemovalTarget(assetId);
    if (!target) {
      failures.push({ assetId, reason: "Unknown or unsafe asset id" });
      continue;
    }
    try {
      assertSafeRemovalPath(target.path);
    } catch (error) {
      failures.push({
        assetId,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!(await exists(join(checkout, target.path)))) {
      failures.push({
        assetId,
        reason: "Asset does not exist in the shared repository",
      });
      continue;
    }
    targets.push(target);
  }

  if (targets.length === 0) {
    return {
      commit: null,
      pushed: false,
      pushHint: PUSH_HINT,
      removed: [],
      keptLocal: [],
      failures,
    };
  }

  await assertGitIdentity(checkout);
  const paths = targets.map((target) => target.path);
  try {
    await runGit(checkout, ["rm", "-r", "--quiet", "--", ...paths]);
    const commit = await runGit(checkout, [
      "commit",
      "--quiet",
      "-m",
      `chore(shared-assets): remove ${targets.length} asset(s)`,
      "--",
      ...paths,
    ]);
    if (commit.code !== 0)
      throw new PluginError("E_INTERNAL", "Git commit failed");
  } catch (error) {
    await runGit(checkout, ["reset", "--quiet", "--", ...paths], {
      allowFailure: true,
    });
    await runGit(checkout, ["checkout", "--", ...paths], {
      allowFailure: true,
    });
    throw error;
  }

  const committed = await headRevision(checkout);
  if (!committed)
    throw new PluginError("E_INTERNAL", "Git commit produced no revision");

  const config = await readConfig();
  const removed: RemovedSharedAsset[] = [];
  const keptLocal: string[] = [];
  for (const target of targets) {
    try {
      keptLocal.push(
        ...(await cleanupLocal({
          projectId: input.projectId,
          workspaceDirectory: binding.projectRoot,
          target,
          deleteLocal: input.deleteLocal ?? false,
          config,
        })),
      );
    } catch (error) {
      failures.push({
        assetId: target.assetId,
        reason:
          error instanceof Error
            ? `Shared asset removed, but local cleanup failed: ${error.message}`
            : `Shared asset removed, but local cleanup failed: ${String(error)}`,
      });
    }
    removed.push({ assetId: target.assetId, path: target.path });
  }
  await writeConfig(config);
  for (const entry of removed) {
    await recordEvent(input.projectId, "asset_removed", {
      assetId: entry.assetId,
      path: entry.path,
      deleteLocal: input.deleteLocal ?? false,
      commit: committed,
    });
  }

  return {
    commit: committed,
    pushed: false,
    pushHint: PUSH_HINT,
    removed,
    keptLocal,
    failures,
  };
}
