import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import {
  adoptRelationship,
  listRelationships,
  unlinkRelationship,
} from "../server/relationships";
import { repoDir } from "../server/plugin-data";
import { saveBinding } from "../server/registry";

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
    expect(unlinked.deleted).toEqual([]);
    expect(unlinked.kept).toHaveLength(1);
    expect(existsSync(join(workspace, ".codex/skills/review/SKILL.md"))).toBe(
      true,
    );
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
    expect(result.deleted).toHaveLength(1);
    expect(existsSync(join(workspace, ".codex/skills/review"))).toBe(false);
  });

  it("adopts knowledge and docs with both modes", async () => {
    await mkdir(join(workspace, ".agentstorm/knowledge"), { recursive: true });
    await writeFile(
      join(workspace, ".agentstorm/knowledge/alpha.md"),
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
      await readFile(join(workspace, ".agentstorm/knowledge/alpha.md"), "utf8"),
    ).toBe("# Local alpha\n");

    await mkdir(join(workspace, ".agentstorm/docs/design"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".agentstorm/docs/design/README.md"),
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
      await readFile(
        join(workspace, ".agentstorm/docs/design/README.md"),
        "utf8",
      ),
    ).toBe("# Design\n");

    await unlinkRelationship({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "doc",
      provider: null,
      assetId: "doc/design",
      deleteLocal: true,
    });
    expect(existsSync(join(workspace, ".agentstorm/docs/design"))).toBe(false);
  });

  it("adopts a local AGENTS.md without overwriting it", async () => {
    await mkdir(join(workspace, ".agentstorm"), { recursive: true });
    await writeFile(
      join(workspace, ".agentstorm/AGENTS.md"),
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
    expect(
      await readFile(join(workspace, ".agentstorm/AGENTS.md"), "utf8"),
    ).toBe("# Local instructions\n");
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(true);
  });
});
