import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import {
  adoptRelationship,
  listRelationships,
  unlinkRelationship,
} from "../server/relationships";
import { readBaselines, recordBaselineFromFile } from "../server/baseline";
import { materializeWorkspace } from "../server/materialize";
import { repoDir } from "../server/plugin-data";
import { readConfig, saveBinding } from "../server/registry";
import { batchAssociateRows } from "../client/batch-associate";

const SKILL = `---
name: review
description: Reviews a diff
---

# Review
`;

let home: string;
let workspace: string;

async function bind(projectId = "p1") {
  await saveBinding({
    projectId,
    projectRoot: workspace,
    libraryId: "team",
    displayName: "Team Assets",
    repoUrl: "https://example.com/team.git",
    branch: "main",
    syncMode: "manual",
    configuredAt: new Date().toISOString(),
    revision: 1,
    state: {
      localRevision: "a".repeat(40),
      remoteRevision: "a".repeat(40),
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

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "shared-assets-home-"));
  workspace = await mkdtemp(join(tmpdir(), "shared-assets-workspace-"));
  process.env.PASEO_HOME = home;
  const checkout = repoDir("p1");
  await mkdir(join(checkout, "skills", "project", "review"), {
    recursive: true,
  });
  await writeFile(join(checkout, "skills/project/review/SKILL.md"), SKILL);
  await writeFile(join(checkout, "AGENTS.md"), "# Shared instructions\n");
  await mkdir(join(checkout, "knowledge"), { recursive: true });
  await writeFile(join(checkout, "knowledge/alpha.md"), "# Alpha\n");
  await mkdir(join(checkout, "docs/design"), { recursive: true });
  await writeFile(join(checkout, "docs/design/README.md"), "# Design\n");
  await bind();
});

