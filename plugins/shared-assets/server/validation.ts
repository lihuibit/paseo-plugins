import { PluginError } from "../shared/core/errors";
import {
  isCredentialPath,
  normalizeRepositoryPath,
} from "../shared/core/paths";
import { parseSkillFrontmatter } from "../shared/core/skill-markdown";
import type { AssetSummary } from "../shared/core/types";
import { MAX_FILE_BYTES } from "./fs-utils";

export function validatePublishPath(repositoryPath: string): void {
  const normalized = normalizeRepositoryPath(repositoryPath);
  if (!normalized || normalized !== repositoryPath) {
    throw new PluginError(
      "E_PATH_UNSAFE",
      `Invalid repository path: ${repositoryPath}`,
    );
  }
  if (isCredentialPath(repositoryPath)) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      `Credential files cannot be published: ${repositoryPath}`,
    );
  }
}

export function validatePublishContent(
  asset: AssetSummary,
  repositoryPath: string,
  content: string,
): void {
  validatePublishPath(repositoryPath);
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      `Content exceeds ${MAX_FILE_BYTES} bytes: ${repositoryPath}`,
    );
  }
  if (content.includes("\0")) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      `Binary content cannot be published: ${repositoryPath}`,
    );
  }
  if (repositoryPath.endsWith("/SKILL.md") || repositoryPath === "SKILL.md") {
    const frontmatter = parseSkillFrontmatter(content);
    if (!frontmatter.name) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        "SKILL.md requires frontmatter name",
      );
    }
    if (frontmatter.name !== asset.name) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        `SKILL.md name "${frontmatter.name}" must match skill directory "${asset.name}"`,
      );
    }
  }
}
