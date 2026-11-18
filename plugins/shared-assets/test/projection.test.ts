import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import {
  instructionStatus,
  setInstructionsEnabled,
} from "../server/instructions";
import { repoDir } from "../server/plugin-data";
import { readConfig } from "../server/registry";
import { setSkillEnabled } from "../server/skills";

const SKILL = `---
name: review
description: Reviews a diff
---

# Review
`;

let home: string;
let workspace: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "shared-assets-home-"));
  workspace = await mkdtemp(join(tmpdir(), "shared-assets-workspace-"));
  process.env.PASEO_HOME = home;

  const checkout = repoDir("p1");
  await mkdir(join(checkout, "skills", "project", "review"), {
    recursive: true,
  });
  await writeFile(
    join(checkout, "skills", "project", "review", "SKILL.md"),
    SKILL,
  );
  await writeFile(
    join(checkout, "AGENTS.md"),
    "# Team instructions\n\nAlways run tests.\n",
  );
});

describe("skill projection", () => {
  it("adopts a skill into .paseo/skills and links both providers", async () => {
    const enabled = await setSkillEnabled({
      projectId: "p1",
      workspaceDirectory: workspace,
      assetId: "skill:project/review",
      provider: "both",
      enabled: true,
    });
    expect(enabled.errors).toEqual([]);
    expect(existsSync(join(workspace, ".codex/skills/review/SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(workspace, ".claude/skills/review/SKILL.md"))).toBe(
      true,
    );
    expect(
      await readFile(join(workspace, ".codex/skills/review/SKILL.md"), "utf8"),
    ).toBe(SKILL);
    expect(existsSync(join(workspace, ".paseo/skills/review/SKILL.md"))).toBe(
      true,
    );
    expect(
      (await lstat(join(workspace, ".codex/skills/review"))).isSymbolicLink(),
    ).toBe(true);
    expect(
      (await lstat(join(workspace, ".claude/skills/review"))).isSymbolicLink(),
    ).toBe(true);
    const link = await readlink(join(workspace, ".codex/skills/review"));
    expect(link).toBe("../../.paseo/skills/review");

    const config = await readConfig();
    expect(config.skills.p1).toHaveLength(1);
    expect(config.skills.p1?.[0]).toMatchObject({
      assetId: "skill:project/review",
      providers: ["claude", "codex"],
      mode: "symlink",
    });

    const disabled = await setSkillEnabled({
      projectId: "p1",
      workspaceDirectory: workspace,
      assetId: "skill:project/review",
      provider: "both",
      enabled: false,
    });
    expect(disabled.kept).toEqual([]);
    expect(existsSync(join(workspace, ".codex/skills/review"))).toBe(false);
    expect(existsSync(join(workspace, ".claude/skills/review"))).toBe(false);
    expect(existsSync(join(workspace, ".paseo/skills/review/SKILL.md"))).toBe(
      true,
    );
  });

  it("keeps the entity when a provider link is removed", async () => {
    await setSkillEnabled({
      projectId: "p1",
      workspaceDirectory: workspace,
      assetId: "skill:project/review",
      provider: "codex",
      enabled: true,
    });
    await writeFile(
      join(workspace, ".codex/skills/review/SKILL.md"),
      `${SKILL}\nlocal edit\n`,
    );
    const disabled = await setSkillEnabled({
      projectId: "p1",
      workspaceDirectory: workspace,
      assetId: "skill:project/review",
      provider: "codex",
      enabled: false,
    });
    expect(disabled.kept).toHaveLength(0);
    expect(existsSync(join(workspace, ".codex/skills/review"))).toBe(false);
    expect(
      await readFile(join(workspace, ".paseo/skills/review/SKILL.md"), "utf8"),
    ).toBe(`${SKILL}\nlocal edit\n`);
  });

  it("falls back to a copy when symlinks are unavailable", async () => {
    const shared = await import("../server/skill-entity");
    const target = shared.providerSkillTarget(workspace, "codex", "review");
    await mkdir(join(workspace, ".paseo/skills/review"), { recursive: true });
    await writeFile(join(workspace, ".paseo/skills/review/SKILL.md"), SKILL);
    const result = await shared.projectSkillToProvider({
      workspaceDirectory: workspace,
      provider: "codex",
      name: "review",
      entityPath: join(workspace, ".paseo/skills/review"),
      entityDigest: "any",
      symlinkFn: async () => {
        throw new Error("EPERM: symlink not permitted");
      },
    });
    expect(result.mode).toBe("copy");
    expect(existsSync(join(target, "SKILL.md"))).toBe(true);
  });

  it("reports a dangling provider symlink as missing", async () => {
    await mkdir(join(workspace, ".paseo/skills"), { recursive: true });
    await mkdir(join(workspace, ".codex/skills"), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(
      "../../.paseo/skills/review",
      join(workspace, ".codex/skills/review"),
    );
    const { readConfig, writeConfig } = await import("../server/registry");
    const config = await readConfig();
    config.skills.p1 = [
      {
        assetId: "skill:project/review",
        name: "review",
        entityPath: join(workspace, ".paseo/skills/review"),
        providers: ["codex"],
        mode: "symlink",
        digest: "missing-entity",
        updatedAt: new Date().toISOString(),
      },
    ];
    config.bindings.p1 = {
      projectId: "p1",
      projectRoot: workspace,
      libraryId: "team",
      displayName: "Team",
      repoUrl: "file:///tmp/team.git",
      branch: "main",
      syncMode: "manual",
      configuredAt: new Date().toISOString(),
      revision: 0,
      state: {
        localRevision: null,
        remoteRevision: null,
        lastFetchedAt: null,
        lastSyncedAt: null,
        operation: "idle",
        dirty: false,
        ahead: 0,
        behind: 0,
        lastError: null,
      },
    };
    await writeConfig(config);
    const { listSkills } = await import("../server/skills");
    const result = await listSkills("p1", workspace);
    const projection = result.projections.find(
      (entry) => entry.provider === "codex",
    );
    expect(projection?.state).toBe("missing");
    expect(result.entities[0]?.state).toBe("missing");
  });

  it("refuses to overwrite an unrelated local skill", async () => {
    await mkdir(join(workspace, ".codex/skills/review"), { recursive: true });
    await writeFile(
      join(workspace, ".codex/skills/review/SKILL.md"),
      `${SKILL}\nuser copy\n`,
    );
    const result = await setSkillEnabled({
      projectId: "p1",
      workspaceDirectory: workspace,
      assetId: "skill:project/review",
      provider: "codex",
      enabled: true,
    });
    expect(result.errors[0]?.code).toBe("E_VALIDATION_FAILED");
    expect(
      await readFile(join(workspace, ".codex/skills/review/SKILL.md"), "utf8"),
    ).toContain("user copy");
    expect(existsSync(join(workspace, ".paseo/skills/review"))).toBe(false);
  });

  it("removes only one provider link on unlink and keeps the entity", async () => {
    await setSkillEnabled({
      projectId: "p1",
      workspaceDirectory: workspace,
      assetId: "skill:project/review",
      provider: "both",
      enabled: true,
    });
    await setSkillEnabled({
      projectId: "p1",
      workspaceDirectory: workspace,
      assetId: "skill:project/review",
      provider: "pi",
      enabled: true,
    });
    const { unlinkRelationship } = await import("../server/relationships");
    const result = await unlinkRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "skill",
      provider: "claude",
      assetId: "skill:project/review",
      deleteLocal: false,
    });
    expect(result.deleted).toHaveLength(1);
    expect(existsSync(join(workspace, ".claude/skills/review"))).toBe(false);
    expect(existsSync(join(workspace, ".codex/skills/review"))).toBe(true);
    expect(existsSync(join(workspace, ".pi/skills/review"))).toBe(true);
    expect(existsSync(join(workspace, ".paseo/skills/review/SKILL.md"))).toBe(
      true,
    );
  });
});

describe("instruction projection", () => {
  it("writes the canonical file and links both provider entrypoints", async () => {
    const result = await setInstructionsEnabled({
      projectId: "p1",
      workspaceDirectory: workspace,
      provider: "both",
      enabled: true,
    });
    expect(result.kept).toEqual([]);
    expect(
      await readFile(join(workspace, ".paseo/AGENTS.md"), "utf8"),
    ).toContain("Always run tests.");
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(workspace, ".claude/CLAUDE.md"))).toBe(true);

    const status = await instructionStatus("p1", workspace);
    expect(status.canonical.matchesShared).toBe(true);
    expect(status.targets.map((target) => target.state)).toEqual([
      "managed",
      "managed",
    ]);

    const disabled = await setInstructionsEnabled({
      projectId: "p1",
      workspaceDirectory: workspace,
      provider: "both",
      enabled: false,
    });
    expect(disabled.kept).toEqual([]);
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(workspace, ".claude/CLAUDE.md"))).toBe(false);
    expect(existsSync(join(workspace, ".paseo/AGENTS.md"))).toBe(true);
  });

  it("reports a conflict for a user-owned provider entrypoint", async () => {
    await writeFile(join(workspace, "AGENTS.md"), "# My own instructions\n");
    await expect(
      setInstructionsEnabled({
        projectId: "p1",
        workspaceDirectory: workspace,
        provider: "codex",
        enabled: true,
      }),
    ).rejects.toThrow(/already exists with user content/);
    expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toBe(
      "# My own instructions\n",
    );
  });
});