describe("relationship listing", () => {
  it("pairs a same-named local skill with the shared one as a candidate", async () => {
    await mkdir(join(workspace, ".codex/skills/review"), { recursive: true });
    await writeFile(join(workspace, ".codex/skills/review/SKILL.md"), SKILL);
    const result = await listRelationships({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "skill",
      provider: "codex",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.relationship).toBe("candidate");
    expect(result.rows[0]?.shared?.assetId).toBe("skill:project/review");
  });

  it("shows a local skill without a shared counterpart as private", async () => {
    await mkdir(join(workspace, ".codex/skills/local-only"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".codex/skills/local-only/SKILL.md"),
      SKILL.replace("name: review", "name: local-only"),
    );
    const result = await listRelationships({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "skill",
      provider: "codex",
    });
    const row = result.rows.find((entry) => entry.local?.name === "local-only");
    expect(row?.relationship).toBe("private");
  });
});

describe("association lifecycle", () => {
  it("adopts a local skill, preserves local content and can unlink", async () => {
    await mkdir(join(workspace, ".codex/skills/review"), { recursive: true });
    const localSkill = `${SKILL}\nlocal edit\n`;
    await writeFile(
      join(workspace, ".codex/skills/review/SKILL.md"),
      localSkill,
    );

    await adoptRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "skill",
      provider: "codex",
      assetId: "skill:project/review",
      localAssetId: "local-skill:codex/review",
      mode: "preserve-local",
    });
    expect(
      await readFile(join(workspace, ".codex/skills/review/SKILL.md"), "utf8"),
    ).toBe(localSkill);

    const linked = await listRelationships({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "skill",
      provider: "codex",
    });
    expect(linked.rows[0]?.relationship).toBe("linked");
    expect(linked.rows[0]?.syncStatus).toBe("local-update");

    const unlinked = await unlinkRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "skill",
      provider: "codex",
      assetId: "skill:project/review",
      deleteLocal: false,
    });
    expect(unlinked.deleted).toEqual([join(workspace, ".codex/skills/review")]);
    expect(unlinked.kept).toEqual([join(workspace, ".paseo/skills/review")]);
    expect(existsSync(join(workspace, ".codex/skills/review"))).toBe(false);
    expect(
      await readFile(join(workspace, ".paseo/skills/review/SKILL.md"), "utf8"),
    ).toBe(localSkill);
  });

  it("keeps a linked row visible when the shared asset was deleted", async () => {
    await mkdir(join(workspace, ".codex/skills/review"), { recursive: true });
    await writeFile(join(workspace, ".codex/skills/review/SKILL.md"), SKILL);
    await adoptRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "skill",
      provider: "codex",
      assetId: "skill:project/review",
      localAssetId: "local-skill:codex/review",
      mode: "preserve-local",
    });
    await rm(join(repoDir("p1"), "skills/project/review"), {
      recursive: true,
      force: true,
    });
    const result = await listRelationships({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "skill",
      provider: "codex",
    });
    expect(result.rows[0]?.relationship).toBe("linked");
    expect(result.rows[0]?.syncStatus).toBe("remote-deleted");
    expect(result.rows[0]?.shared?.assetId).toBe("skill:project/review");
  });

  it("adopts with the shared version and deletes the local copy on unlink", async () => {
    await mkdir(join(workspace, ".codex/skills/review"), { recursive: true });
    await writeFile(
      join(workspace, ".codex/skills/review/SKILL.md"),
      `${SKILL}\nlocal edit\n`,
    );
    await adoptRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "skill",
      provider: "codex",
      assetId: "skill:project/review",
      localAssetId: "local-skill:codex/review",
      mode: "use-remote",
    });
    expect(
      await readFile(join(workspace, ".codex/skills/review/SKILL.md"), "utf8"),
    ).toBe(SKILL);
    const result = await unlinkRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "skill",
      provider: "codex",
      assetId: "skill:project/review",
      deleteLocal: true,
    });
    expect(result.deleted).toHaveLength(2);
    expect(existsSync(join(workspace, ".codex/skills/review"))).toBe(false);
    expect(existsSync(join(workspace, ".paseo/skills/review"))).toBe(false);
  });

  it("adopts knowledge and docs with both modes", async () => {
    await mkdir(join(workspace, ".paseo/knowledge"), { recursive: true });
    await writeFile(
      join(workspace, ".paseo/knowledge/alpha.md"),
      "# Local alpha\n",
    );
    await adoptRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "knowledge",
      provider: null,
      assetId: "knowledge/alpha.md",
      localAssetId: "local:knowledge/alpha",
      mode: "preserve-local",
    });
    expect(
      await readFile(join(workspace, ".paseo/knowledge/alpha.md"), "utf8"),
    ).toBe("# Local alpha\n");

    await mkdir(join(workspace, ".paseo/docs/design"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".paseo/docs/design/README.md"),
      "# Local design\n",
    );
    await adoptRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "doc",
      provider: null,
      assetId: "doc/design",
      localAssetId: "local:doc/design",
      mode: "use-remote",
    });
    expect(
      await readFile(join(workspace, ".paseo/docs/design/README.md"), "utf8"),
    ).toBe("# Design\n");

    await unlinkRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "doc",
      provider: null,
      assetId: "doc/design",
      deleteLocal: true,
    });
    expect(existsSync(join(workspace, ".paseo/docs/design"))).toBe(false);
  });

  it("adopts a local AGENTS.md without overwriting it", async () => {
    await mkdir(join(workspace, ".paseo"), { recursive: true });
    await writeFile(
      join(workspace, ".paseo/AGENTS.md"),
      "# Local instructions\n",
    );
    await adoptRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "prompt",
      provider: "codex",
      assetId: "prompt",
      localAssetId: "local:prompt",
      mode: "preserve-local",
    });
    expect(await readFile(join(workspace, ".paseo/AGENTS.md"), "utf8")).toBe(
      "# Local instructions\n",
    );
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(true);
  });
});

