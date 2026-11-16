import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { PluginError } from "../shared/core/errors";
import { isProviderId, SKILL_ROOTS } from "../shared/core/providers";
import {
  parseDocAssetId,
  parseKnowledgeAssetId,
  parseSkillAssetId,
  PROJECT_DIR,
} from "../shared/core/paths";
import type { AssetSummary, ProviderId } from "../shared/core/types";
import { readConfig } from "./registry";
import { repoDir } from "./plugin-data";
import { resolveAsset, scanAllAssets } from "./repo";
import { scanFiles, fileExists } from "./fs-utils";

export interface LocalAssetFile {
  relativePath: string;
  repositoryPath: string;
  localPath: string;
  remotePath: string;
}

export interface ResolvedAsset {
  asset: AssetSummary;
  provider: ProviderId | null;
  workspaceDirectory: string;
  targetPath: string;
  localRoot: string;
  repositoryRoot: string;
  files: LocalAssetFile[];
}

export function parseProvider(value: string | undefined): ProviderId | null {
  if (!value || value === "both") return null;
  if (!isProviderId(value)) {
    throw new PluginError(
      "E_PROVIDER_UNSUPPORTED",
      `Unknown provider: ${value}`,
    );
  }
  return value;
}

async function listRelativeFiles(root: string): Promise<string[]> {
  if (!(await fileExists(root))) return [];
  try {
    const scanned = await scanFiles(root);
    return scanned.map((file) => file.path);
  } catch {
    return [];
  }
}

async function defaultSkillProvider(
  projectId: string,
  assetId: string,
  workspaceDirectory: string,
): Promise<ProviderId> {
  const config = await readConfig();
  const records = config.skills[projectId] ?? [];
  const match = records.find(
    (entry) =>
      entry.assetId === assetId &&
      entry.targetPath.startsWith(workspaceDirectory),
  );
  if (match) return match.provider;
  return "codex";
}

export async function resolveAssetForWorkspace(input: {
  projectId: string;
  workspaceDirectory: string;
  assetId: string;
  path?: string;
  provider?: string;
}): Promise<ResolvedAsset> {
  const checkout = repoDir(input.projectId);
  const asset = await resolveAsset(checkout, input.assetId);
  if (!asset) {
    throw new PluginError(
      "E_ASSET_NOT_FOUND",
      `Asset not found: ${input.assetId}`,
    );
  }
  const provider = parseProvider(input.provider);

  let localRoot: string;
  let repositoryRoot: string;
  let relative: string | null = input.path ?? null;

  if (asset.kind === "prompt") {
    localRoot = join(input.workspaceDirectory, PROJECT_DIR);
    repositoryRoot = checkout;
    relative = "AGENTS.md";
  } else if (asset.kind === "knowledge") {
    const name = parseKnowledgeAssetId(asset.assetId);
    if (!name)
      throw new PluginError(
        "E_ASSET_NOT_FOUND",
        `Unknown asset: ${asset.assetId}`,
      );
    localRoot = join(input.workspaceDirectory, PROJECT_DIR, "knowledge");
    repositoryRoot = join(checkout, "knowledge");
    relative = `${name}.md`;
  } else if (asset.kind === "doc") {
    const name = parseDocAssetId(asset.assetId);
    if (!name)
      throw new PluginError(
        "E_ASSET_NOT_FOUND",
        `Unknown asset: ${asset.assetId}`,
      );
    localRoot = join(input.workspaceDirectory, PROJECT_DIR, "docs", name);
    repositoryRoot = join(checkout, "docs", name);
  } else {
    const parsed = parseSkillAssetId(asset.assetId);
    if (!parsed)
      throw new PluginError(
        "E_ASSET_NOT_FOUND",
        `Unknown asset: ${asset.assetId}`,
      );
    const selected =
      provider ??
      (await defaultSkillProvider(
        input.projectId,
        input.assetId,
        input.workspaceDirectory,
      ));
    const skillRoot = SKILL_ROOTS[selected];
    if (!skillRoot) {
      throw new PluginError(
        "E_PROVIDER_UNSUPPORTED",
        `Provider ${selected} has no verified skill directory`,
      );
    }
    localRoot = join(input.workspaceDirectory, skillRoot, parsed.name);
    repositoryRoot = join(checkout, "skills", parsed.scope, parsed.name);
    return {
      asset,
      provider: selected,
      workspaceDirectory: input.workspaceDirectory,
      targetPath: localRoot,
      localRoot,
      repositoryRoot,
      files: await buildFiles(asset, repositoryRoot, localRoot, relative),
    };
  }

  return {
    asset,
    provider: null,
    workspaceDirectory: input.workspaceDirectory,
    targetPath:
      asset.kind === "prompt"
        ? join(localRoot, "AGENTS.md")
        : join(localRoot, relative ?? ""),
    localRoot,
    repositoryRoot,
    files: await buildFiles(asset, repositoryRoot, localRoot, relative),
  };
}

async function buildFiles(
  asset: AssetSummary,
  repositoryRoot: string,
  localRoot: string,
  relative: string | null,
): Promise<LocalAssetFile[]> {
  let relatives: string[];
  if (relative) {
    relatives = [relative];
  } else if (asset.kind === "prompt" || asset.kind === "knowledge") {
    relatives = [asset.files[0]?.path ?? "AGENTS.md"];
  } else {
    const [remote, local] = await Promise.all([
      listRelativeFiles(repositoryRoot),
      listRelativeFiles(localRoot),
    ]);
    relatives = [...new Set([...remote, ...local])].sort();
  }
  const base =
    asset.kind === "prompt"
      ? ""
      : asset.kind === "knowledge"
        ? "knowledge"
        : asset.kind === "doc"
          ? `docs/${asset.name}`
          : asset.path;
  return relatives.map((entry) => ({
    relativePath: entry,
    repositoryPath: base ? `${base}/${entry}` : entry,
    localPath: join(localRoot, entry),
    remotePath: join(repositoryRoot, entry),
  }));
}

export async function localAssetFileExists(
  file: LocalAssetFile,
): Promise<boolean> {
  return fileExists(file.localPath);
}

export async function listWorkspaceRelative(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function allAssets(projectId: string): Promise<AssetSummary[]> {
  return scanAllAssets(repoDir(projectId));
}
