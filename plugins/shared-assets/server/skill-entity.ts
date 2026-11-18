import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PluginError } from "../shared/core/errors";
import { PROJECT_DIR } from "../shared/core/paths";
import { SKILL_ROOTS } from "../shared/core/providers";
import type {
  LegacySkillProjection,
  ProviderId,
  SkillEntityProjection,
  SkillProjectionMode,
  SkillProjectionStatus,
} from "../shared/core/types";
import {
  copyDirectorySafe,
  directoryDigest,
  fileExists,
  scanFiles,
  sha256,
} from "./fs-utils";

export const LEGACY_SKILL_MESSAGE = "检测到旧版 Skill 投影，需要运行迁移脚本";

export const SKILL_ENTITY_DIR = `${PROJECT_DIR}/skills`;

export type SkillRecordLike =
  SkillEntityProjection | LegacySkillProjection | Record<string, unknown>;

export function skillEntityPath(
  workspaceDirectory: string,
  name: string,
): string {
  return join(workspaceDirectory, PROJECT_DIR, "skills", name);
}

export function providerSkillTarget(
  workspaceDirectory: string,
  provider: ProviderId,
  name: string,
): string {
  const skillRoot = SKILL_ROOTS[provider];
  if (!skillRoot) {
    throw new PluginError(
      "E_PROVIDER_UNSUPPORTED",
      `Provider ${provider} has no verified skill directory`,
    );
  }
  return join(workspaceDirectory, skillRoot, name);
}

/** `<ws>/.paseo/skills/<name>` → `<ws>`. */
export function workspaceFromEntityPath(entityPath: string): string {
  return dirname(dirname(dirname(entityPath)));
}

export function isLegacySkillRecord(record: SkillRecordLike): boolean {
  return (
    !Array.isArray((record as { providers?: unknown }).providers) &&
    typeof (record as { provider?: unknown }).provider === "string"
  );
}

export function splitSkillRecords(records: ReadonlyArray<SkillRecordLike>): {
  entities: SkillEntityProjection[];
  legacy: Array<{
    assetId: string;
    name: string;
    provider: ProviderId;
    targetPath: string;
    baselineDigest: string;
    updatedAt: string;
  }>;
} {
  const entities: SkillEntityProjection[] = [];
  const legacy: Array<{
    assetId: string;
    name: string;
    provider: ProviderId;
    targetPath: string;
    baselineDigest: string;
    updatedAt: string;
  }> = [];
  for (const record of records) {
    if (isLegacySkillRecord(record)) {
      const value = record as unknown as {
        assetId: string;
        name: string;
        provider: ProviderId;
        targetPath: string;
        baselineDigest: string;
        updatedAt: string;
      };
      legacy.push(value);
      continue;
    }
    const value = record as SkillEntityProjection;
    if (
      typeof value.assetId === "string" &&
      typeof value.entityPath === "string" &&
      Array.isArray(value.providers)
    ) {
      entities.push(value);
    }
  }
  return { entities, legacy };
}

async function resolveSymlink(path: string): Promise<string | null> {
  const link = await readlink(path).catch(() => null);
  if (link === null) return null;
  const absolute = isAbsolute(link) ? link : resolve(dirname(path), link);
  return realpath(absolute).catch(() => null);
}

export interface ProjectionEvaluation {
  state: "managed" | "missing" | "modified";
  mode: SkillProjectionMode;
  link: boolean;
}

/**
 * Reads one provider projection. A dangling symlink is `missing`; a symlink
 * that points somewhere else, or a real directory that no longer matches the
 * entity digest, is `modified`.
 */
export async function evaluateSkillProjection(input: {
  targetPath: string;
  entityPath: string;
  entityDigest: string | null;
}): Promise<ProjectionEvaluation> {
  const info = await lstat(input.targetPath).catch(() => null);
  if (!info) return { state: "missing", mode: "symlink", link: false };
  if (info.isSymbolicLink()) {
    const [resolved, entityReal] = await Promise.all([
      resolveSymlink(input.targetPath),
      realpath(input.entityPath).catch(() => null),
    ]);
    if (resolved === null) {
      return { state: "missing", mode: "symlink", link: true };
    }
    if (entityReal !== null && resolved === entityReal) {
      return { state: "managed", mode: "symlink", link: true };
    }
    return { state: "modified", mode: "symlink", link: true };
  }
  if (!info.isDirectory()) {
    return { state: "modified", mode: "copy", link: false };
  }
  const digest = await directoryDigest(input.targetPath)
    .then((result) => result.digest)
    .catch(() => null);
  return {
    state:
      digest !== null &&
      input.entityDigest !== null &&
      digest === input.entityDigest
        ? "managed"
        : "modified",
    mode: "copy",
    link: false,
  };
}

export async function projectionStatuses(input: {
  assetId: string;
  name: string;
  workspaceDirectory: string;
  entityPath: string;
  entityDigest: string | null;
  providers: readonly ProviderId[];
}): Promise<SkillProjectionStatus[]> {
  const statuses: SkillProjectionStatus[] = [];
  for (const provider of input.providers) {
    let targetPath: string;
    try {
      targetPath = providerSkillTarget(
        input.workspaceDirectory,
        provider,
        input.name,
      );
    } catch {
      continue;
    }
    const evaluation = await evaluateSkillProjection({
      targetPath,
      entityPath: input.entityPath,
      entityDigest: input.entityDigest,
    });
    statuses.push({
      assetId: input.assetId,
      provider,
      targetPath,
      state: evaluation.state,
      mode: evaluation.mode,
    });
  }
  return statuses;
}

export interface ProjectSkillResult {
  provider: ProviderId;
  targetPath: string;
  mode: SkillProjectionMode;
}

type SymlinkFn = (target: string, path: string) => Promise<void>;

