import { PluginError } from "../shared/core/errors";
import {
  resolveAssetForWorkspace,
  type LocalAssetFile,
  type ResolvedAsset,
} from "./asset-files";
import {
  findBaseline,
  readBaselines,
  readTextFile,
  type BaselineEntry,
} from "./baseline";
import { readFile } from "node:fs/promises";
import { fileExists, sha256 } from "./fs-utils";

export interface FileTriple {
  file: LocalAssetFile;
  baseline: BaselineEntry | null;
  baseText: string | null;
  localText: string | null;
  remoteText: string | null;
  baseDigest: string | null;
  localDigest: string | null;
  remoteDigest: string | null;
  binary: boolean;
}

export interface ResolvedState {
  resolved: ResolvedAsset;
  files: FileTriple[];
}

export async function readFileTriple(
  resolved: ResolvedAsset,
  file: LocalAssetFile,
): Promise<FileTriple> {
  const baselines = await readBaselines(resolved.workspaceDirectory);
  const baseline = findBaseline(
    baselines,
    resolved.asset.assetId,
    resolved.provider,
    file.relativePath,
  );
  const [localText, remoteText] = await Promise.all([
    readTextFile(file.localPath),
    readTextFile(file.remotePath),
  ]);
  const localExists = await fileExists(file.localPath);
  const remoteExists = await fileExists(file.remotePath);
  const binary =
    (localExists && localText === null) ||
    (remoteExists && remoteText === null);
  const localDigest =
    localText !== null
      ? sha256(localText)
      : localExists
        ? sha256(await readFile(file.localPath))
        : null;
  const remoteDigest =
    remoteText !== null
      ? sha256(remoteText)
      : remoteExists
        ? sha256(await readFile(file.remotePath))
        : null;
  return {
    file,
    baseline,
    baseText: baseline?.content ?? null,
    localText,
    remoteText,
    baseDigest: baseline?.digest ?? null,
    localDigest,
    remoteDigest,
    binary,
  };
}

export async function resolveState(input: {
  projectId: string;
  workspaceDirectory: string;
  assetId: string;
  path?: string;
  provider?: string;
}): Promise<ResolvedState> {
  const resolved = await resolveAssetForWorkspace(input);
  const requested = input.path
    ? resolved.files.filter(
        (file) =>
          file.relativePath === input.path ||
          file.repositoryPath === input.path ||
          file.repositoryPath.endsWith(`/${input.path}`),
      )
    : resolved.files;
  const files = requested.length > 0 ? requested : resolved.files;
  if (files.length === 0) {
    throw new PluginError(
      "E_ASSET_NOT_FOUND",
      `No files found for ${input.assetId}${input.path ? `: ${input.path}` : ""}`,
    );
  }
  return {
    resolved,
    files: await Promise.all(
      files.map((file) => readFileTriple(resolved, file)),
    ),
  };
}

export function singleFile(state: ResolvedState): FileTriple {
  if (state.files.length !== 1) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      "Select one file for this operation",
      { files: state.files.map((file) => file.file.relativePath) },
    );
  }
  return state.files[0] as FileTriple;
}
