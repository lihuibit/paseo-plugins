import { lstat, readFile, readlink, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PluginError } from "../shared/core/errors";
import { unifiedDiff } from "../shared/core/diff";
import { expandProvider, SUPPORTED_PROVIDERS } from "../shared/core/providers";
import type {
  ProviderId,
  SkillEntityProjection,
  SkillEntityStatus,
  SkillListResult,
  SkillProjectionStatus,
} from "../shared/core/types";
import { baselineKey, readBaselines, writeBaselines } from "./baseline";
import { copyDirectorySafe, directoryDigest, fileExists } from "./fs-utils";
import { readConfig, requireBinding, writeConfig } from "./registry";
import { resolveAsset, scanSkills } from "./repo";
import { repoDir } from "./plugin-data";
import {
  LEGACY_SKILL_MESSAGE,
  entityDigest,
  entityFileDigests,
  ensureSkillEntity,
  evaluateSkillProjection,
  moveSkillEntity,
  projectionStatuses,
  providerSkillTarget,
  projectSkillToProvider,
  removeSkillProjection,
  skillEntityPath,
  splitSkillRecords,
  workspaceFromEntityPath,
  type ProjectSkillResult,
  type SkillRecordLike,
} from "./skill-entity";

function recordsFor(
  config: Awaited<ReturnType<typeof readConfig>>,
  projectId: string,
) {
  return config.skills[projectId] ?? [];
}

export async function listLegacySkillProjects(): Promise<string[]> {
  try {
    const config = await readConfig();
    return Object.entries(config.skills)
      .filter(([, records]) => splitSkillRecords(records).legacy.length > 0)
      .map(([projectId]) => projectId);
  } catch {
    return [];
  }
}

function upsertEntity(
  records: SkillRecordLike[],
  entity: SkillEntityProjection,
): void {
  const index = records.findIndex(
    (record) => record.assetId === entity.assetId,
  );
  if (index >= 0) records[index] = entity;
  else records.push(entity);
}

async function replaceEntityBaselines(input: {
  workspaceDirectory: string;
  assetId: string;
  entityPath: string;
  sourcePath?: string;
}): Promise<void> {
  const sourcePath = input.sourcePath ?? input.entityPath;
  const baselines = await readBaselines(input.workspaceDirectory);
  for (const [key, entry] of Object.entries(baselines.entries)) {
    if (entry.assetId === input.assetId && entry.provider === null) {
      delete baselines.entries[key];
    }
  }
  for (const file of await entityFileDigests(sourcePath)) {
    baselines.entries[baselineKey(input.assetId, null, file.path)] = {
      assetId: input.assetId,
      kind: "skill",
      path: file.path,
      provider: null,
      digest: file.digest,
      content: file.content,
      updatedAt: new Date().toISOString(),
    };
  }
  await writeBaselines(input.workspaceDirectory, baselines);
}

async function projectionMode(
  providers: readonly ProviderId[],
  input: {
    workspaceDirectory: string;
    name: string;
    entityPath: string;
    entityDigest: string | null;
  },
): Promise<SkillEntityProjection["mode"]> {
  for (const provider of providers) {
    const evaluation = await evaluateSkillProjection({
      targetPath: providerSkillTarget(
        input.workspaceDirectory,
        provider,
        input.name,
      ),
      entityPath: input.entityPath,
      entityDigest: input.entityDigest,
    });
    if (evaluation.mode === "copy" && evaluation.state !== "missing") {
      return "copy";
    }
  }
  return "symlink";
}