describe("prompt unlink", () => {
  async function writePromptBaseline(content: string): Promise<string> {
    const canonical = join(workspace, ".paseo", "AGENTS.md");
    await mkdir(join(workspace, ".paseo"), { recursive: true });
    await writeFile(canonical, content);
    await recordBaselineFromFile({
      workspaceDirectory: workspace,
      assetId: "prompt",
      kind: "prompt",
      provider: null,
      relativePath: "AGENTS.md",
      sourcePath: canonical,
    });
    return canonical;
  }

  it("unlinks a prompt from a baseline even when no instructions record exists", async () => {
    const canonical = await writePromptBaseline("# Shared instructions\n");
    expect((await readConfig()).instructions.p1).toBeUndefined();

    const result = await unlinkRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "prompt",
      provider: null,
      assetId: "prompt",
      deleteLocal: false,
    });

    expect(result.kept).toContain(canonical);
    expect(existsSync(canonical)).toBe(true);
    expect(
      Object.values((await readBaselines(workspace)).entries).filter(
        (entry) => entry.assetId === "prompt",
      ),
    ).toHaveLength(0);
  });

  it("cleans a stale baseline and keeps the user-modified projection", async () => {
    const canonical = await writePromptBaseline("# Shared instructions\n");
    await writeFile(canonical, "# Local edit after sync\n");

    const result = await unlinkRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "prompt",
      provider: null,
      assetId: "prompt",
      deleteLocal: true,
    });

    expect(result.hadLocalChanges).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(existsSync(canonical)).toBe(true);
    expect(
      Object.values((await readBaselines(workspace)).entries).filter(
        (entry) => entry.assetId === "prompt",
      ),
    ).toHaveLength(0);
  });

  it("deletes an unchanged baseline projection only with deleteLocal", async () => {
    const canonical = await writePromptBaseline("# Shared instructions\n");
    const result = await unlinkRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "prompt",
      provider: null,
      assetId: "prompt",
      deleteLocal: true,
    });

    expect(result.deleted).toContain(canonical);
    expect(existsSync(canonical)).toBe(false);
  });

  it("keeps the existing linked prompt unlink behavior", async () => {
    await mkdir(join(workspace, ".paseo"), { recursive: true });
    await writeFile(
      join(workspace, ".paseo", "AGENTS.md"),
      "# Local instructions\n",
    );
    await adoptRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "prompt",
      provider: "codex",
      assetId: "prompt",
      localAssetId: "local:prompt",
      mode: "preserve-local",
    });
    expect((await readConfig()).instructions.p1?.canonical).not.toBeNull();

    const result = await unlinkRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "prompt",
      provider: "codex",
      assetId: "prompt",
      deleteLocal: false,
    });

    expect(result.kept).toContain(join(workspace, ".paseo", "AGENTS.md"));
    expect(existsSync(join(workspace, ".paseo", "AGENTS.md"))).toBe(true);
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(true);
    expect((await readConfig()).instructions.p1).toBeUndefined();
  });

  it("records auto-materialized prompts so listing agrees with unlink", async () => {
    await materializeWorkspace("p1", workspace);
    const canonical = join(workspace, ".paseo", "AGENTS.md");
    expect(existsSync(canonical)).toBe(true);
    expect((await readConfig()).instructions.p1?.canonical?.source).toBe(
      "materialize",
    );

    const listed = await listRelationships({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "prompt",
      provider: "codex",
    });
    expect(listed.rows[0]?.relationship).toBe("linked");

    const result = await unlinkRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "prompt",
      provider: "codex",
      assetId: "prompt",
      deleteLocal: false,
    });
    expect(result.kept).toContain(canonical);
    expect((await readConfig()).instructions.p1).toBeUndefined();
  });

  it("preserves a user-created root AGENTS.md symlink on unlink", async () => {
    await materializeWorkspace("p1", workspace);
    const canonical = join(workspace, ".paseo", "AGENTS.md");
    const rootLink = join(workspace, "AGENTS.md");
    await symlink(join(".paseo", "AGENTS.md"), rootLink);

    await unlinkRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "prompt",
      provider: "codex",
      assetId: "prompt",
      deleteLocal: false,
    });

    expect(existsSync(rootLink)).toBe(true);
    expect(existsSync(canonical)).toBe(true);
  });

  it("never deletes a user-created root symlink, even with deleteLocal", async () => {
    await materializeWorkspace("p1", workspace);
    const canonical = join(workspace, ".paseo", "AGENTS.md");
    const rootLink = join(workspace, "AGENTS.md");
    await symlink(join(".paseo", "AGENTS.md"), rootLink);

    await unlinkRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "prompt",
      provider: "codex",
      assetId: "prompt",
      deleteLocal: true,
    });

    const link = await lstat(rootLink);
    expect(link.isSymbolicLink()).toBe(true);
    expect(existsSync(canonical)).toBe(false);
  });
});

describe("batch association", () => {
  it("associates every candidate serially and reports successes", async () => {
    for (const name of ["alpha", "beta"]) {
      const shared = join(repoDir("p1"), "skills", "project", name);
      await mkdir(shared, { recursive: true });
      await writeFile(
        join(shared, "SKILL.md"),
        SKILL.replace("name: review", `name: ${name}`),
      );
      const local = join(workspace, ".codex", "skills", name);
      await mkdir(local, { recursive: true });
      await writeFile(
        join(local, "SKILL.md"),
        SKILL.replace("name: review", `name: ${name}`),
      );
    }
    await mkdir(join(workspace, ".codex", "skills", "review"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".codex", "skills", "review", "SKILL.md"),
      SKILL,
    );

    const listed = await listRelationships({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "skill",
      provider: "codex",
    });
    const candidates = listed.rows.filter(
      (row) => row.relationship === "candidate",
    );
    expect(candidates).toHaveLength(3);

    const result = await batchAssociateRows(candidates, async (row) => {
      await adoptRelationship({
        projectId: "p1",
        workspaceDirectory: workspace,
        kind: "skill",
        provider: "codex",
        assetId: row.shared!.assetId,
        localAssetId: row.local!.assetId,
        mode: "preserve-local",
      });
    });

    expect(result.succeeded).toBe(3);
    expect(result.failed).toEqual([]);
    expect((await readConfig()).skills.p1).toHaveLength(3);
  });
});
