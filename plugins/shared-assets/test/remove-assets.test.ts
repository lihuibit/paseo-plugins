import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import {
  assertSafeRemovalPath,
  removeSharedAssets,
  resolveRemovalTarget,
} from "../server/remove-assets";
import { headRevision, runGit } from "../server/git";
import { repoDir } from "../server/plugin-data";
import { readConfig, saveBinding } from "../server/registry";
import { readBaselines, recordBaselineFromFile } from "../server/baseline";
import { skillEntityPath } from "../server/skill-entity";

const SKILL = `---
name: review
description: Reviews a diff
---

# Review
`;

let home: string;
let workspace: string;
let checkout: string;

async function bind() {
  await saveBinding({
    projectId: "p1",
    projectRoot: workspace,
    libraryId: "team",
    displayName: "Team Assets",
    repoUrl: "https://example.com/team.git",
    branch: "main",
    syncMode: "manual",
    configuredAt: new Date().toISOString(),
    revision: 1,
    state: {
      localRevision: await headRevision(checkout),
      remoteRevision: await headRevision(checkout),
      lastFetchedAt: null,
      lastSyncedAt: null,
      operation: "idle",
      dirty: false,
      ahead: 0,
      behind: 0,
      lastError: null,
    },
  });
}

async function recordBaseline(
  assetId: string,
  kind: "skill" | "prompt" | "knowledge" | "doc",
  relativePath: string,
  sourcePath: string,
) {
  await recordBaselineFromFile({
    workspaceDirectory: workspace,
    assetId,
    kind,
    provider: null,
    relativePath,
    sourcePath,
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "shared-assets-remove-home-"));
  workspace = await mkdtemp(join(tmpdir(), "shared-assets-remove-workspace-"));
  process.env.PASEO_HOME = home;
  checkout = repoDir("p1");
  await mkdir(join(checkout, "skills", "project", "review"), {
    recursive: true,
  });
  await mkdir(join(checkout, "knowledge"), { recursive: true });
  await mkdir(join(checkout, "docs", "design"), { recursive: true });
  await writeFile(join(checkout, "skills/project/review/SKILL.md"), SKILL);
  await writeFile(join(checkout, "knowledge/alpha.md"), "# Alpha\n");
  await writeFile(join(checkout, "docs/design/README.md"), "# Design\n");
  await writeFile(join(checkout, "AGENTS.md"), "# Shared instructions\n");
  await writeFile(
    join(checkout, "team-assets.json"),
    JSON.stringify({
      schemaVersion: 1,
      libraryId: "team",
      displayName: "Team",
    }),
  );
  await runGit(checkout, ["init", "--quiet"]);
  await runGit(checkout, ["config", "user.name", "Test"]);
  await runGit(checkout, ["config", "user.email", "test@example.invalid"]);
  await runGit(checkout, ["add", "."]);
  await runGit(checkout, ["commit", "--quiet", "-m", "seed"]);
  await bind();
});

describe("asset id path resolution", () => {
  it("resolves all four asset kinds to repository paths", () => {
    expect(resolveRemovalTarget("skill:project/review")?.path).toBe(
      "skills/project/review",
    );
    expect(resolveRemovalTarget("doc/design")?.path).toBe("docs/design");
    expect(resolveRemovalTarget("knowledge/alpha.md")?.path).toBe(
      "knowledge/alpha.md",
    );
    expect(resolveRemovalTarget("knowledge:alpha")?.path).toBe(
      "knowledge/alpha.md",
    );
    expect(resolveRemovalTarget("prompt")?.path).toBe("AGENTS.md");
  });

  it("rejects unknown and unsafe ids", () => {
    expect(resolveRemovalTarget("doc/..")).toBeNull();
    expect(resolveRemovalTarget("knowledge:..")).toBeNull();
    expect(resolveRemovalTarget("skill:project/..")).toBeNull();
    expect(resolveRemovalTarget("unknown")).toBeNull();
  });

  it("rejects protected repository paths", () => {
    expect(() => assertSafeRemovalPath("")).toThrow(/protected/);
    expect(() => assertSafeRemovalPath("team-assets.json")).toThrow(
      /protected/,
    );
    expect(() => assertSafeRemovalPath(".git/config")).toThrow(/protected/);
    expect(() => assertSafeRemovalPath("docs/../team-assets.json")).toThrow(
      /protected/,
    );
  });
});