export async function listSkills(
  projectId: string,
  workspaceDirectory: string | null,
): Promise<SkillListResult> {
  await requireBinding(projectId);
  const scan = await scanSkills(repoDir(projectId));
  const config = await readConfig();
  const records = recordsFor(config, projectId);
  const { entities: stored, legacy } = splitSkillRecords(records);
  const warnings = [...scan.warnings];
  if (legacy.length > 0) warnings.push(LEGACY_SKILL_MESSAGE);

  const projections: SkillProjectionStatus[] = [];
  const entities: SkillEntityStatus[] = [];
  if (workspaceDirectory) {
    const seen = new Set<string>();
    for (const skill of scan.assets) {
      const record = stored.find((entry) => entry.assetId === skill.assetId);
      const entityPath =
        record?.entityPath ?? skillEntityPath(workspaceDirectory, skill.name);
      const digest = await entityDigest(entityPath);
      const providers = record?.providers ?? [];
      entities.push({
        assetId: skill.assetId,
        name: skill.name,
        entityPath,
        digest,
        baselineDigest: record?.digest ?? null,
        state:
          digest === null
            ? "missing"
            : record && digest === record.digest
              ? "managed"
              : "modified",
        providers,
        mode: record?.mode ?? "symlink",
        legacy: false,
      });
      seen.add(skill.assetId);
      projections.push(
        ...(await projectionStatuses({
          assetId: skill.assetId,
          name: skill.name,
          workspaceDirectory,
          entityPath,
          entityDigest: digest,
          providers,
        })),
      );
    }
    for (const record of stored) {
      if (seen.has(record.assetId)) continue;
      const digest = await entityDigest(record.entityPath);
      const name = record.name || (record.entityPath.split("/").pop() ?? "");
      entities.push({
        assetId: record.assetId,
        name,
        entityPath: record.entityPath,
        digest,
        baselineDigest: record.digest,
        state:
          digest === null
            ? "missing"
            : digest === record.digest
              ? "managed"
              : "modified",
        providers: record.providers,
        mode: record.mode,
        legacy: false,
      });
      projections.push(
        ...(await projectionStatuses({
          assetId: record.assetId,
          name,
          workspaceDirectory,
          entityPath: record.entityPath,
          entityDigest: digest,
          providers: record.providers,
        })),
      );
    }

    for (const record of legacy) {
      if (!record.targetPath.startsWith(workspaceDirectory)) continue;
      const digest = await entityDigest(record.targetPath);
      projections.push({
        assetId: record.assetId,
        provider: record.provider,
        targetPath: record.targetPath,
        state:
          digest === null
            ? "missing"
            : digest === record.baselineDigest
              ? "managed"
              : "modified",
        mode: "copy",
      });
    }
  }

  return {
    skills: scan.assets,
    projections,
    entities,
    migrationRequired: legacy.length > 0,
    warnings,
  };
}

