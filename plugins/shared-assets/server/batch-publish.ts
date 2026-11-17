import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PluginError } from "../shared/core/errors";
import { unifiedDiff } from "../shared/core/diff";
import type { IgnoreRule } from "../shared/core/ignore";
import {
  parseDocAssetId,
  parseKnowledgeAssetId,
  parseSkillAssetId,
  PROJECT_DIR,
} from "../shared/core/paths";
import { isProviderId, SKILL_ROOTS } from "../shared/core/providers";
import type {
  AssetKind,
  AssetSummary,
  BatchPublishItemPreview,
  BatchPublishItemResult,
  BatchPublishPreview,
  BatchPublishResult,
} from "../shared/core/types";
import { resolveState } from "./asset-state";
import {
  atomicWriteFile,
  fileExists,
  readFileLimited,
  resolveInside,
  scanFiles,
} from "./fs-utils";
import { assertGitIdentity, headRevision, runGit } from "./git";
import { isFileIgnored, isRuleIgnored, readSharedIgnoreRules } from "./ignore";
import { repoDir } from "./plugin-data";
import { resolveAsset, scanPrompt } from "./repo";
import { validatePublishContent, validatePublishPath } from "./validation";

const PUSH_HINT =
  "Commit created locally. Push manually with git push; this plugin never pushes automatically.";

export interface BatchSelection {
  assetId: string;
  path?: string;
  provider?: string;
  create?: boolean;
  kind?: AssetKind;
}

interface BatchInput {
  projectId: string;
  workspaceDirectory: string;
  items: BatchSelection[];
}

interface CreationFile {
  relativePath: string;
  repositoryPath: string;
  absolutePath: string;
  size: number;
  text: string | null;
  buffer: Buffer;
}

interface CreationPlan {
  assetId: string;
  kind: AssetKind;
  name: string;
  targetPath: string;
  files: CreationFile[];
  asset: AssetSummary;
}

function pseudoAsset(input: {
  assetId: string;
  kind: AssetKind;
  name: string;
  repositoryRoot: string;
  files: Array<{ path: string; size: number }>;
}): AssetSummary {
  return {
    assetId: input.assetId,
    kind: input.kind,
    name: input.name,
    scope: "project",
    description: null,
    path: input.repositoryRoot,
    fileCount: input.files.length,
    totalBytes: input.files.reduce((sum, file) => sum + file.size, 0),
    files: input.files,
    warnings: [],
  };
}

async function readCreationFile(input: {
  localPath: string;
  relativePath: string;
  repositoryPath: string;
  asset: AssetSummary;
}): Promise<CreationFile> {
  const buffer = await readFileLimited(input.localPath);
  const binary = buffer.subarray(0, 8192).includes(0);
  const text = binary ? null : buffer.toString("utf8");
  validatePublishPath(input.repositoryPath);
  if (text !== null) {
    validatePublishContent(input.asset, input.repositoryPath, text);
  }
  return {
    relativePath: input.relativePath,
    repositoryPath: input.repositoryPath,
    absolutePath: input.localPath,
    size: buffer.length,
    text,
    buffer,
  };
}

