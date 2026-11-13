import { unifiedDiff } from "../shared/core/diff";
import type { AssetDiffResult } from "../shared/core/types";
import { resolveState, singleFile } from "./asset-state";

export async function assetDiff(input: {
  projectId: string;
  workspaceDirectory: string;
  assetId: string;
  path?: string;
  provider?: string;
}): Promise<AssetDiffResult> {
  const state = await resolveState(input);
  if (state.files.length > 1) {
    const sections = await Promise.all(
      state.files.map(async (file) => ({
        file,
        localDiff: unifiedDiff(
          file.file.repositoryPath,
          file.baseText ?? "",
          file.localText ?? "",
        ),
        remoteDiff: unifiedDiff(
          file.file.repositoryPath,
          file.baseText ?? "",
          file.remoteText ?? "",
        ),
        netDiff: unifiedDiff(
          file.file.repositoryPath,
          file.remoteText ?? "",
          file.localText ?? "",
        ),
      })),
    );
    return {
      assetId: input.assetId,
      path: null,
      kind: sections.some((section) => section.file.binary) ? "binary" : "text",
      base: null,
      local: null,
      remote: null,
      localDiff: sections.map((section) => section.localDiff).join("\n"),
      remoteDiff: sections.map((section) => section.remoteDiff).join("\n"),
      netDiff: sections.map((section) => section.netDiff).join("\n"),
    };
  }

  const file = singleFile(state);
  if (file.binary) {
    return {
      assetId: input.assetId,
      path: file.file.relativePath,
      kind: "binary",
      base: null,
      local: null,
      remote: null,
      localDiff: "",
      remoteDiff: "",
      netDiff: "",
    };
  }
  return {
    assetId: input.assetId,
    path: file.file.relativePath,
    kind: "text",
    base: file.baseText,
    local: file.localText,
    remote: file.remoteText,
    localDiff: unifiedDiff(
      file.file.repositoryPath,
      file.baseText ?? "",
      file.localText ?? "",
    ),
    remoteDiff: unifiedDiff(
      file.file.repositoryPath,
      file.baseText ?? "",
      file.remoteText ?? "",
    ),
    netDiff: unifiedDiff(
      file.file.repositoryPath,
      file.remoteText ?? "",
      file.localText ?? "",
    ),
  };
}