/**
 * Points one provider directory at the entity. An identical real directory is
 * replaced by a link; a different one is a conflict and is preserved as-is.
 * When `symlink` fails (Windows without privileges) the entity is copied and
 * the projection is reported as `copy` instead of failing the operation.
 */
export async function projectSkillToProvider(input: {
  workspaceDirectory: string;
  provider: ProviderId;
  name: string;
  entityPath: string;
  entityDigest: string;
  symlinkFn?: SymlinkFn;
}): Promise<ProjectSkillResult> {
  const targetPath = providerSkillTarget(
    input.workspaceDirectory,
    input.provider,
    input.name,
  );
  const info = await lstat(targetPath).catch(() => null);
  if (info?.isSymbolicLink()) {
    const [resolved, entityReal] = await Promise.all([
      resolveSymlink(targetPath),
      realpath(input.entityPath).catch(() => null),
    ]);
    if (resolved !== null && entityReal !== null && resolved === entityReal) {
      return { provider: input.provider, targetPath, mode: "symlink" };
    }
    if (resolved !== null) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        `${targetPath} is a symlink that points elsewhere; refusing to replace it`,
      );
    }
    await rm(targetPath, { force: true });
  } else if (info) {
    if (!info.isDirectory()) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        `A file already exists at ${targetPath}`,
      );
    }
    const digest = await directoryDigest(targetPath)
      .then((result) => result.digest)
      .catch(() => null);
    if (digest !== input.entityDigest) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        `A different skill already exists at ${targetPath}`,
        { provider: input.provider, targetPath },
      );
    }
    await rm(targetPath, { recursive: true, force: true });
  }

  await mkdir(dirname(targetPath), { recursive: true });
  const relativeLink = relative(dirname(targetPath), input.entityPath);
  try {
    await (input.symlinkFn ?? symlink)(relativeLink, targetPath);
    return { provider: input.provider, targetPath, mode: "symlink" };
  } catch {
    await copyDirectorySafe(input.entityPath, targetPath);
    return { provider: input.provider, targetPath, mode: "copy" };
  }
}

/** Removes one provider projection; the entity is never touched. */
export async function removeSkillProjection(input: {
  workspaceDirectory: string;
  provider: ProviderId;
  name: string;
  entityPath: string;
  entityDigest: string | null;
}): Promise<{ removed: boolean; keptReason: string | null }> {
  const targetPath = providerSkillTarget(
    input.workspaceDirectory,
    input.provider,
    input.name,
  );
  const evaluation = await evaluateSkillProjection({
    targetPath,
    entityPath: input.entityPath,
    entityDigest: input.entityDigest,
  });
  if (evaluation.state === "missing") {
    return { removed: false, keptReason: null };
  }
  if (evaluation.state === "modified") {
    return {
      removed: false,
      keptReason: "local modifications were kept",
    };
  }
  await rm(targetPath, { recursive: true, force: true });
  return { removed: true, keptReason: null };
}

export async function entityDigest(path: string): Promise<string | null> {
  if (!(await fileExists(path))) return null;
  try {
    return (await directoryDigest(path)).digest;
  } catch {
    return null;
  }
}

/** Copies the shared Skill into `.paseo/skills/<name>` when it is absent. */
export async function ensureSkillEntity(input: {
  sharedPath: string;
  entityPath: string;
}): Promise<{ created: boolean; digest: string }> {
  const existing = await entityDigest(input.entityPath);
  if (existing !== null) return { created: false, digest: existing };
  await mkdir(dirname(input.entityPath), { recursive: true });
  await copyDirectorySafe(input.sharedPath, input.entityPath);
  const digest = await entityDigest(input.entityPath);
  if (digest === null) {
    throw new PluginError(
      "E_INTERNAL",
      `Cannot read the skill entity at ${input.entityPath}`,
    );
  }
  return { created: true, digest };
}

/**
 * Moves a local Skill entity to `.paseo/skills/<name>`. Returns a rollback
 * function that restores the pre-move state.
 */
export async function moveSkillEntity(input: {
  sourcePath: string;
  entityPath: string;
  expectedDigest: string;
}): Promise<{ moved: boolean; digest: string; rollback: () => Promise<void> }> {
  const targetDigest = await entityDigest(input.entityPath);
  if (targetDigest !== null) {
    if (targetDigest !== input.expectedDigest) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        `${input.entityPath} already exists with different content`,
        { entityPath: input.entityPath },
      );
    }
    await rm(input.sourcePath, { recursive: true, force: true });
    return {
      moved: false,
      digest: targetDigest,
      rollback: async () => {
        await copyDirectorySafe(input.entityPath, input.sourcePath);
      },
    };
  }
  await mkdir(dirname(input.entityPath), { recursive: true });
  await rename(input.sourcePath, input.entityPath);
  return {
    moved: true,
    digest: input.expectedDigest,
    rollback: async () => {
      await mkdir(dirname(input.sourcePath), { recursive: true });
      await rename(input.entityPath, input.sourcePath).catch(async () => {
        await copyDirectorySafe(input.entityPath, input.sourcePath);
        await rm(input.entityPath, { recursive: true, force: true });
      });
    },
  };
}

export async function entityFileDigests(
  entityPath: string,
): Promise<Array<{ path: string; digest: string; content: string | null }>> {
  const files = await scanFiles(entityPath);
  const result: Array<{
    path: string;
    digest: string;
    content: string | null;
  }> = [];
  for (const file of files) {
    const buffer = await readFile(join(entityPath, file.path));
    result.push({
      path: file.path,
      digest: sha256(buffer),
      content:
        buffer.length <= 1024 * 1024 && !buffer.subarray(0, 8192).includes(0)
          ? buffer.toString("utf8")
          : null,
    });
  }
  return result;
}
