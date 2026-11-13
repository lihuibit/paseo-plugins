import { PluginError } from "../shared/core/errors";
import { unifiedDiff } from "../shared/core/diff";
import {
  hasConflictMarkers,
  merge3,
  type MergeConflict,
} from "../shared/core/merge";
import type {
  MergeApplyResult,
  MergePreviewResult,
  MergeResolution,
} from "../shared/core/types";
import { findBaseline, readBaselines, writeBaselines } from "./baseline";
import { resolveState, singleFile } from "./asset-state";
import { atomicWriteFile, sha256 } from "./fs-utils";
import { validatePublishContent } from "./validation";

interface MergeInput {
  projectId: string;
  workspaceDirectory: string;
  assetId: string;
  path?: string;
  provider?: string;
}

export async function previewMerge(
  input: MergeInput,
): Promise<MergePreviewResult> {
  const state = await resolveState(input);
  const file = singleFile(state);
  if (file.binary) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      "Binary assets cannot be three-way merged; choose overwrite or keep",
    );
  }
  if (file.localText === null) {
    throw new PluginError(
      "E_ASSET_NOT_FOUND",
      `Local file is missing: ${file.file.localPath}`,
    );
  }
  const base = file.baseText ?? file.remoteText ?? "";
  const remote = file.remoteText ?? "";
  const result = merge3(base, file.localText, remote);
  return {
    assetId: input.assetId,
    repositoryPath: file.file.repositoryPath,
    localPath: file.file.localPath,
    merged: result.merged,
    conflicts: result.conflicts.map((conflict) => view(conflict)),
    hasConflicts: result.conflicts.length > 0,
    expectedLocalDigest: file.localDigest,
    expectedRemoteDigest: file.remoteDigest,
  };
}

function view(conflict: MergeConflict) {
  return {
    ...conflict,
    localDiff: unifiedDiff("local", conflict.base, conflict.local),
    remoteDiff: unifiedDiff("shared", conflict.base, conflict.remote),
  };
}

function applyResolutions(
  merged: string,
  conflicts: MergeConflict[],
  resolutions: MergeResolution[],
): { content: string; missing: string[] } {
  const byId = new Map(resolutions.map((entry) => [entry.conflictId, entry]));
  const missing: string[] = [];
  const lines = merged.split("\n");
  const output: string[] = [];
  let index = 0;
  let conflictIndex = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (line !== "<<<<<<< local") {
      output.push(line);
      index += 1;
      continue;
    }
    const conflict = conflicts[conflictIndex];
    conflictIndex += 1;
    const separator = lines.indexOf("=======", index + 1);
    const end = lines.indexOf(">>>>>>> shared", separator + 1);
    if (!conflict || separator < 0 || end < 0) {
      throw new PluginError("E_INTERNAL", "Malformed merge conflict block");
    }
    const resolution = byId.get(conflict.id);
    if (!resolution) {
      missing.push(conflict.id);
      output.push(...lines.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    if (resolution.choice === "local") {
      output.push(conflict.local);
    } else if (resolution.choice === "remote") {
      output.push(conflict.remote);
    } else if (resolution.choice === "both") {
      output.push(...[conflict.local, conflict.remote].filter(Boolean));
    } else {
      if (resolution.content === undefined) {
        throw new PluginError(
          "E_VALIDATION_FAILED",
          `Resolution ${conflict.id} is missing content`,
        );
      }
      output.push(resolution.content);
    }
    index = end + 1;
  }
  return { content: output.join("\n"), missing };
}

export async function applyMerge(
  input: MergeInput & {
    resolutions: MergeResolution[];
    expectedLocalDigest: string | null;
    expectedRemoteDigest: string | null;
  },
): Promise<MergeApplyResult> {
  const preview = await previewMerge(input);
  if (
    preview.expectedLocalDigest !== input.expectedLocalDigest ||
    preview.expectedRemoteDigest !== input.expectedRemoteDigest
  ) {
    throw new PluginError(
      "E_REVISION_CONFLICT",
      "The local or shared file changed since the merge preview; preview again",
    );
  }
  const state = await resolveState(input);
  const file = singleFile(state);
  const base = file.baseText ?? file.remoteText ?? "";
  const remote = file.remoteText ?? "";
  const result = merge3(base, file.localText ?? "", remote);
  const { content, missing } = applyResolutions(
    result.merged,
    result.conflicts,
    input.resolutions,
  );
  if (
    missing.length > 0 ||
    result.conflicts.length > input.resolutions.length
  ) {
    throw new PluginError(
      "E_CONFLICT_UNRESOLVED",
      "Resolve every conflict before saving",
      { conflicts: result.conflicts.map((conflict) => conflict.id), missing },
    );
  }
  if (hasConflictMarkers(content)) {
    throw new PluginError(
      "E_CONFLICT_UNRESOLVED",
      "The merged file still contains conflict markers",
    );
  }
  validatePublishContent(
    state.resolved.asset,
    file.file.repositoryPath,
    content,
  );

  await atomicWriteFile(file.file.localPath, content);
  const baselines = await readBaselines(state.resolved.workspaceDirectory);
  const key = `${input.assetId}\u0000${state.resolved.provider ?? ""}\u0000${file.file.relativePath}`;
  if (remote === "") {
    delete baselines.entries[key];
  } else {
    baselines.entries[key] = {
      assetId: input.assetId,
      kind: state.resolved.asset.kind,
      path: file.file.relativePath,
      provider: state.resolved.provider,
      digest: sha256(remote),
      content: remote,
      updatedAt: new Date().toISOString(),
    };
  }
  await writeBaselines(state.resolved.workspaceDirectory, baselines);
  const updated = findBaseline(
    baselines,
    input.assetId,
    state.resolved.provider,
    file.file.relativePath,
  );
  return {
    assetId: input.assetId,
    repositoryPath: file.file.repositoryPath,
    content,
    conflictsRemaining: 0,
    baselineUpdatedTo: updated?.digest ?? null,
  };
}