export async function setSkillEnabled(input: {
  projectId: string;
  workspaceDirectory: string;
  assetId: string;
  provider: string;
  enabled: boolean;
}): Promise<{
  enabled: boolean;
  projections: SkillProjectionStatus[];
  kept: Array<{ targetPath: string; reason: string }>;
  errors: Array<{ provider: string; code: string; message: string }>;
}> {
  const providers = expandProvider(input.provider);
  if (providers.length === 0) {
    throw new PluginError(
      "E_PROVIDER_UNSUPPORTED",
      `Unknown provider: ${input.provider}`,
    );
  }
  const asset = await resolveAsset(repoDir(input.projectId), input.assetId);
  if (!asset || asset.kind !== "skill" || !asset.scope) {
    throw new PluginError(
      "E_ASSET_NOT_FOUND",
      `Skill not found: ${input.assetId}`,
    );
  }
  const config = await readConfig();
  const records = (config.skills[input.projectId] ??= []);
  const { entities, legacy } = splitSkillRecords(records);
  if (
    legacy.some(
      (record) =>
        record.assetId === input.assetId && providers.includes(record.provider),
    )
  ) {
    throw new PluginError("E_VALIDATION_FAILED", LEGACY_SKILL_MESSAGE);
  }

  const record = entities.find((entry) => entry.assetId === input.assetId);
  const entityPath =
    record?.entityPath ?? skillEntityPath(input.workspaceDirectory, asset.name);
  const projections: SkillProjectionStatus[] = [];
  const kept: Array<{ targetPath: string; reason: string }> = [];
  const errors: Array<{ provider: string; code: string; message: string }> = [];

  if (!input.enabled) {
    if (!record) {
      for (const provider of providers) {
        kept.push({
          targetPath: providerSkillTarget(
            input.workspaceDirectory,
            provider,
            asset.name,
          ),
          reason: "not managed by this plugin",
        });
      }
      return { enabled: false, projections, kept, errors };
    }
    const digest = await entityDigest(entityPath);
    for (const provider of providers) {
      const targetPath = providerSkillTarget(
        input.workspaceDirectory,
        provider,
        asset.name,
      );
      if (!record.providers.includes(provider)) {
        kept.push({ targetPath, reason: "not managed by this plugin" });
        continue;
      }
      const result = await removeSkillProjection({
        workspaceDirectory: input.workspaceDirectory,
        provider,
        name: asset.name,
        entityPath,
        entityDigest: digest,
      });
      if (result.keptReason) {
        kept.push({ targetPath, reason: result.keptReason });
      } else {
        record.providers = record.providers.filter(
          (entry) => entry !== provider,
        );
      }
      projections.push({
        assetId: asset.assetId,
        provider,
        targetPath,
        state: result.keptReason ? "modified" : "missing",
        mode: record.mode,
      });
    }
    record.updatedAt = new Date().toISOString();
    upsertEntity(records, record);
    await writeConfig(config);
    return { enabled: false, projections, kept, errors };
  }

  const source = join(repoDir(input.projectId), asset.path);
  let created = false;
  let refreshed = false;
  let digest: string;
  const existingDigest = await entityDigest(entityPath);
  if (record && existingDigest !== null && existingDigest === record.digest) {
    const { digest: sharedDigest } = await directoryDigest(source);
    if (sharedDigest !== existingDigest) {
      // The provider links still resolve after the entity directory is
      // replaced; managed copies in copy-fallback mode must be rebuilt.
      for (const provider of record.providers) {
        const targetPath = providerSkillTarget(
          input.workspaceDirectory,
          provider,
          asset.name,
        );
        const evaluation = await evaluateSkillProjection({
          targetPath,
          entityPath,
          entityDigest: existingDigest,
        });
        if (!evaluation.link && evaluation.state === "managed") {
          await rm(targetPath, { recursive: true, force: true });
        }
      }
      await rm(entityPath, { recursive: true, force: true });
      await copyDirectorySafe(source, entityPath);
      digest = sharedDigest;
      refreshed = true;
    } else {
      digest = existingDigest;
    }
  } else {
    const ensured = await ensureSkillEntity({
      sharedPath: source,
      entityPath,
    });
    created = ensured.created;
    digest = ensured.digest;
  }
  const applied: ProjectSkillResult[] = [];
  for (const provider of providers) {
    try {
      applied.push(
        await projectSkillToProvider({
          workspaceDirectory: input.workspaceDirectory,
          provider,
          name: asset.name,
          entityPath,
          entityDigest: digest,
        }),
      );
    } catch (error) {
      errors.push({
        provider,
        code: error instanceof PluginError ? error.code : "E_INTERNAL",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (applied.length === 0) {
    if (created) await rm(entityPath, { recursive: true, force: true });
    await writeConfig(config);
    return { enabled: true, projections, kept, errors };
  }

  const enabledProviders = [
    ...new Set([
      ...(record?.providers ?? []),
      ...applied.map((entry) => entry.provider),
    ]),
  ].sort() as ProviderId[];
  const mode = await projectionMode(enabledProviders, {
    workspaceDirectory: input.workspaceDirectory,
    name: asset.name,
    entityPath,
    entityDigest: digest,
  });
  upsertEntity(records, {
    assetId: asset.assetId,
    name: asset.name,
    entityPath,
    providers: enabledProviders,
    mode,
    digest,
    updatedAt: new Date().toISOString(),
  });
  await writeConfig(config);
  if (!record || refreshed) {
    await replaceEntityBaselines({
      workspaceDirectory: input.workspaceDirectory,
      assetId: asset.assetId,
      entityPath,
      sourcePath: source,
    });
  }
  projections.push(
    ...(await projectionStatuses({
      assetId: asset.assetId,
      name: asset.name,
      workspaceDirectory: input.workspaceDirectory,
      entityPath,
      entityDigest: digest,
      providers: enabledProviders,
    })),
  );
  return { enabled: true, projections, kept, errors };
}

export async function removeSkillProjections(
  projectId: string,
  records: SkillRecordLike[],
): Promise<{ removed: string[]; preserved: string[] }> {
  const removed: string[] = [];
  const preserved: string[] = [];
  const { entities, legacy } = splitSkillRecords(records);

  for (const record of entities) {
    const workspaceDirectory = workspaceFromEntityPath(record.entityPath);
    const digest = await entityDigest(record.entityPath);
    for (const provider of record.providers) {
      const targetPath = providerSkillTarget(
        workspaceDirectory,
        provider,
        record.name,
      );
      const result = await removeSkillProjection({
        workspaceDirectory,
        provider,
        name: record.name,
        entityPath: record.entityPath,
        entityDigest: digest,
      });
      if (result.keptReason) preserved.push(targetPath);
      else if (result.removed) removed.push(targetPath);
    }
    if (digest === null) {
      removed.push(record.entityPath);
    } else if (digest === record.digest) {
      await rm(record.entityPath, { recursive: true, force: true });
      removed.push(record.entityPath);
    } else {
      preserved.push(record.entityPath);
    }
  }

  for (const record of legacy) {
    if (!(await fileExists(record.targetPath))) {
      removed.push(record.targetPath);
      continue;
    }
    const digest = await entityDigest(record.targetPath);
    if (digest === record.baselineDigest) {
      await rm(record.targetPath, { recursive: true, force: true });
      removed.push(record.targetPath);
    } else {
      preserved.push(record.targetPath);
    }
  }

  const config = await readConfig();
  delete config.skills[projectId];
  await writeConfig(config);
  return { removed, preserved };
}

/**
 * After a local Skill has been written to the shared repository, move its
 * entity into `.paseo/skills/<name>` and point every provider that already
 * holds the same content at that entity. Conflicting provider directories are
 * reported before anything is moved, so publishing never silently overwrites
 * a different Skill.
 */
export async function finalizePublishedSkill(input: {
  projectId: string;
  workspaceDirectory: string;
  assetId: string;
  name: string;
  provider: ProviderId;
}): Promise<SkillEntityProjection> {
  const config = await readConfig();
  const records = (config.skills[input.projectId] ??= []);
  const { legacy } = splitSkillRecords(records);
  if (
    legacy.some(
      (record) =>
        record.provider === input.provider || record.assetId === input.assetId,
    )
  ) {
    throw new PluginError("E_VALIDATION_FAILED", LEGACY_SKILL_MESSAGE);
  }
  const sourcePath = providerSkillTarget(
    input.workspaceDirectory,
    input.provider,
    input.name,
  );
  const localDigest = await entityDigest(sourcePath);
  if (localDigest === null) {
    throw new PluginError(
      "E_ASSET_NOT_FOUND",
      `Local Skill is missing: ${sourcePath}`,
    );
  }
  const entityPath = skillEntityPath(input.workspaceDirectory, input.name);
  const targetPathFor = (provider: ProviderId) =>
    providerSkillTarget(input.workspaceDirectory, provider, input.name);
  const conflicts: Array<{
    provider: ProviderId;
    targetPath: string;
    reason: string;
  }> = [];
  const targets: ProviderId[] = [];
  for (const provider of SUPPORTED_PROVIDERS) {
    if (provider === input.provider) continue;
    const targetPath = targetPathFor(provider);
    const info = await lstat(targetPath).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      const link = await readlink(targetPath).catch(() => "");
      const absolute = isAbsolute(link)
        ? link
        : resolve(dirname(targetPath), link);
      const [resolved, sourceReal, entityReal] = await Promise.all([
        realpath(absolute).catch(() => null),
        realpath(sourcePath).catch(() => null),
        realpath(entityPath).catch(() => null),
      ]);
      if (
        (sourceReal && resolved === sourceReal) ||
        (entityReal && resolved === entityReal)
      ) {
        targets.push(provider);
        continue;
      }
      conflicts.push({
        provider,
        targetPath,
        reason: "existing symlink points elsewhere",
      });
      continue;
    }
    if (!info.isDirectory()) {
      conflicts.push({
        provider,
        targetPath,
        reason: "a file already exists at this path",
      });
      continue;
    }
    const digest = await entityDigest(targetPath);
    if (digest !== localDigest) {
      const [localText, targetText] = await Promise.all([
        readFile(join(sourcePath, "SKILL.md"), "utf8").catch(() => ""),
        readFile(join(targetPath, "SKILL.md"), "utf8").catch(() => ""),
      ]);
      conflicts.push({
        provider,
        targetPath,
        reason: unifiedDiff(
          `${provider}/skills/${input.name}/SKILL.md`,
          targetText,
          localText,
        ),
      });
      continue;
    }
    targets.push(provider);
  }
  const entityExisting = await entityDigest(entityPath);
  if (entityExisting !== null && entityExisting !== localDigest) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      `Skill entity already exists with different content: ${entityPath}`,
      { entityPath },
    );
  }
  if (conflicts.length > 0) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      `Cannot publish ${input.name}: provider Skills differ (${conflicts
        .map((entry) => entry.provider)
        .join(", ")})`,
      { conflicts },
    );
  }

  const moved = await moveSkillEntity({
    sourcePath,
    entityPath,
    expectedDigest: localDigest,
  });
  const affected = [input.provider, ...targets];
  try {
    const applied: ProjectSkillResult[] = [];
    for (const provider of affected) {
      applied.push(
        await projectSkillToProvider({
          workspaceDirectory: input.workspaceDirectory,
          provider,
          name: input.name,
          entityPath,
          entityDigest: localDigest,
        }),
      );
    }
    const providers = applied.map((entry) => entry.provider).sort();
    const mode = applied.some((entry) => entry.mode === "copy")
      ? "copy"
      : "symlink";
    const entity: SkillEntityProjection = {
      assetId: input.assetId,
      name: input.name,
      entityPath,
      providers,
      mode,
      digest: localDigest,
      updatedAt: new Date().toISOString(),
    };
    const index = records.findIndex(
      (record) => record.assetId === input.assetId,
    );
    if (index >= 0) records[index] = entity;
    else records.push(entity);
    await writeConfig(config);
    await replaceEntityBaselines({
      workspaceDirectory: input.workspaceDirectory,
      assetId: input.assetId,
      entityPath,
    });
    return entity;
  } catch (error) {
    for (const provider of affected) {
      const targetPath = targetPathFor(provider);
      if (!(await fileExists(targetPath))) continue;
      await copyDirectorySafe(entityPath, targetPath).catch(() => {});
    }
    await moved.rollback().catch(() => {});
    throw error;
  }
}