async function creationPlan(input: {
  selection: BatchSelection;
  workspaceDirectory: string;
  checkout: string;
  rules: IgnoreRule[];
}): Promise<CreationPlan> {
  const kind = input.selection.kind;
  if (!kind) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      "A local asset needs a kind before it can be published",
    );
  }
  if (kind === "prompt") {
    if (await scanPrompt(input.checkout)) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        "The shared repository already has AGENTS.md",
      );
    }
    const localRoot = join(input.workspaceDirectory, PROJECT_DIR);
    const localPath = join(localRoot, "AGENTS.md");
    if (!(await fileExists(localPath))) {
      throw new PluginError(
        "E_ASSET_NOT_FOUND",
        `The project has no ${PROJECT_DIR}/AGENTS.md to publish`,
      );
    }
    if (
      isFileIgnored(
        { assetId: "prompt", kind, path: "AGENTS.md" },
        "AGENTS.md",
        input.rules,
      )
    ) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        "AGENTS.md is ignored by the shared ignore rules",
      );
    }
    const asset = pseudoAsset({
      assetId: "prompt",
      kind,
      name: "AGENTS.md",
      repositoryRoot: "AGENTS.md",
      files: [{ path: "AGENTS.md", size: 0 }],
    });
    const file = await readCreationFile({
      localPath,
      relativePath: "AGENTS.md",
      repositoryPath: "AGENTS.md",
      asset,
    });
    return {
      assetId: "prompt",
      kind,
      name: "AGENTS.md",
      targetPath: localPath,
      files: [file],
      asset,
    };
  }

  if (kind === "skill") {
    const parsed = parseSkillAssetId(input.selection.assetId);
    if (!parsed) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        `Invalid Skill asset id: ${input.selection.assetId}`,
      );
    }
    if (await resolveAsset(input.checkout, input.selection.assetId)) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        "The shared repository already has this Skill",
      );
    }
    const provider = input.selection.provider ?? "codex";
    if (!isProviderId(provider)) {
      throw new PluginError(
        "E_PROVIDER_UNSUPPORTED",
        `Unknown provider: ${provider}`,
      );
    }
    const skillRoot = SKILL_ROOTS[provider];
    if (!skillRoot) {
      throw new PluginError(
        "E_PROVIDER_UNSUPPORTED",
        `Provider ${provider} has no project Skill directory`,
      );
    }
    const localRoot = join(input.workspaceDirectory, skillRoot, parsed.name);
    await resolveInside(input.workspaceDirectory, localRoot);
    const repositoryRootPath = `skills/project/${parsed.name}`;
    const scanned = await scanFiles(localRoot, {
      isIgnored: (entry) =>
        isFileIgnored(
          {
            assetId: input.selection.assetId,
            kind,
            path: repositoryRootPath,
          },
          entry,
          input.rules,
        ),
    });
    if (scanned.length === 0) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        `Skill has no files to publish: ${parsed.name}`,
      );
    }
    const asset = pseudoAsset({
      assetId: input.selection.assetId,
      kind,
      name: parsed.name,
      repositoryRoot: repositoryRootPath,
      files: scanned,
    });
    const files = await Promise.all(
      scanned.map((file) =>
        readCreationFile({
          localPath: join(localRoot, file.path),
          relativePath: file.path,
          repositoryPath: `${repositoryRootPath}/${file.path}`,
          asset,
        }),
      ),
    );
    return {
      assetId: input.selection.assetId,
      kind,
      name: parsed.name,
      targetPath: localRoot,
      files,
      asset,
    };
  }

  if (kind === "knowledge") {
    const name = parseKnowledgeAssetId(input.selection.assetId);
    if (!name) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        `Invalid knowledge asset id: ${input.selection.assetId}`,
      );
    }
    if (await resolveAsset(input.checkout, input.selection.assetId)) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        "The shared repository already has this knowledge asset",
      );
    }
    const localRoot = join(input.workspaceDirectory, PROJECT_DIR, "knowledge");
    const localPath = join(localRoot, `${name}.md`);
    await resolveInside(input.workspaceDirectory, localPath);
    if (
      isFileIgnored(
        {
          assetId: input.selection.assetId,
          kind,
          path: `knowledge/${name}.md`,
        },
        `${name}.md`,
        input.rules,
      )
    ) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        `${name}.md is ignored by the shared ignore rules`,
      );
    }
    const asset = pseudoAsset({
      assetId: input.selection.assetId,
      kind,
      name,
      repositoryRoot: `knowledge/${name}.md`,
      files: [{ path: `${name}.md`, size: 0 }],
    });
    const file = await readCreationFile({
      localPath,
      relativePath: `${name}.md`,
      repositoryPath: `knowledge/${name}.md`,
      asset,
    });
    return {
      assetId: input.selection.assetId,
      kind,
      name,
      targetPath: localPath,
      files: [file],
      asset,
    };
  }

  const name = parseDocAssetId(input.selection.assetId);
  if (!name) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      `Invalid document asset id: ${input.selection.assetId}`,
    );
  }
  if (await resolveAsset(input.checkout, input.selection.assetId)) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      "The shared repository already has this document",
    );
  }
  const localRoot = join(input.workspaceDirectory, PROJECT_DIR, "docs", name);
  await resolveInside(input.workspaceDirectory, localRoot);
  const repositoryRootPath = `docs/${name}`;
  const scanned = await scanFiles(localRoot, {
    isIgnored: (entry) =>
      isFileIgnored(
        { assetId: input.selection.assetId, kind, path: repositoryRootPath },
        entry,
        input.rules,
      ),
  });
  if (scanned.length === 0) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      `Document has no files to publish: ${name}`,
    );
  }
  const asset = pseudoAsset({
    assetId: input.selection.assetId,
    kind,
    name,
    repositoryRoot: repositoryRootPath,
    files: scanned,
  });
  const files = await Promise.all(
    scanned.map((file) =>
      readCreationFile({
        localPath: join(localRoot, file.path),
        relativePath: file.path,
        repositoryPath: `${repositoryRootPath}/${file.path}`,
        asset,
      }),
    ),
  );
  return {
    assetId: input.selection.assetId,
    kind,
    name,
    targetPath: localRoot,
    files,
    asset,
  };
}

