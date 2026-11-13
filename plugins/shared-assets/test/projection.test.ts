import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
  it("copies a skill into both provider roots and removes unmodified copies", async () => {
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

    const config = await readConfig();
    expect(config.skills.p1).toHaveLength(2);

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
  });

  it("keeps a locally modified copy on disable", async () => {
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
    expect(disabled.kept).toHaveLength(1);
    expect(existsSync(join(workspace, ".codex/skills/review/SKILL.md"))).toBe(
      true,
    );
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
      await readFile(join(workspace, ".agentstorm/AGENTS.md"), "utf8"),
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
    expect(existsSync(join(workspace, ".agentstorm/AGENTS.md"))).toBe(true);
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
