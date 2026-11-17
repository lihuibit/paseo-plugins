import { lstat, readFile, rm } from "node:fs/promises";
import { PluginError } from "../shared/core/errors";
import { unifiedDiff } from "../shared/core/diff";
import { parseSkillFrontmatter } from "../shared/core/skill-markdown";
import type { PublishCommitResult, PublishPreview } from "../shared/core/types";
import { atomicWriteFile, MAX_FILE_BYTES } from "./fs-utils";
import { assertGitIdentity, headRevision, runGit } from "./git";
import { isFileIgnored, isRuleIgnored, readSharedIgnoreRules } from "./ignore";
import { repoDir } from "./plugin-data";
import { resolvePublishTarget } from "./repo";

const PUSH_HINT =
  "Commit created locally. Push manually with git push; this MVP never pushes automatically.";

interface PublishInput {
  projectId: string;
  assetId: string;
  path?: string;
  content: string;
  message?: string;
}

async function validate(input: PublishInput) {
  const checkout = repoDir(input.projectId);
  const target = await resolvePublishTarget(
    checkout,
    input.assetId,
    input.path,
  );
  const rules = (await readSharedIgnoreRules(input.projectId)).rules;
  const relativePath = target.repositoryPath.startsWith(`${target.asset.path}/`)
    ? target.repositoryPath.slice(target.asset.path.length + 1)
    : (target.repositoryPath.split("/").pop() ?? target.repositoryPath);
  if (
    isRuleIgnored(target.asset, rules) ||
    isFileIgnored(target.asset, relativePath, rules)
  ) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      `Path is ignored by the shared ignore rules: ${target.repositoryPath}`,
    );
  }
  const size = Buffer.byteLength(input.content, "utf8");
  if (size > MAX_FILE_BYTES) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      `Content exceeds ${MAX_FILE_BYTES} bytes`,
    );
  }
  if (input.content.includes("\0")) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      "Binary content cannot be published",
    );
  }
  const existing = await lstat(target.absolutePath).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new PluginError(
      "E_PATH_UNSAFE",
      "Refusing to publish through a symlink",
    );
  }
  if (
    target.repositoryPath.endsWith("/SKILL.md") ||
    target.repositoryPath === "SKILL.md"
  ) {
    const frontmatter = parseSkillFrontmatter(input.content);
    if (!frontmatter.name) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        "SKILL.md requires frontmatter name",
      );
    }
    if (frontmatter.name !== target.asset.name) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        `SKILL.md name "${frontmatter.name}" must match skill directory "${target.asset.name}"`,
      );
    }
  }
  let before = "";
  if (existing?.isFile()) {
    before = await readFile(target.absolutePath, "utf8");
  }
  if (before === input.content) {
    throw new PluginError("E_VALIDATION_FAILED", "No changes to publish");
  }
  return { target, before };
}

export async function previewPublish(
  input: PublishInput,
): Promise<PublishPreview> {
  const checkout = repoDir(input.projectId);
  const revision = await headRevision(checkout);
  if (!revision)
    throw new PluginError("E_INTERNAL", "Shared checkout has no HEAD commit");
  const { target, before } = await validate(input);
  const warnings: string[] = [];
  if (Buffer.byteLength(input.content, "utf8") > 256 * 1024) {
    warnings.push("Large file: review the diff carefully before committing.");
  }
  return {
    expectedRevision: revision,
    item: {
      assetId: input.assetId,
      targetPath: target.repositoryPath,
      diff: unifiedDiff(target.repositoryPath, before, input.content),
    },
    warnings,
  };
}

export async function commitPublish(
  input: PublishInput & { expectedRevision: string },
): Promise<PublishCommitResult> {
  const checkout = repoDir(input.projectId);
  const currentRevision = await headRevision(checkout);
  if (currentRevision !== input.expectedRevision) {
    throw new PluginError(
      "E_REVISION_CONFLICT",
      "The shared checkout moved since the preview; refresh and preview again",
      { currentRevision },
    );
  }
  await assertGitIdentity(checkout);
  const { target, before } = await validate(input);
  const existed = await lstat(target.absolutePath)
    .then(() => true)
    .catch(() => false);

  try {
    await atomicWriteFile(target.absolutePath, input.content);
    await runGit(checkout, ["add", "--", target.repositoryPath]);
    const message =
      input.message ?? `chore(shared-assets): update ${input.assetId}`;
    const commit = await runGit(checkout, [
      "commit",
      "--quiet",
      "-m",
      message,
      "--",
      target.repositoryPath,
    ]);
    if (commit.code !== 0)
      throw new PluginError("E_INTERNAL", "Git commit failed");
    const revision = await headRevision(checkout);
    if (!revision)
      throw new PluginError("E_INTERNAL", "Git commit produced no revision");
    return {
      commit: revision,
      targetPath: target.repositoryPath,
      pushed: false,
      pushHint: PUSH_HINT,
    };
  } catch (error) {
    await runGit(checkout, ["reset", "--quiet", "--", target.repositoryPath], {
      allowFailure: true,
    });
    if (existed) {
      await atomicWriteFile(target.absolutePath, before);
    } else {
      await rm(target.absolutePath, { force: true });
    }
    throw error;
  }
}