function creationPreview(plan: CreationPlan): BatchPublishItemPreview {
  const diffs: string[] = [];
  let large = false;
  for (const file of plan.files) {
    if (file.size > 256 * 1024) large = true;
    if (file.text === null) {
      diffs.push(`${file.repositoryPath}: binary file (no line diff)`);
    } else {
      diffs.push(unifiedDiff(file.repositoryPath, "", file.text));
    }
  }
  const reasons: Array<{ code: string; message: string }> = large
    ? [
        {
          code: "E_WARNING_LARGE",
          message: "Large file: review the diff carefully before committing",
        },
      ]
    : [];
  return {
    assetId: plan.assetId,
    kind: plan.kind,
    name: plan.name,
    targetPath: plan.targetPath,
    create: true,
    state: reasons.length > 0 ? "warning" : "eligible",
    reasons,
    files: plan.files.map((file) => ({
      path: file.relativePath,
      repositoryPath: file.repositoryPath,
      size: file.size,
      diff:
        file.text === null
          ? "binary file (no line diff)"
          : unifiedDiff(file.repositoryPath, "", file.text),
    })),
    diff: diffs.join("\n"),
  };
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
    if (selection.create) {
      try {
        const plan = await creationPlan({
          selection,
          workspaceDirectory: input.workspaceDirectory,
          checkout,
          rules,
        });
        items.push(creationPreview(plan));
      } catch (error) {
        const kind = selection.kind ?? "knowledge";
        items.push({
          assetId: selection.assetId,
          kind,
          name: selection.assetId.split("/").pop() ?? selection.assetId,
          targetPath: "",
          create: true,
          state: "ineligible",
          reasons: [
            {
              code:
                error instanceof PluginError
                  ? error.code
                  : "E_VALIDATION_FAILED",
              message: error instanceof Error ? error.message : String(error),
            },
          ],
          files: [],
          diff: "",
        });
      }
      continue;
    }
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
        create: false,
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
      create: false,
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
  before: Buffer | null;
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
  const rules = (await readSharedIgnoreRules(input.projectId)).rules;
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
  const publishableIds = new Set(publishable.map((item) => item.assetId));
  try {
    for (const selection of input.items) {
      if (selection.create) {
        if (!publishableIds.has(selection.assetId)) continue;
        const plan = await creationPlan({
          selection,
          workspaceDirectory: input.workspaceDirectory,
          checkout,
          rules,
        });
        for (const file of plan.files) {
          const absolute = join(checkout, file.repositoryPath);
          const info = await lstat(absolute).catch(() => null);
          const before = info?.isFile() ? await readFile(absolute) : null;
          await atomicWriteFile(absolute, file.buffer);
          written.push({
            repositoryPath: file.repositoryPath,
            before,
          });
        }
        continue;
      }
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
        const before = info?.isFile() ? await readFile(absolute) : null;
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
