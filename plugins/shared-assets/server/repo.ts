import { readdir, lstat, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { PluginError } from "../shared/core/errors";
import {
  assetIdForSkill,
  docAssetId,
  isContainedPath,
  isCredentialPath,
  knowledgeAssetId,
  normalizeRepositoryPath,
  parseDocAssetId,
  parseKnowledgeAssetId,
  parseSkillAssetId,
} from "../shared/core/paths";
import {
  parseTeamAssetsManifest,
  type TeamAssetsManifest,
} from "../shared/core/manifest";
import { parseSkillFrontmatter } from "../shared/core/skill-markdown";
import type {
  AssetFile,
  AssetReadResult,
  AssetSummary,
} from "../shared/core/types";
import {
  MAX_FILE_BYTES,
  readFileLimited,
  resolveInside,
  scanFiles,
} from "./fs-utils";

export const TEXT_LIMIT = 1024 * 1024;
export const IMAGE_LIMIT = 3 * 1024 * 1024;

const IMAGE_MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
};

export async function loadManifest(
  checkout: string,
): Promise<TeamAssetsManifest> {
  let raw: string;
  try {
    raw = await readFile(join(checkout, "team-assets.json"), "utf8");
  } catch {
    throw new PluginError(
      "E_MANIFEST_INVALID",
      "team-assets.json is required at the repository root",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PluginError(
      "E_MANIFEST_INVALID",
      "team-assets.json is not valid JSON",
    );
  }
  const manifest = parseTeamAssetsManifest(parsed);
  if (!manifest) {
    throw new PluginError(
      "E_MANIFEST_INVALID",
      "team-assets.json must contain schemaVersion 1, libraryId and displayName",
    );
  }
  return manifest;
}

async function optionalDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink())
      throw new PluginError("E_PATH_UNSAFE", `symlink is not allowed: ${path}`);
    return info.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function directoryFiles(root: string): Promise<AssetFile[]> {
  const scanned = await scanFiles(root);
  return scanned.map((file) => ({ path: file.path, size: file.size }));
}

function summarize(
  partial: Omit<AssetSummary, "fileCount" | "totalBytes" | "files">,
  files: AssetFile[],
): AssetSummary {
  return {
    ...partial,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files,
  };
}

export async function scanSkills(checkout: string): Promise<{
  assets: AssetSummary[];
  warnings: string[];
}> {
  const assets: AssetSummary[] = [];
  const warnings: string[] = [];
  const scope = "project" as const;
  const root = join(checkout, "skills", scope);
  if (!(await optionalDirectory(root))) return { assets, warnings };
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const path = `skills/${scope}/${entry.name}`;
    const skillRoot = join(checkout, path);
    if ((await lstat(skillRoot).catch(() => null))?.isSymbolicLink()) {
      warnings.push(`${path}: symlink skipped`);
      continue;
    }
    const skillFile = join(skillRoot, "SKILL.md");
    let markdown: string;
    try {
      markdown = await readFileLimited(skillFile, MAX_FILE_BYTES).then(
        (buffer) => buffer.toString("utf8"),
      );
    } catch {
      warnings.push(`${path}: SKILL.md is missing`);
      continue;
    }
    const frontmatter = parseSkillFrontmatter(markdown);
    if (frontmatter.name && frontmatter.name !== entry.name) {
      warnings.push(
        `${path}: frontmatter name "${frontmatter.name}" does not match the directory`,
      );
    }
    const files = await directoryFiles(skillRoot);
    assets.push(
      summarize(
        {
          assetId: assetIdForSkill(scope, entry.name),
          kind: "skill",
          name: entry.name,
          scope,
          description: frontmatter.description,
          path,
          warnings: [],
        },
        files,
      ),
    );
  }
  return { assets, warnings };
}

