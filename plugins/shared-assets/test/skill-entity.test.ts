import { existsSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  commitBatchPublish,
  previewBatchPublish,
} from "../server/batch-publish";
import { listDrift } from "../server/drift";
import { runGit } from "../server/git";
import { repoDir } from "../server/plugin-data";
import { readConfig, writeConfig } from "../server/registry";
import {
  listLegacySkillProjects,
  listSkills,
  setSkillEnabled,
} from "../server/skills";
import { LEGACY_SKILL_MESSAGE } from "../server/skill-entity";

const SKILL = `---
name: sonic
description: Build Sonic images
---

# Sonic
`;

let home: string;
let workspace: string;
let checkout: string;

async function seedBinding() {
  const config = await readConfig();
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
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "shared-assets-entity-"));
  workspace = await mkdtemp(join(tmpdir(), "shared-assets-entity-ws-"));
  process.env.PASEO_HOME = home;
  checkout = repoDir("p1");
  await mkdir(join(checkout, "skills", "project", "review"), {
    recursive: true,
  });
  await writeFile(
    join(checkout, "skills", "project", "review", "SKILL.md"),
    SKILL.replace("sonic", "review"),
  );
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
  await seedBinding();
});

describe("entity-backed Skill projections", () => {
  it("publishes a local Skill by moving it to .paseo/skills and linking providers", async () => {
    await mkdir(join(workspace, ".codex/skills/sonic"), { recursive: true });
    await writeFile(join(workspace, ".codex/skills/sonic/SKILL.md"), SKILL);
    await mkdir(join(workspace, ".claude/skills/sonic"), { recursive: true });
    await writeFile(join(workspace, ".claude/skills/sonic/SKILL.md"), SKILL);

    const items = [
      {
        assetId: "skill:project/sonic",
        kind: "skill" as const,
        provider: "codex",
        create: true,
      },
    ];
    const preview = await previewBatchPublish({
      projectId: "p1",
      workspaceDirectory: workspace,
      items,
    });
    expect(preview.items[0]?.state).toBe("eligible");
    const result = await commitBatchPublish({
      projectId: "p1",
      workspaceDirectory: workspace,
      items,
      expectedRevision: preview.expectedRevision,
    });
    expect(result.published).toHaveLength(1);

    const entity = join(workspace, ".paseo/skills/sonic");
    expect(await readFile(join(entity, "SKILL.md"), "utf8")).toBe(SKILL);
    expect(existsSync(join(workspace, ".codex/skills/sonic/SKILL.md"))).toBe(
      true,
    );
    expect(
      (await lstat(join(workspace, ".codex/skills/sonic"))).isSymbolicLink(),
    ).toBe(true);
    expect(
      (await lstat(join(workspace, ".claude/skills/sonic"))).isSymbolicLink(),
    ).toBe(true);
    expect(await readlink(join(workspace, ".codex/skills/sonic"))).toBe(
      "../../.paseo/skills/sonic",
    );
    const config = await readConfig();
    expect(config.skills.p1?.[0]).toMatchObject({
      assetId: "skill:project/sonic",
      providers: ["claude", "codex"],
      mode: "symlink",
    });
  });

  it("reports a conflicting provider Skill instead of overwriting it", async () => {
    await mkdir(join(workspace, ".codex/skills/sonic"), { recursive: true });
    await writeFile(join(workspace, ".codex/skills/sonic/SKILL.md"), SKILL);
    await mkdir(join(workspace, ".claude/skills/sonic"), { recursive: true });
    await writeFile(
      join(workspace, ".claude/skills/sonic/SKILL.md"),
      `${SKILL}\ndifferent\n`,
    );
    const items = [
      {
        assetId: "skill:project/sonic",
        kind: "skill" as const,
        provider: "codex",
        create: true,
      },
    ];
    const preview = await previewBatchPublish({
      projectId: "p1",
      workspaceDirectory: workspace,
      items,
    });
    expect(preview.items[0]?.state).toBe("ineligible");
    expect(preview.items[0]?.reasons[0]?.message).toContain(
      "conflicting Skill projections",
    );
    const result = await commitBatchPublish({
      projectId: "p1",
      workspaceDirectory: workspace,
      items,
      expectedRevision: preview.expectedRevision,
    });
    expect(result.published).toHaveLength(0);
    expect(result.failed[0]?.reason).toContain("claude");
    expect(
      await readFile(join(workspace, ".claude/skills/sonic/SKILL.md"), "utf8"),
    ).toContain("different");
    expect(existsSync(join(workspace, ".paseo/skills/sonic"))).toBe(false);
    expect(existsSync(join(checkout, "skills/project/sonic/SKILL.md"))).toBe(
      false,
    );
  });

  it("computes drift once for a shared Skill and reports provider links", async () => {
    await setSkillEnabled({
      projectId: "p1",
      workspaceDirectory: workspace,
      assetId: "skill:project/review",
      provider: "both",
      enabled: true,
    });
    await writeFile(
      join(workspace, ".paseo/skills/review/SKILL.md"),
      `${SKILL.replace("sonic", "review")}\nlocal edit\n`,
    );
    const drift = await listDrift("p1", workspace);
    const skillItems = drift.filter(
      (item) => item.assetId === "skill:project/review",
    );
    expect(skillItems).toHaveLength(1);
    expect(skillItems[0]?.provider).toBeNull();
    expect(skillItems[0]?.status).toBe("local-update");
    expect(skillItems[0]?.projections?.map((entry) => entry.provider)).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("detects a provider link replaced by a different real directory", async () => {
    await setSkillEnabled({
      projectId: "p1",
      workspaceDirectory: workspace,
      assetId: "skill:project/review",
      provider: "both",
      enabled: true,
    });
    const codex = join(workspace, ".codex/skills/review");
    await rm(codex, { recursive: true, force: true });
    await mkdir(codex, { recursive: true });
    await writeFile(
      join(codex, "SKILL.md"),
      `${SKILL.replace("sonic", "review")}\nreplaced\n`,
    );
    const drift = await listDrift("p1", workspace);
    const item = drift.find(
      (entry) => entry.assetId === "skill:project/review",
    );
    expect(item?.status).toBe("diverged");
    expect(
      item?.projections?.find((entry) => entry.provider === "codex")?.state,
    ).toBe("modified");
    expect(
      item?.projections?.find((entry) => entry.provider === "claude")?.state,
    ).toBe("managed");
  });

  it("reads the legacy per-provider layout without rewriting it", async () => {
    await mkdir(join(workspace, ".codex/skills/review"), { recursive: true });
    await writeFile(
      join(workspace, ".codex/skills/review/SKILL.md"),
      SKILL.replace("sonic", "review"),
    );
    await mkdir(join(workspace, ".claude/skills/review"), { recursive: true });
    await writeFile(
      join(workspace, ".claude/skills/review/SKILL.md"),
      SKILL.replace("sonic", "review"),
    );
    const config = await readConfig();
    config.skills.p1 = [
      {
        assetId: "skill:project/review",
        name: "review",
        provider: "codex",
        targetPath: join(workspace, ".codex/skills/review"),
        baselineDigest: "legacy-codex",
        updatedAt: new Date().toISOString(),
      },
      {
        assetId: "skill:project/review",
        name: "review",
        provider: "claude",
        targetPath: join(workspace, ".claude/skills/review"),
        baselineDigest: "legacy-claude",
        updatedAt: new Date().toISOString(),
      },
    ];
    await writeConfig(config);

    const listed = await listSkills("p1", workspace);
    expect(listed.migrationRequired).toBe(true);
    expect(listed.warnings).toContain(LEGACY_SKILL_MESSAGE);
    expect(listed.projections).toHaveLength(2);
    const after = await readConfig();
    expect(after.skills.p1).toEqual(config.skills.p1);
    expect(existsSync(join(workspace, ".paseo/skills/review"))).toBe(false);
    expect(await listLegacySkillProjects()).toContain("p1");
    const entrypoint = await import("../index.server");
    expect(typeof entrypoint.default).toBe("function");
  });
});
