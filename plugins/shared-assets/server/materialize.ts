import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssetKind } from "../shared/core/types";
import { PROJECT_DIR } from "../shared/core/paths";
import {
  baselineKey,
  readBaselines,
  writeBaselines,
  type ScopeBaselines,
} from "./baseline";
import { atomicWriteFile, fileExists, scanFiles, sha256 } from "./fs-utils";
import { repoDir } from "./plugin-data";
import { scanAllAssets } from "./repo";

export interface MaterializeResult {
  imported: string[];
  updated: string[];
  kept: string[];
  removed: string[];
}

interface MaterializeFile {
  assetId: string;
  kind: AssetKind;
  relativePath: string;
  repositoryPath: string;
  localPath: string;
  remotePath: string;
}

async function collectFiles(
  checkout: string,
  workspaceDirectory: string,
): Promise<MaterializeFile[]> {
  const assets = await scanAllAssets(checkout);
  const files: MaterializeFile[] = [];
  const promptRemote = join(checkout, "AGENTS.md");
  if (await fileExists(promptRemote)) {
    files.push({
      assetId: "prompt",
      kind: "prompt",
      relativePath: "AGENTS.md",
      repositoryPath: "AGENTS.md",
      localPath: join(workspaceDirectory, PROJECT_DIR, "AGENTS.md"),
      remotePath: promptRemote,
    });
  }
  for (const asset of assets) {
    if (asset.kind !== "knowledge" && asset.kind !== "doc") continue;
    for (const entry of asset.files) {
      const relativePath = entry.path;
      files.push({
        assetId: asset.assetId,
        kind: asset.kind,
        relativePath,
        repositoryPath:
          asset.kind === "knowledge"
            ? asset.path
            : `${asset.path}/${relativePath}`,
        localPath: join(
          workspaceDirectory,
          PROJECT_DIR,
          asset.kind === "knowledge" ? "knowledge" : "docs",
          asset.kind === "knowledge"
            ? relativePath
            : `${asset.name}/${relativePath}`,
        ),
        remotePath:
          asset.kind === "knowledge"
            ? join(checkout, asset.path)
            : join(checkout, asset.path, relativePath),
      });
    }
  }
  return files;
}

async function copyRemoteFile(
  source: string,
  target: string,
): Promise<{ digest: string; content: string | null }> {
  const buffer = await readFile(source);
  await mkdir(dirname(target), { recursive: true });
  await atomicWriteFile(target, buffer);
  const text =
    buffer.length <= 1024 * 1024 && !buffer.subarray(0, 8192).includes(0)
      ? buffer.toString("utf8")
      : null;
  return { digest: sha256(buffer), content: text };
}

function setEntry(
  baselines: ScopeBaselines,
  file: MaterializeFile,
  digest: string,
  content: string | null,
): void {
  baselines.entries[baselineKey(file.assetId, null, file.relativePath)] = {
    assetId: file.assetId,
    kind: file.kind,
    path: file.relativePath,
    provider: null,
    digest,
    content,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Copies shared knowledge, docs and the canonical prompt into the workspace.
 * Local edits are never overwritten; only files whose content still matches the
 * recorded baseline are advanced to the shared revision.
 */
export async function materializeWorkspace(
  projectId: string,
  workspaceDirectory: string,
): Promise<MaterializeResult> {
  const checkout = repoDir(projectId);
  const baselines = await readBaselines(workspaceDirectory);
  const files = await collectFiles(checkout, workspaceDirectory);
  const result: MaterializeResult = {
    imported: [],
    updated: [],
    kept: [],
    removed: [],
  };

  for (const file of files) {
    if (!(await fileExists(file.remotePath))) continue;
    const remoteBuffer = await readFile(file.remotePath);
    const remoteDigest = sha256(remoteBuffer);
    const localExists = await fileExists(file.localPath);
    if (!localExists) {
      const copied = await copyRemoteFile(file.remotePath, file.localPath);
      setEntry(baselines, file, copied.digest, copied.content);
      result.imported.push(file.localPath);
      continue;
    }
    const localDigest = sha256(await readFile(file.localPath));
    const base =
      baselines.entries[baselineKey(file.assetId, null, file.relativePath)];
    if (!base) {
      setEntry(
        baselines,
        file,
        remoteDigest,
        remoteBuffer.length <= 1024 * 1024 &&
          !remoteBuffer.subarray(0, 8192).includes(0)
          ? remoteBuffer.toString("utf8")
          : null,
      );
      if (localDigest === remoteDigest) continue;
      result.kept.push(file.localPath);
      continue;
    }
    if (localDigest !== base.digest) {
      result.kept.push(file.localPath);
      continue;
    }
    if (localDigest === remoteDigest) continue;
    const copied = await copyRemoteFile(file.remotePath, file.localPath);
    setEntry(baselines, file, copied.digest, copied.content);
    result.updated.push(file.localPath);
  }

  await writeBaselines(workspaceDirectory, baselines);
  return result;
}

/** Lists workspace-local files below `.paseo/knowledge` and docs. */
export async function localWorkingFiles(
  workspaceDirectory: string,
): Promise<string[]> {
  const root = join(workspaceDirectory, PROJECT_DIR);
  if (!(await fileExists(root))) return [];
  return (await scanFiles(root)).map((file) => file.path);
}
