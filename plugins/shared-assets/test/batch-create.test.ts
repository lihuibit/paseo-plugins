import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../server/git";
import { repoDir } from "../server/plugin-data";
import {
  commitBatchPublish,
  previewBatchPublish,
} from "../server/batch-publish";

const SKILL = `---
name: sonic
description: Build Sonic images
---

# Sonic
`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let home: string;
let workspace: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "shared-assets-create-"));
  workspace = await mkdtemp(join(tmpdir(), "shared-assets-create-ws-"));
  process.env.PASEO_HOME = home;

  const checkout = repoDir("p1");
  await mkdir(checkout, { recursive: true });
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

  await mkdir(join(workspace, ".codex/skills/sonic"), { recursive: true });
  await writeFile(join(workspace, ".codex/skills/sonic/SKILL.md"), SKILL);
  await mkdir(join(workspace, ".agentstorm/knowledge"), { recursive: true });
  await writeFile(
    join(workspace, ".agentstorm/knowledge/notes.md"),
    "# Notes\n",
  );
  await mkdir(join(workspace, ".agentstorm/docs/design/assets"), {
    recursive: true,
  });
  await writeFile(
    join(workspace, ".agentstorm/docs/design/README.md"),
    "# Design\n",
  );
  await writeFile(
    join(workspace, ".agentstorm/docs/design/assets/flow.png"),
    PNG,
  );
  await writeFile(
    join(workspace, ".agentstorm/AGENTS.md"),
    "# Project instructions\n",
  );
});

describe("publishing local-only assets", () => {
  it("creates Skill, knowledge, document and prompt from local copies", async () => {
    const items = [
      {
        assetId: "skill:project/sonic",
        kind: "skill" as const,
        provider: "codex",
        create: true,
      },
      {
        assetId: "knowledge/notes.md",
        kind: "knowledge" as const,
        create: true,
      },
      { assetId: "doc/design", kind: "doc" as const, create: true },
      { assetId: "prompt", kind: "prompt" as const, create: true },
    ];
    const preview = await previewBatchPublish({
      projectId: "p1",
      workspaceDirectory: workspace,
      items,
    });
    expect(preview.items).toHaveLength(4);
    expect(preview.items.every((item) => item.create)).toBe(true);
    expect(preview.items.every((item) => item.state === "eligible")).toBe(true);
    expect(
      preview.items.find((item) => item.assetId === "doc/design")?.files,
    ).toHaveLength(2);

    const result = await commitBatchPublish({
      projectId: "p1",
      workspaceDirectory: workspace,
      items,
      expectedRevision: preview.expectedRevision,
    });
    expect(result.published).toHaveLength(4);
    expect(result.failed).toHaveLength(0);
    const checkout = repoDir("p1");
    expect(existsSync(join(checkout, "skills/project/sonic/SKILL.md"))).toBe(
      true,
    );
    expect(await readFile(join(checkout, "knowledge/notes.md"), "utf8")).toBe(
      "# Notes\n",
    );
    expect(
      await readFile(join(checkout, "docs/design/assets/flow.png")),
    ).toEqual(PNG);
    expect(await readFile(join(checkout, "AGENTS.md"), "utf8")).toBe(
      "# Project instructions\n",
    );
  });

  it("does not create a Skill that already exists", async () => {
    const checkout = repoDir("p1");
    await mkdir(join(checkout, "skills/project/sonic"), { recursive: true });
    await writeFile(join(checkout, "skills/project/sonic/SKILL.md"), SKILL);
    const preview = await previewBatchPublish({
      projectId: "p1",
      workspaceDirectory: workspace,
      items: [
        {
          assetId: "skill:project/sonic",
          kind: "skill",
          provider: "codex",
          create: true,
        },
      ],
    });
    expect(preview.items[0]?.state).toBe("ineligible");
  });
});