export async function scanKnowledge(checkout: string): Promise<AssetSummary[]> {
  const root = join(checkout, "knowledge");
  if (!(await optionalDirectory(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const assets: AssetSummary[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = `knowledge/${entry.name}`;
    const info = await stat(join(checkout, path));
    assets.push(
      summarize(
        {
          assetId: knowledgeAssetId(entry.name),
          kind: "knowledge",
          name: entry.name.slice(0, -3),
          scope: null,
          description: null,
          path,
          warnings: [],
        },
        [{ path: entry.name, size: info.size }],
      ),
    );
  }
  return assets;
}

export async function scanDocs(checkout: string): Promise<AssetSummary[]> {
  const root = join(checkout, "docs");
  if (!(await optionalDirectory(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const assets: AssetSummary[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const path = `docs/${entry.name}`;
    try {
      const files = await directoryFiles(join(checkout, path));
      assets.push(
        summarize(
          {
            assetId: docAssetId(entry.name),
            kind: "doc",
            name: entry.name,
            scope: null,
            description: null,
            path,
            warnings: [],
          },
          files,
        ),
      );
    } catch (error) {
      assets.push({
        assetId: docAssetId(entry.name),
        kind: "doc",
        name: entry.name,
        scope: null,
        description: null,
        path,
        fileCount: 0,
        totalBytes: 0,
        files: [],
        warnings: [error instanceof Error ? error.message : String(error)],
      });
    }
  }
  return assets;
}

export async function scanPrompt(
  checkout: string,
): Promise<AssetSummary | null> {
  const path = "AGENTS.md";
  try {
    const info = await lstat(join(checkout, path));
    if (!info.isFile()) return null;
    return summarize(
      {
        assetId: "prompt",
        kind: "prompt",
        name: "AGENTS.md",
        scope: null,
        description: null,
        path,
        warnings: [],
      },
      [{ path, size: info.size }],
    );
  } catch {
    return null;
  }
}

export async function scanAllAssets(checkout: string): Promise<AssetSummary[]> {
  const skills = await scanSkills(checkout);
  const prompt = await scanPrompt(checkout);
  const knowledge = await scanKnowledge(checkout);
  const docs = await scanDocs(checkout);
  return [...(prompt ? [prompt] : []), ...skills.assets, ...knowledge, ...docs];
}

export async function resolveAsset(
  checkout: string,
  assetId: string,
): Promise<AssetSummary | null> {
  const assets = await scanAllAssets(checkout);
  return assets.find((asset) => asset.assetId === assetId) ?? null;
}

export interface ResolvedPublishTarget {
  asset: AssetSummary;
  repositoryPath: string;
  absolutePath: string;
}

export async function resolvePublishTarget(
  checkout: string,
  assetId: string,
  relativePath: string | undefined,
): Promise<ResolvedPublishTarget> {
  const asset = await resolveAsset(checkout, assetId);
  if (!asset)
    throw new PluginError("E_ASSET_NOT_FOUND", `Asset not found: ${assetId}`);

  let repositoryPath: string;
  if (asset.kind === "prompt") {
    repositoryPath = "AGENTS.md";
  } else if (asset.kind === "knowledge" || asset.kind === "doc") {
    if (!relativePath) {
      if (asset.kind === "knowledge") repositoryPath = asset.path;
      else
        throw new PluginError(
          "E_VALIDATION_FAILED",
          "A document file path is required",
        );
    } else {
      const normalized = normalizeRepositoryPath(relativePath);
      if (!normalized)
        throw new PluginError("E_PATH_UNSAFE", "Invalid asset path");
      repositoryPath = `${asset.path}/${normalized}`;
    }
  } else {
    const normalized = normalizeRepositoryPath(relativePath ?? "SKILL.md");
    if (!normalized)
      throw new PluginError("E_PATH_UNSAFE", "Invalid skill path");
    repositoryPath = `${asset.path}/${normalized}`;
  }

  if (!isContainedPath(asset.path, repositoryPath) && asset.kind !== "prompt") {
    throw new PluginError("E_PATH_UNSAFE", "Asset path escapes its package");
  }
  if (!isContainedPath(checkout, join(checkout, repositoryPath))) {
    throw new PluginError(
      "E_PATH_UNSAFE",
      "Path escapes the shared repository",
    );
  }
  if (isCredentialPath(repositoryPath)) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      "Credential files cannot be published",
    );
  }

  const absolutePath = join(checkout, repositoryPath);
  const resolved = await resolveInside(checkout, absolutePath).catch(
    () => absolutePath,
  );
  if (!isContainedPath(checkout, resolved)) {
    throw new PluginError(
      "E_PATH_UNSAFE",
      "Path escapes the shared repository",
    );
  }
  return { asset, repositoryPath, absolutePath };
}

export async function readAsset(
  checkout: string,
  assetId: string,
  relativePath: string | undefined,
): Promise<AssetReadResult> {
  let target: ResolvedPublishTarget;
  if (assetId === "prompt") {
    target = {
      asset: (await scanPrompt(checkout)) ?? ({} as AssetSummary),
      repositoryPath: "AGENTS.md",
      absolutePath: join(checkout, "AGENTS.md"),
    };
  } else if (parseSkillAssetId(assetId)) {
    const asset = await resolveAsset(checkout, assetId);
    if (!asset)
      throw new PluginError("E_ASSET_NOT_FOUND", `Asset not found: ${assetId}`);
    if (!relativePath) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        "A skill file path is required",
      );
    }
    target = await resolvePublishTarget(checkout, assetId, relativePath);
  } else if (parseKnowledgeAssetId(assetId)) {
    target = await resolvePublishTarget(checkout, assetId, undefined);
  } else if (parseDocAssetId(assetId)) {
    if (!relativePath)
      throw new PluginError(
        "E_VALIDATION_FAILED",
        "A document file path is required",
      );
    target = await resolvePublishTarget(checkout, assetId, relativePath);
  } else {
    throw new PluginError("E_ASSET_NOT_FOUND", `Unknown asset: ${assetId}`);
  }

  return await readFileAsAsset(
    assetId,
    target.repositoryPath,
    target.absolutePath,
  );
}

export async function readFileAsAsset(
  assetId: string,
  path: string,
  absolutePath: string,
): Promise<AssetReadResult> {
  const info = await lstat(absolutePath).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new PluginError("E_ASSET_NOT_FOUND", `Asset file not found: ${path}`);
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      `File exceeds ${MAX_FILE_BYTES} bytes`,
    );
  }

  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const mime = IMAGE_MIMES[extension] ?? null;
  if (mime && info.size <= IMAGE_LIMIT) {
    const buffer = await readFile(absolutePath);
    return {
      assetId,
      path,
      kind: "image",
      mimeType: mime,
      content: null,
      dataUri: `data:${mime};base64,${buffer.toString("base64")}`,
      size: buffer.length,
      truncated: false,
    };
  }

  const buffer = await readFile(absolutePath);
  const head = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (head.includes(0)) {
    return {
      assetId,
      path,
      kind: "binary",
      mimeType: mime,
      content: null,
      dataUri: null,
      size: buffer.length,
      truncated: false,
    };
  }
  const truncated = buffer.length > TEXT_LIMIT;
  return {
    assetId,
    path,
    kind: "text",
    mimeType: "text/plain",
    content: buffer.subarray(0, TEXT_LIMIT).toString("utf8"),
    dataUri: null,
    size: buffer.length,
    truncated,
  };
}
