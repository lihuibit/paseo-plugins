import { lstat, readFile, rm } from "node:fs/promises";
import { PluginError } from "../shared/core/errors";
import { unifiedDiff } from "../shared/core/diff";
import type {
  BatchPublishItemPreview,
  BatchPublishItemResult,
  BatchPublishPreview,
  BatchPublishResult,
} from "../shared/core/types";
import { resolveState } from "./asset-state";
import { atomicWriteFile } from "./fs-utils";
import { assertGitIdentity, headRevision, runGit } from "./git";
import { readSharedIgnoreRules, isRuleIgnored } from "./ignore";
import { repoDir } from "./plugin-data";
import { validatePublishContent } from "./validation";

const PUSH_HINT =
  "Commit created locally. Push manually with git push; this plugin never pushes automatically.";

export interface BatchSelection {
  assetId: string;
  path?: string;
  provider?: string;
}

interface BatchInput {
  projectId: string;
  workspaceDirectory: string;
  items: BatchSelection[];
}

export async function previewBatchPublish(
  input: BatchInput,
): Promise<BatchPublishPreview> {
  const checkout = repoDir(input.projectId);
  const revision = await headRevision(checkout);
  if (!revision) {
    throw new PluginError("E_INTERNAL", "Shared checkout has no HEAD commit");
  }
  const rules = (await readSharedIgnoreRules(input.projectId)).rules;
  const items: BatchPublishItemPreview[] = [];
  const skipped: Array<{ assetId: string; reason: string }> = [];

  for (const selection of input.items) {
    let state;
    try {
      state = await resolveState({
        projectId: input.projectId,
        workspaceDirectory: input.workspaceDirectory,
        assetId: selection.assetId,
        path: selection.path,
        provider: selection.provider,
      });
    } catch (error) {
      skipped.push({
        assetId: selection.assetId,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const { resolved, files } = state;
    if (
      isRuleIgnored(
        {
          assetId: selection.assetId,
          kind: resolved.asset.kind,
          path: resolved.asset.path,
        },
        rules,
      )
    ) {
      skipped.push({
        assetId: selection.assetId,
        reason: "ignored by the shared ignore rules",
      });
      continue;
    }

    const reasons: Array<{ code: string; message: string }> = [];
    const previews: Array<{
      path: string;
      repositoryPath: string;
      size: number;
      diff: string;
    }> = [];
    let large = false;
    let changed = false;

    for (const file of files) {
      if (file.binary) {
        if (file.localDigest !== file.remoteDigest) {
          reasons.push({
            code: "E_VALIDATION_FAILED",
            message: `Binary files are not supported by batch publish: ${file.file.repositoryPath}`,
          });
        }
        continue;
      }
      if (file.localText === null) continue;
      if (file.localText === file.remoteText) continue;
      if (
        file.baseText !== null &&
        file.localText !== file.baseText &&
        file.remoteText !== file.baseText &&
        file.localText !== file.remoteText
      ) {
        reasons.push({
          code: "E_CONFLICT_UNRESOLVED",
          message: `Unresolved three-way conflict: ${file.file.repositoryPath}`,
        });
        continue;
      }
      try {
        validatePublishContent(
          resolved.asset,
          file.file.repositoryPath,
          file.localText,
        );
      } catch (error) {
        reasons.push({
          code:
            error instanceof PluginError ? error.code : "E_VALIDATION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      changed = true;
      const size = Buffer.byteLength(file.localText, "utf8");
      if (size > 256 * 1024) large = true;
      previews.push({
        path: file.file.relativePath,
        repositoryPath: file.file.repositoryPath,
        size,
        diff: unifiedDiff(
          file.file.repositoryPath,
          file.remoteText ?? "",
          file.localText,
        ),
      });
    }

    if (reasons.length > 0) {
      items.push({
        assetId: selection.assetId,
        kind: resolved.asset.kind,
        name: resolved.asset.name,
        targetPath: resolved.targetPath,
        state: "ineligible",
        reasons,
        files: previews,
        diff: previews.map((entry) => entry.diff).join("\n"),
      });
      continue;
    }
    if (!changed) {
      skipped.push({
        assetId: selection.assetId,
        reason: "no local changes to publish",
      });
      continue;
    }
    if (large) {
      reasons.push({
        code: "E_WARNING_LARGE",
        message: "Large file: review the diff carefully before committing",
      });
    }
    items.push({
      assetId: selection.assetId,
      kind: resolved.asset.kind,
      name: resolved.asset.name,
      targetPath: resolved.targetPath,
      state: reasons.length > 0 ? "warning" : "eligible",
      reasons,
      files: previews,
      diff: previews.map((entry) => entry.diff).join("\n"),
    });
  }

  return { expectedRevision: revision, items, skipped };
}

interface WriteAction {
  repositoryPath: string;
  before: string | null;
}

export async function commitBatchPublish(
  input: BatchInput & { expectedRevision: string; message?: string },
): Promise<BatchPublishResult> {
  const checkout = repoDir(input.projectId);
  const revision = await headRevision(checkout);
  if (revision !== input.expectedRevision) {
    throw new PluginError(
      "E_REVISION_CONFLICT",
      "The shared checkout moved since the preview; refresh and preview again",
      { currentRevision: revision },
    );
  }
  const preview = await previewBatchPublish(input);
  const publishable = preview.items.filter(
    (item) => item.state === "eligible" || item.state === "warning",
  );
  const failed: BatchPublishItemResult[] = preview.items
    .filter((item) => item.state === "ineligible")
    .map((item) => ({
      assetId: item.assetId,
      state: "failed" as const,
      targetPath: item.targetPath,
      files: item.files.map((file) => file.repositoryPath),
      reason: item.reasons.map((reason) => reason.message).join("; "),
    }));
  const skipped: BatchPublishItemResult[] = preview.skipped.map((entry) => ({
    assetId: entry.assetId,
    state: "skipped" as const,
    targetPath: "",
    files: [],
    reason: entry.reason,
  }));
  if (publishable.length === 0) {
    return {
      commit: null,
      pushed: false,
      pushHint: PUSH_HINT,
      published: [],
      failed,
      skipped,
      rolledBack: false,
    };
  }

  await assertGitIdentity(checkout);
  const written: WriteAction[] = [];
  const allowed = new Set(
    publishable.flatMap((item) =>
      item.files.map((file) => file.repositoryPath),
    ),
  );
  try {
    for (const selection of input.items) {
      const state = await resolveState({
        projectId: input.projectId,
        workspaceDirectory: input.workspaceDirectory,
        assetId: selection.assetId,
        path: selection.path,
        provider: selection.provider,
      });
      for (const file of state.files) {
        if (!allowed.has(file.file.repositoryPath)) continue;
        if (file.localText === null || file.localText === file.remoteText) {
          continue;
        }
        const absolute = `${checkout}/${file.file.repositoryPath}`;
        const info = await lstat(absolute).catch(() => null);
        const before = info?.isFile() ? await readFile(absolute, "utf8") : null;
        await atomicWriteFile(absolute, file.localText);
        written.push({
          repositoryPath: file.file.repositoryPath,
          before,
        });
      }
    }
    const paths = written.map((action) => action.repositoryPath);
    if (paths.length === 0) {
      return {
        commit: null,
        pushed: false,
        pushHint: PUSH_HINT,
        published: [],
        failed,
        skipped,
        rolledBack: false,
      };
    }
    await runGit(checkout, ["add", "--", ...paths]);
    const message =
      input.message ?? `chore(shared-assets): publish ${paths.length} file(s)`;
    const commit = await runGit(
      checkout,
      ["commit", "--quiet", "-m", message, "--", ...paths],
      { allowFailure: true },
    );
    if (commit.code !== 0) {
      throw new PluginError("E_INTERNAL", "Git commit failed", {
        output: commit.stderr,
      });
    }
    const head = await headRevision(checkout);
    return {
      commit: head,
      pushed: false,
      pushHint: PUSH_HINT,
      published: publishable.map((item) => ({
        assetId: item.assetId,
        state: "published" as const,
        targetPath: item.targetPath,
        files: item.files.map((file) => file.repositoryPath),
        reason: null,
      })),
      failed,
      skipped,
      rolledBack: false,
    };
  } catch (error) {
    await runGit(
      checkout,
      [
        "reset",
        "--quiet",
        "--",
        ...written.map((action) => action.repositoryPath),
      ],
      { allowFailure: true },
    );
    for (const action of written) {
      const absolute = `${checkout}/${action.repositoryPath}`;
      if (action.before !== null) {
        await atomicWriteFile(absolute, action.before);
      } else {
        await rm(absolute, { force: true });
      }
    }
    throw error;
  }
}
