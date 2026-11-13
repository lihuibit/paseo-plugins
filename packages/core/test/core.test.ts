import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../src/diff";
import { parseTeamAssetsManifest } from "../src/manifest";
import {
  docAssetId,
  isContainedPath,
  isCredentialPath,
  isValidSkillName,
  knowledgeAssetId,
  normalizeRepositoryPath,
  parseDocAssetId,
  parseKnowledgeAssetId,
  parseSkillAssetId,
  assetIdForSkill,
} from "../src/paths";
import {
  expandProvider,
  INSTRUCTION_ENTRYPOINTS,
  SKILL_ROOTS,
} from "../src/providers";
import { parseSkillFrontmatter } from "../src/skill-markdown";

describe("repository paths", () => {
  it("normalizes safe relative paths", () => {
    expect(normalizeRepositoryPath("docs/guide/README.md")).toBe(
      "docs/guide/README.md",
    );
    expect(normalizeRepositoryPath("./docs//a.md")).toBe("docs/a.md");
  });

  it("rejects escapes and absolute paths", () => {
    expect(normalizeRepositoryPath("../secrets")).toBeNull();
    expect(normalizeRepositoryPath("docs/../../secrets")).toBeNull();
    expect(normalizeRepositoryPath("/etc/passwd")).toBeNull();
    expect(normalizeRepositoryPath("docs\\win.md")).toBeNull();
  });

  it("detects containment using segment boundaries", () => {
    expect(isContainedPath("/repo", "/repo/docs/a.md")).toBe(true);
    expect(isContainedPath("/repo", "/repo2/a.md")).toBe(false);
  });

  it("rejects credential-looking files", () => {
    expect(isCredentialPath("knowledge/guide.md")).toBe(false);
    expect(isCredentialPath("docs/keys/id_rsa")).toBe(true);
    expect(isCredentialPath(".env.local")).toBe(true);
    expect(isCredentialPath("certs/client.pem")).toBe(true);
  });

  it("validates skill directory names", () => {
    expect(isValidSkillName("code-review")).toBe(true);
    expect(isValidSkillName("Bad Name")).toBe(false);
    expect(isValidSkillName("../escape")).toBe(false);
  });

  it("round-trips asset ids", () => {
    expect(parseSkillAssetId(assetIdForSkill("global", "review"))).toEqual({
      scope: "global",
      name: "review",
    });
    expect(parseKnowledgeAssetId(knowledgeAssetId("deploy.md"))).toBe("deploy");
    expect(parseDocAssetId(docAssetId("design"))).toBe("design");
    expect(parseSkillAssetId("knowledge/a.md")).toBeNull();
  });
});

describe("skill frontmatter", () => {
  it("reads flat name and description", () => {
    const markdown = [
      "---",
      "name: review",
      'description: "Reviews a diff"',
      "---",
      "",
      "# Body",
    ].join("\n");
    expect(parseSkillFrontmatter(markdown)).toEqual({
      name: "review",
      description: "Reviews a diff",
    });
  });

  it("returns nulls without frontmatter", () => {
    expect(parseSkillFrontmatter("# no frontmatter")).toEqual({
      name: null,
      description: null,
    });
  });
});

describe("team assets manifest", () => {
  it("accepts schema version 1", () => {
    expect(
      parseTeamAssetsManifest({
        schemaVersion: 1,
        libraryId: "team-assets",
        displayName: "Team Assets",
      }),
    ).toEqual({
      schemaVersion: 1,
      libraryId: "team-assets",
      displayName: "Team Assets",
    });
  });

  it("rejects missing or newer schemas", () => {
    expect(
      parseTeamAssetsManifest({
        schemaVersion: 2,
        libraryId: "a",
        displayName: "b",
      }),
    ).toBeNull();
    expect(
      parseTeamAssetsManifest({
        schemaVersion: 1,
        libraryId: "",
        displayName: "b",
      }),
    ).toBeNull();
    expect(parseTeamAssetsManifest(null)).toBeNull();
  });
});

describe("unified diff", () => {
  it("produces a patch for changed lines", () => {
    const diff = unifiedDiff(
      "knowledge/a.md",
      "one\ntwo\n",
      "one\ntwo changed\nthree\n",
    );
    expect(diff).toContain("--- a/knowledge/a.md");
    expect(diff).toContain("+++ b/knowledge/a.md");
    expect(diff).toContain("-two");
    expect(diff).toContain("+two changed");
    expect(diff).toContain("+three");
  });

  it("returns empty text for identical content", () => {
    expect(unifiedDiff("a.md", "same\n", "same\n")).toBe("");
  });
});

describe("provider matrix", () => {
  it("expands both and rejects unknown providers", () => {
    expect(expandProvider("both")).toEqual(["codex", "claude"]);
    expect(expandProvider("codex")).toEqual(["codex"]);
    expect(expandProvider("copilot")).toEqual(["copilot"]);
    expect(expandProvider("unknown")).toEqual([]);
  });

  it("uses the designed projection roots", () => {
    expect(SKILL_ROOTS.codex).toBe(".codex/skills");
    expect(SKILL_ROOTS.claude).toBe(".claude/skills");
    expect(INSTRUCTION_ENTRYPOINTS.codex).toBe("AGENTS.md");
    expect(INSTRUCTION_ENTRYPOINTS.claude).toBe(".claude/CLAUDE.md");
    expect(SKILL_ROOTS.copilot).toBe(".github/skills");
    expect(SKILL_ROOTS.antigravity).toBeNull();
  });
});