describe("shared asset removal", () => {
  it("removes a Skill and moves its entity back to the first provider", async () => {
    const entityPath = skillEntityPath(workspace, "review");
    await mkdir(entityPath, { recursive: true });
    await writeFile(join(entityPath, "SKILL.md"), SKILL);
    await mkdir(join(workspace, ".codex/skills"), { recursive: true });
    await mkdir(join(workspace, ".claude/skills"), { recursive: true });
    await symlink(
      "../../.paseo/skills/review",
      join(workspace, ".codex/skills/review"),
    );
    await symlink(
      "../../.paseo/skills/review",
      join(workspace, ".claude/skills/review"),
    );
    const config = await readConfig();
    config.skills.p1 = [
      {
        assetId: "skill:project/review",
        name: "review",
        entityPath,
        providers: ["codex", "claude"],
        mode: "symlink",
        digest: "digest",
        updatedAt: new Date().toISOString(),
      },
    ];
    await writeFile(
      join(home, "plugin-data/paseo-shared-assets/config.json"),
      JSON.stringify(config, null, 2),
    );
    await recordBaseline(
      "skill:project/review",
      "skill",
      "SKILL.md",
      join(entityPath, "SKILL.md"),
    );

    const result = await removeSharedAssets({
      projectId: "p1",
      assetIds: ["skill:project/review"],
      expectedRevision: (await headRevision(checkout))!,
    });

    expect(result.commit).not.toBeNull();
    expect(result.removed).toEqual([
      { assetId: "skill:project/review", path: "skills/project/review" },
    ]);
    expect(existsSync(join(checkout, "skills/project/review"))).toBe(false);
    expect(existsSync(entityPath)).toBe(false);
    expect(
      await readFile(join(workspace, ".codex/skills/review/SKILL.md"), "utf8"),
    ).toContain("Reviews a diff");
    expect(existsSync(join(workspace, ".claude/skills/review"))).toBe(false);
    expect(result.keptLocal).toEqual([join(workspace, ".codex/skills/review")]);
    expect((await readConfig()).skills.p1).toEqual([]);
    const baselines = await readBaselines(workspace);
    expect(
      Object.values(baselines.entries).filter(
        (entry) => entry.assetId === "skill:project/review",
      ),
    ).toHaveLength(0);
    const message = await runGit(checkout, ["log", "-1", "--pretty=%s"]);
    expect(message.stdout).toBe("chore(shared-assets): remove 1 asset(s)");
    const events = (
      await readFile(
        join(home, "plugin-data/paseo-shared-assets/logs/events.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; detail: unknown });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "asset_removed",
        detail: expect.objectContaining({
          assetId: "skill:project/review",
          path: "skills/project/review",
          deleteLocal: false,
          commit: result.commit,
        }),
      }),
    );
  });

  it("keeps Doc and Knowledge locally by default and removes their baselines", async () => {
    await mkdir(join(workspace, ".paseo/docs/design"), { recursive: true });
    await writeFile(
      join(workspace, ".paseo/docs/design/README.md"),
      "# Local design\n",
    );
    await mkdir(join(workspace, ".paseo/knowledge"), { recursive: true });
    await writeFile(
      join(workspace, ".paseo/knowledge/alpha.md"),
      "# Local alpha\n",
    );
    await recordBaseline(
      "doc/design",
      "doc",
      "README.md",
      join(checkout, "docs/design/README.md"),
    );
    await recordBaseline(
      "knowledge/alpha.md",
      "knowledge",
      "alpha.md",
      join(checkout, "knowledge/alpha.md"),
    );

    const result = await removeSharedAssets({
      projectId: "p1",
      assetIds: ["doc/design", "knowledge/alpha.md"],
      expectedRevision: (await headRevision(checkout))!,
    });

    expect(result.removed).toHaveLength(2);
    expect(existsSync(join(checkout, "docs/design"))).toBe(false);
    expect(existsSync(join(checkout, "knowledge/alpha.md"))).toBe(false);
    expect(existsSync(join(workspace, ".paseo/docs/design/README.md"))).toBe(
      true,
    );
    expect(existsSync(join(workspace, ".paseo/knowledge/alpha.md"))).toBe(true);
    expect(result.keptLocal).toHaveLength(2);
    const baselines = await readBaselines(workspace);
    expect(
      Object.values(baselines.entries).filter(
        (entry) =>
          entry.assetId === "doc/design" ||
          entry.assetId === "knowledge/alpha.md",
      ),
    ).toHaveLength(0);
  });

  it("deletes local Doc, Knowledge and Prompt files when requested", async () => {
    await mkdir(join(workspace, ".paseo/docs/design"), { recursive: true });
    await writeFile(
      join(workspace, ".paseo/docs/design/README.md"),
      "# Local design\n",
    );
    await mkdir(join(workspace, ".paseo/knowledge"), { recursive: true });
    await writeFile(join(workspace, ".paseo/knowledge/alpha.md"), "# Alpha\n");
    await mkdir(join(workspace, ".paseo"), { recursive: true });
    await writeFile(join(workspace, ".paseo/AGENTS.md"), "# Local\n");
    await writeFile(join(workspace, ".codex-AGENTS.md"), "# Provider\n");
    const config = await readConfig();
    config.instructions.p1 = {
      canonical: {
        targetPath: join(workspace, ".paseo/AGENTS.md"),
        baselineDigest: "digest",
        updatedAt: new Date().toISOString(),
      },
      providers: [
        {
          provider: "codex",
          targetPath: join(workspace, ".codex-AGENTS.md"),
          kind: "copy",
          baselineDigest: "digest",
          updatedAt: new Date().toISOString(),
        },
      ],
    };
    await writeFile(
      join(home, "plugin-data/paseo-shared-assets/config.json"),
      JSON.stringify(config, null, 2),
    );

    const result = await removeSharedAssets({
      projectId: "p1",
      assetIds: ["doc/design", "knowledge/alpha.md", "prompt"],
      deleteLocal: true,
      expectedRevision: (await headRevision(checkout))!,
    });

    expect(result.removed).toHaveLength(3);
    expect(existsSync(join(workspace, ".paseo/docs/design"))).toBe(false);
    expect(existsSync(join(workspace, ".paseo/knowledge/alpha.md"))).toBe(
      false,
    );
    expect(existsSync(join(workspace, ".paseo/AGENTS.md"))).toBe(false);
    expect(existsSync(join(workspace, ".codex-AGENTS.md"))).toBe(false);
    expect(result.keptLocal).toEqual([]);
    expect((await readConfig()).instructions.p1).toBeUndefined();
  });

  it("removes the prompt while keeping local files by default", async () => {
    await mkdir(join(workspace, ".paseo"), { recursive: true });
    await writeFile(join(workspace, ".paseo/AGENTS.md"), "# Local\n");
    const config = await readConfig();
    config.instructions.p1 = {
      canonical: {
        targetPath: join(workspace, ".paseo/AGENTS.md"),
        baselineDigest: "digest",
        updatedAt: new Date().toISOString(),
      },
      providers: [],
    };
    await writeFile(
      join(home, "plugin-data/paseo-shared-assets/config.json"),
      JSON.stringify(config, null, 2),
    );

    const result = await removeSharedAssets({
      projectId: "p1",
      assetIds: ["prompt"],
      expectedRevision: (await headRevision(checkout))!,
    });

    expect(result.removed).toEqual([{ assetId: "prompt", path: "AGENTS.md" }]);
    expect(existsSync(join(checkout, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(workspace, ".paseo/AGENTS.md"))).toBe(true);
    expect(result.keptLocal).toEqual([join(workspace, ".paseo/AGENTS.md")]);
    expect((await readConfig()).instructions.p1).toBeUndefined();
  });

  it("reports missing assets as failures without blocking the batch", async () => {
    const result = await removeSharedAssets({
      projectId: "p1",
      assetIds: ["doc/design", "knowledge/missing.md"],
      expectedRevision: (await headRevision(checkout))!,
    });

    expect(result.commit).not.toBeNull();
    expect(result.removed.map((entry) => entry.assetId)).toEqual([
      "doc/design",
    ]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.assetId).toBe("knowledge/missing.md");
  });

  it("rejects a stale expected revision without touching the checkout", async () => {
    const before = await headRevision(checkout);
    await expect(
      removeSharedAssets({
        projectId: "p1",
        assetIds: ["doc/design"],
        expectedRevision: "0000000000000000000000000000000000000000",
      }),
    ).rejects.toMatchObject({ code: "E_REVISION_CONFLICT" });
    expect(await headRevision(checkout)).toBe(before);
    expect(existsSync(join(checkout, "docs/design"))).toBe(true);
  });

  it("does not create an empty commit when nothing is removable", async () => {
    const before = await headRevision(checkout);
    const result = await removeSharedAssets({
      projectId: "p1",
      assetIds: ["knowledge/missing.md", "doc/.."],
      expectedRevision: before!,
    });
    expect(result.commit).toBeNull();
    expect(result.removed).toEqual([]);
    expect(result.failures).toHaveLength(2);
    expect(await headRevision(checkout)).toBe(before);
  });

  it("reports the same asset as a failure on a second removal", async () => {
    const first = await removeSharedAssets({
      projectId: "p1",
      assetIds: ["knowledge/alpha.md"],
      expectedRevision: (await headRevision(checkout))!,
    });
    expect(first.commit).not.toBeNull();
    const second = await removeSharedAssets({
      projectId: "p1",
      assetIds: ["knowledge/alpha.md"],
      expectedRevision: (await headRevision(checkout))!,
    });
    expect(second.commit).toBeNull();
    expect(second.failures).toHaveLength(1);
    expect(second.failures[0]?.assetId).toBe("knowledge/alpha.md");
  });
});
