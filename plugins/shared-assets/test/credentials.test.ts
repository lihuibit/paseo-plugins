import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { countDrift } from "../client/drift-counts";
import {
  commitBatchPublish,
  previewBatchPublish,
} from "../server/batch-publish";
import { overwriteDrift } from "../server/drift-actions";
import { listDrift } from "../server/drift";
import { runGit } from "../server/git";
import { materializeWorkspace } from "../server/materialize";
import { repoDir } from "../server/plugin-data";
import { resolvePublishTarget, scanSkills } from "../server/repo";
import { setSkillEnabled } from "../server/skills";

const SKILLS = ["tse-alarm-analysis", "sonic-cli", "sonic-upgrade"];

let home: string;
let workspace: string;
let checkout: string;

function skillMarkdown(name: string): string {
  return `---\nname: ${name}\ndescription: Fixture ${name}\n---\n\n# ${name}\n`;
}

function localSkill(provider: string, name: string): string {
  return join(workspace, `.${provider}`, "skills", name);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "shared-assets-credentials-"));
  workspace = await mkdtemp(join(tmpdir(), "shared-assets-credentials-ws-"));
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
  for (const name of SKILLS) {
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
  for (const name of SKILLS) {
    await setSkillEnabled({
      projectId: "p1",
      workspaceDirectory: workspace,
      assetId: `skill:project/${name}`,
      provider: "both",
      enabled: true,
    });
  }
});

describe("credential files", () => {
  it("does not count .env or keys as drift for either provider", async () => {
    for (const provider of ["claude", "codex"]) {
      const sonicCli = localSkill(provider, "sonic-cli");
      await mkdir(join(sonicCli, "certs"), { recursive: true });
      await writeFile(join(sonicCli, ".env"), "TOKEN=secret\n");
      await writeFile(join(sonicCli, "certs", "client.pem"), "secret\n");

      const sonicUpgrade = localSkill(provider, "sonic-upgrade");
      await writeFile(join(sonicUpgrade, ".env.local"), "TOKEN=secret\n");
      await writeFile(join(sonicUpgrade, "id_rsa"), "secret\n");

      const analysis = localSkill(provider, "tse-alarm-analysis");
      await writeFile(
        join(analysis, "SKILL.md"),
        `${skillMarkdown("tse-alarm-analysis")}\nlocal edit\n`,
      );
    }

    const drift = await listDrift("p1", workspace);
    expect(
      drift.map((item) => `${item.assetId}/${item.provider}`).sort(),
    ).toEqual([
      "skill:project/tse-alarm-analysis/claude",
      "skill:project/tse-alarm-analysis/codex",
    ]);
    expect(drift.every((item) => item.status === "local-update")).toBe(true);
    expect(
      drift.flatMap((item) => item.files.map((file) => file.path)),
    ).not.toContain(".env");
    const counts = countDrift(drift, "skill");
    expect(counts.byProvider.get("claude")).toBe(1);
    expect(counts.byProvider.get("codex")).toBe(1);
  });

  it("keeps non-credential local-only files unpublished and discardable", async () => {
    const root = localSkill("claude", "sonic-cli");
    await writeFile(join(root, "notes.txt"), "local only\n");

    const drift = await listDrift("p1", workspace);
    const item = drift.find(
      (entry) =>
        entry.assetId === "skill:project/sonic-cli" &&
        entry.provider === "claude",
    );
    expect(item?.status).toBe("unpublished-local");
    expect(
      item?.files
        .filter((file) => file.status !== "synced")
        .map((file) => file.path),
    ).toEqual(["notes.txt"]);
    expect(countDrift(drift, "skill").byProvider.get("claude")).toBe(1);

    const discarded = await overwriteDrift({
      projectId: "p1",
      workspaceDirectory: workspace,
      assetId: "skill:project/sonic-cli",
      provider: "claude",
    });
    expect(discarded.removedFiles).toEqual([join(root, "notes.txt")]);
    expect(existsSync(join(root, "notes.txt"))).toBe(false);
    expect(
      await listDrift("p1", workspace).then((items) =>
        items.find(
          (entry) =>
            entry.assetId === "skill:project/sonic-cli" &&
            entry.provider === "claude",
        ),
      ),
    ).toBeUndefined();
  });

  it("hides credentials from repository scans and batch publish", async () => {
    await writeFile(
      join(checkout, "skills", "project", "sonic-cli", ".env"),
      "TOKEN=secret\n",
    );
    const scan = await scanSkills(checkout);
    const asset = scan.assets.find(
      (entry) => entry.assetId === "skill:project/sonic-cli",
    );
    expect(asset?.files.map((file) => file.path)).not.toContain(".env");

    const newSkill = join(workspace, ".codex", "skills", "fresh-skill");
    await mkdir(newSkill, { recursive: true });
    await writeFile(join(newSkill, "SKILL.md"), skillMarkdown("fresh-skill"));
    await writeFile(join(newSkill, ".env"), "TOKEN=secret\n");
    await writeFile(join(newSkill, "id_ed25519"), "secret\n");
    const preview = await previewBatchPublish({
      projectId: "p1",
      workspaceDirectory: workspace,
      items: [
        {
          assetId: "skill:project/fresh-skill",
          kind: "skill",
          provider: "codex",
          create: true,
        },
      ],
    });
    expect(preview.items[0]?.files.map((file) => file.path)).toEqual([
      "SKILL.md",
    ]);
    await commitBatchPublish({
      projectId: "p1",
      workspaceDirectory: workspace,
      items: [
        {
          assetId: "skill:project/fresh-skill",
          kind: "skill",
          provider: "codex",
          create: true,
        },
      ],
      expectedRevision: preview.expectedRevision,
    });
    expect(existsSync(join(checkout, "skills/project/fresh-skill/.env"))).toBe(
      false,
    );
    expect(
      await readFile(
        join(checkout, "skills/project/fresh-skill/SKILL.md"),
        "utf8",
      ),
    ).toContain("fresh-skill");
  });

  it("refuses to publish credential paths explicitly", async () => {
    for (const path of [".env", ".env.local", "id_rsa", "certs/client.pem"]) {
      await expect(
        resolvePublishTarget(checkout, "skill:project/sonic-cli", path),
      ).rejects.toMatchObject({ code: "E_VALIDATION_FAILED" });
    }
  });
});
