import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PluginError } from "../shared/core/errors";
import {
  expandProvider,
  SKILL_ROOTS,
  SUPPORTED_PROVIDERS,
} from "../shared/core/providers";
import type {
  SkillListResult,
  SkillProjection,
  SkillProjectionStatus,
} from "../shared/core/types";
import {
  copyDirectorySafe,
  directoryDigest,
  fileExists,
  resolveInside,
  scanFiles,
} from "./fs-utils";
import { readConfig, requireBinding, writeConfig } from "./registry";
import { resolveAsset } from "./repo";
import { repoDir } from "./plugin-data";
import { recordBaselineFromFile, removeBaselinesFor } from "./baseline";

function projectionsFor(
  config: Awaited<ReturnType<typeof readConfig>>,
  projectId: string,
) {
  return config.skills[projectId] ?? [];
}

async function digestOrNull(path: string): Promise<string | null> {
  if (!(await fileExists(path))) return null;
  try {
    return (await directoryDigest(path)).digest;
  } catch {
    return null;
  }
}

export async function listSkills(
  projectId: string,
  workspaceDirectory: string | null,
): Promise<SkillListResult> {
  await requireBinding(projectId);
  const { scanSkills } = await import("./repo");
  const scan = await scanSkills(repoDir(projectId));
  const config = await readConfig();
  const records = projectionsFor(config, projectId);
  const projections: SkillProjectionStatus[] = [];

  if (workspaceDirectory) {
    for (const skill of scan.assets) {
      for (const provider of SUPPORTED_PROVIDERS) {
        const skillRoot = SKILL_ROOTS[provider];
        if (!skillRoot) continue;
        const targetPath = join(workspaceDirectory, skillRoot, skill.name);
        const record = records.find(
          (entry) =>
            entry.assetId === skill.assetId &&
            entry.provider === provider &&
            entry.targetPath === targetPath,
        );
        const digest = await digestOrNull(targetPath);
        if (!digest) {
          if (record)
            projections.push({
              assetId: skill.assetId,
              provider,
              targetPath,
              state: "missing",
            });
          continue;
        }
        projections.push({
          assetId: skill.assetId,
          provider,
          targetPath,
          state:
            record && digest === record.baselineDigest ? "managed" : "modified",
        });
      }
    }
  }

  return { skills: scan.assets, projections, warnings: scan.warnings };
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
  const source = join(repoDir(input.projectId), asset.path);
  const { digest: sourceDigest } = await directoryDigest(source);

  const config = await readConfig();
  const records = (config.skills[input.projectId] ??= []);
  const projections: SkillProjectionStatus[] = [];
  const kept: Array<{ targetPath: string; reason: string }> = [];
  const errors: Array<{ provider: string; code: string; message: string }> = [];

  for (const provider of providers) {
    const skillRoot = SKILL_ROOTS[provider];
    if (!skillRoot) {
      errors.push({
        provider,
        code: "E_PROVIDER_UNSUPPORTED",
        message: `Provider ${provider} has no verified skill directory`,
      });
      continue;
    }
    const targetPath = join(input.workspaceDirectory, skillRoot, asset.name);
    const recordIndex = records.findIndex(
      (entry) =>
        entry.assetId === asset.assetId &&
        entry.provider === provider &&
        entry.targetPath === targetPath,
    );
    const record = recordIndex >= 0 ? records[recordIndex] : undefined;
    try {
      await resolveInside(input.workspaceDirectory, targetPath);
      const exists = await fileExists(targetPath);
      const currentDigest = exists ? await digestOrNull(targetPath) : null;

      if (!input.enabled) {
        if (!record) {
          kept.push({ targetPath, reason: "not managed by this plugin" });
          continue;
        }
        if (!exists) {
          records.splice(recordIndex, 1);
          projections.push({
            assetId: asset.assetId,
            provider,
            targetPath,
            state: "missing",
          });
          continue;
        }
        if (currentDigest === record.baselineDigest) {
          await rm(targetPath, { recursive: true, force: true });
          records.splice(recordIndex, 1);
          await removeBaselinesFor({
            workspaceDirectory: input.workspaceDirectory,
            assetId: asset.assetId,
            provider,
          });
          projections.push({
            assetId: asset.assetId,
            provider,
            targetPath,
            state: "missing",
          });
        } else {
          records.splice(recordIndex, 1);
          await removeBaselinesFor({
            workspaceDirectory: input.workspaceDirectory,
            assetId: asset.assetId,
            provider,
          });
          kept.push({ targetPath, reason: "local modifications were kept" });
          projections.push({
            assetId: asset.assetId,
            provider,
            targetPath,
            state: "modified",
          });
        }
        continue;
      }

      if (record && exists && currentDigest !== record.baselineDigest) {
        throw new PluginError(
          "E_LOCAL_CHANGES",
          `Skill at ${targetPath} has local modifications; refusing to overwrite`,
        );
      }
      if (!record && exists && currentDigest !== sourceDigest) {
        throw new PluginError(
          "E_VALIDATION_FAILED",
          `A different skill already exists at ${targetPath}`,
        );
      }

      await mkdir(join(targetPath, ".."), { recursive: true });
      await copyDirectorySafe(source, targetPath);
      const written = await directoryDigest(targetPath);
      if (written.digest !== sourceDigest) {
        throw new PluginError(
          "E_INTERNAL",
          `Projected skill at ${targetPath} is not identical`,
        );
      }

      const entry: SkillProjection = {
        assetId: asset.assetId,
        name: asset.name,
        provider,
        targetPath,
        baselineDigest: sourceDigest,
        updatedAt: new Date().toISOString(),
      };
      if (recordIndex >= 0) records[recordIndex] = entry;
      else records.push(entry);
      const sourceFiles = await scanFiles(source);
      for (const sourceFile of sourceFiles) {
        await recordBaselineFromFile({
          workspaceDirectory: input.workspaceDirectory,
          assetId: asset.assetId,
          kind: "skill",
          provider,
          relativePath: sourceFile.path,
          sourcePath: join(source, sourceFile.path),
        });
      }
      projections.push({
        assetId: asset.assetId,
        provider,
        targetPath,
        state: "managed",
      });
    } catch (error) {
      errors.push({
        provider,
        code: error instanceof PluginError ? error.code : "E_INTERNAL",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  config.skills[input.projectId] = records;
  await writeConfig(config);
  return { enabled: input.enabled, projections, kept, errors };
}

export async function removeSkillProjections(
  projectId: string,
  records: SkillProjection[],
): Promise<{ removed: string[]; preserved: string[] }> {
  const removed: string[] = [];
  const preserved: string[] = [];
  for (const record of records) {
    const exists = await fileExists(record.targetPath);
    if (!exists) {
      removed.push(record.targetPath);
      continue;
    }
    const digest = await digestOrNull(record.targetPath);
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
