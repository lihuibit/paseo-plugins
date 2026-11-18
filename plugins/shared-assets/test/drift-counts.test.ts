import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { countDrift } from "../client/drift-counts";
import { listDrift } from "../server/drift";
import { runGit } from "../server/git";
import { writeDriftIgnores } from "../server/ignore";
import { materializeWorkspace } from "../server/materialize";
import { repoDir } from "../server/plugin-data";
import { setSkillEnabled } from "../server/skills";

const SKILL_COUNT = 15;

let home: string;
let workspace: string;
let checkout: string;

function skillName(index: number): string {
  return `skill-${String(index).padStart(2, "0")}`;
}

function skillMarkdown(name: string): string {
  return `---\nname: ${name}\ndescription: Fixture ${name}\n---\n\n# ${name}\n`;
}

async function localSkill(provider: string, name: string): Promise<string> {
  return join(workspace, `.${provider}`, "skills", name, "SKILL.md");
}

async function remoteSkill(name: string): Promise<string> {
  return join(checkout, "skills", "project", name, "SKILL.md");
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "shared-assets-i14-"));
  workspace = await mkdtemp(join(tmpdir(), "shared-assets-i14-ws-"));
  process.env.PASEO_HOME = home;
  checkout = repoDir("p1");
  await mkdir(checkout, { recursive: true });
  await writeFile(
    join(checkout, "team-assets.json"),
    JSON.stringify({
      schemaVersion: 1,
      libraryId: "team",
      displayName: "Team",
    }),
  );
  await writeFile(join(checkout, "AGENTS.md"), "# Team instructions\n");
  for (let index = 1; index <= SKILL_COUNT; index += 1) {
    const name = skillName(index);
    await mkdir(join(checkout, "skills", "project", name), {
      recursive: true,
    });
    await writeFile(
      join(checkout, "skills", "project", name, "SKILL.md"),
      skillMarkdown(name),
    );
  }
  await runGit(checkout, ["init", "--quiet"]);
  await runGit(checkout, ["config", "user.name", "Test"]);
  await runGit(checkout, ["config", "user.email", "test@example.invalid"]);
  await runGit(checkout, ["add", "."]);
  await runGit(checkout, ["commit", "--quiet", "-m", "seed"]);
  await materializeWorkspace("p1", workspace);
  for (let index = 1; index <= SKILL_COUNT; index += 1) {
    await setSkillEnabled({
      projectId: "p1",
      workspaceDirectory: workspace,
      assetId: `skill:project/${skillName(index)}`,
      provider: "both",
      enabled: true,
    });
  }
});

describe("drift tab counts", () => {
  it("reports zero for 15 skills projected to both providers", async () => {
    const drift = await listDrift("p1", workspace);
    const counts = countDrift(drift, "skill");
    expect(drift).toEqual([]);
    expect(counts.byKind.get("skill") ?? 0).toBe(0);
    expect(counts.byProvider.get("claude") ?? 0).toBe(0);
    expect(counts.byProvider.get("codex") ?? 0).toBe(0);
  });

  it("counts an entity edit under every provider that links it", async () => {
    const name = skillName(1);
    await writeFile(
      await localSkill("claude", name),
      `${skillMarkdown(name)}\nlocal edit\n`,
    );
    const drift = await listDrift("p1", workspace);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.status).toBe("local-update");
    expect(drift[0]?.provider).toBeNull();
    const counts = countDrift(drift, "skill");
    expect(counts.byKind.get("skill")).toBe(1);
    expect(counts.byProvider.get("claude")).toBe(1);
    expect(counts.byProvider.get("codex")).toBe(1);
  });

  it("still counts diverged and remote-deleted skills", async () => {
    const name = skillName(2);
    await writeFile(
      await localSkill("codex", name),
      `${skillMarkdown(name)}\nlocal edit\n`,
    );
    await writeFile(
      await remoteSkill(name),
      `${skillMarkdown(name)}\nremote edit\n`,
    );
    let drift = await listDrift("p1", workspace);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.status).toBe("diverged");
    expect(countDrift(drift, "skill").byKind.get("skill")).toBe(1);

    await writeFile(await localSkill("codex", name), skillMarkdown(name));
    await rm(join(checkout, "skills", "project", name), {
      recursive: true,
      force: true,
    });
    drift = await listDrift("p1", workspace);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.status).toBe("remote-deleted");
    expect(countDrift(drift, "skill").byKind.get("skill")).toBe(1);
  });

  it("still counts assets that were never published", async () => {
    await mkdir(join(workspace, ".paseo", "knowledge"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".paseo", "knowledge", "draft.md"),
      "# Draft\n",
    );
    const drift = await listDrift("p1", workspace);
    const item = drift.find((entry) => entry.assetId === "knowledge/draft.md");
    expect(item?.status).toBe("unpublished-local");
    expect(countDrift(drift, "knowledge").byKind.get("knowledge")).toBe(1);
  });

  it("keeps ignored entries out of counts but still renders them", async () => {
    const name = skillName(3);
    await writeFile(
      await localSkill("claude", name),
      `${skillMarkdown(name)}\nlocal edit\n`,
    );
    await writeDriftIgnores(workspace, [
      {
        assetId: `skill:project/${name}`,
        path: null,
        reason: "fixture",
        ignoredAt: new Date().toISOString(),
      },
    ]);
    const all = await listDrift("p1", workspace, true);
    expect(all.find((item) => item.provider === null)?.ignored).toBe(true);
    const visible = await listDrift("p1", workspace, false);
    expect(visible.find((item) => item.provider === null)).toBeUndefined();
    const counts = countDrift(all, "skill");
    expect(counts.byKind.get("skill") ?? 0).toBe(0);
    expect(counts.byProvider.get("claude") ?? 0).toBe(0);
  });
});
