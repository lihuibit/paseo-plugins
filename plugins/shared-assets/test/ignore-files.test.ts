import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import {
  commitBatchPublish,
  previewBatchPublish,
} from "../server/batch-publish";
import { listDrift } from "../server/drift";
import { runGit } from "../server/git";
import { repoDir } from "../server/plugin-data";
import { commitPublish, previewPublish } from "../server/publish";
import { listRelationships } from "../server/relationships";
import { saveBinding } from "../server/registry";
import { setSkillEnabled } from "../server/skills";

const SKILL = `---
name: doppler-api
description: Doppler API helpers
---

# Doppler API
`;

const ASSET_ID = "skill:project/doppler-api";
const BINARY = Buffer.from([0, 1, 2, 3, 255]);

let home: string;
let workspace: string;
let checkout: string;

async function writeLocal(relativePath: string, content: string | Buffer) {
  const path = join(workspace, ".codex/skills/doppler-api", relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function writeRemote(relativePath: string, content: string | Buffer) {
  const path = join(checkout, "skills/project/doppler-api", relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function removeLocal(relativePath: string) {
  await rm(join(workspace, ".codex/skills/doppler-api", relativePath), {
    force: true,
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "shared-assets-ignore-home-"));
  workspace = await mkdtemp(join(tmpdir(), "shared-assets-ignore-ws-"));
  process.env.PASEO_HOME = home;
  checkout = repoDir("p1");
  await mkdir(join(checkout, "skills/project/doppler-api/scripts"), {
    recursive: true,
  });
  await writeFile(
    join(checkout, "team-assets.json"),
    JSON.stringify({
      schemaVersion: 1,
      libraryId: "team",
      displayName: "Team",
    }),
  );
  await writeFile(join(checkout, "skills/project/doppler-api/SKILL.md"), SKILL);
  await writeFile(
    join(checkout, "skills/project/doppler-api/scripts/doppler.py"),
    "print('doppler')\n",
  );
  await writeFile(
    join(checkout, "skills/project/doppler-api/scripts/keep.pyc"),
    BINARY,
  );
  await writeFile(
    join(checkout, "ignore-rules"),
    ["*.pyc", "__pycache__/", "dir/", "/anchored", "!keep.pyc", ""].join("\n"),
  );
  await runGit(checkout, ["init", "--quiet"]);
  await runGit(checkout, ["config", "user.name", "Test"]);
  await runGit(checkout, ["config", "user.email", "test@example.invalid"]);
  await runGit(checkout, ["add", "."]);
  await runGit(checkout, ["commit", "--quiet", "-m", "seed"]);
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
  await setSkillEnabled({
    projectId: "p1",
    workspaceDirectory: workspace,
    assetId: ASSET_ID,
    provider: "codex",
    enabled: true,
  });
});

describe("file-level ignore rules", () => {
  it("filters ignored files on both sides and keeps negated files", async () => {
    const ignoredFiles = [
      "scripts/drop.pyc",
      "scripts/__pycache__/cache.txt",
      "nested/dir/file.txt",
      "anchored/file.txt",
    ];
    for (const file of ignoredFiles) {
      await writeLocal(file, BINARY);
    }
    expect(
      (await listDrift("p1", workspace)).find(
        (item) => item.assetId === ASSET_ID,
      ),
    ).toBeUndefined();

    for (const file of ignoredFiles) await removeLocal(file);
    for (const file of ignoredFiles) {
      await writeRemote(file, BINARY);
    }
    expect(
      (await listDrift("p1", workspace)).find(
        (item) => item.assetId === ASSET_ID,
      ),
    ).toBeUndefined();

    await writeLocal("scripts/keep.pyc", Buffer.from([9, 9, 9]));
    let item = (await listDrift("p1", workspace)).find(
      (entry) => entry.assetId === ASSET_ID,
    );
    expect(item?.status).toBe("local-update");
    expect(
      item?.files
        .filter((file) => file.status !== "synced")
        .map((file) => file.path),
    ).toEqual(["scripts/keep.pyc"]);

    await writeLocal("scripts/keep.pyc", BINARY);
    await writeRemote("scripts/keep.pyc", Buffer.from([9, 9, 9]));
    item = (await listDrift("p1", workspace)).find(
      (entry) => entry.assetId === ASSET_ID,
    );
    expect(item?.status).toBe("remote-update");
    expect(
      item?.files
        .filter((file) => file.status !== "synced")
        .map((file) => file.path),
    ).toEqual(["scripts/keep.pyc"]);
  });

  it("hides ignored binary files from batch preview and commit", async () => {
    await writeLocal("scripts/__pycache__/doppler.cpython-310.pyc", BINARY);
    const relationships = await listRelationships({
      projectId: "p1",
      workspaceDirectory: workspace,
      kind: "skill",
      provider: "codex",
    });
    expect(relationships.rows[0]?.syncStatus).toBeNull();

    const preview = await previewBatchPublish({
      projectId: "p1",
      workspaceDirectory: workspace,
      items: [{ assetId: ASSET_ID, provider: "codex" }],
    });
    expect(preview.items).toEqual([]);
    expect(preview.skipped).toEqual([
      { assetId: ASSET_ID, reason: "no local changes to publish" },
    ]);
    expect(
      preview.items
        .flatMap((item) => item.reasons)
        .map((reason) => reason.code),
    ).not.toContain("E_VALIDATION_FAILED");

    const result = await commitBatchPublish({
      projectId: "p1",
      workspaceDirectory: workspace,
      items: [{ assetId: ASSET_ID, provider: "codex" }],
      expectedRevision: preview.expectedRevision,
    });
    expect(result.commit).toBeNull();
    expect(result.failed).toEqual([]);
    expect(
      existsSync(
        join(
          checkout,
          "skills/project/doppler-api/scripts/__pycache__/doppler.cpython-310.pyc",
        ),
      ),
    ).toBe(false);
  });

  it("rejects ignored files in single publish preview and commit", async () => {
    await expect(
      previewPublish({
        projectId: "p1",
        assetId: ASSET_ID,
        path: "scripts/__pycache__/doppler.cpython-310.pyc",
        content: "ignored",
      }),
    ).rejects.toMatchObject({ code: "E_VALIDATION_FAILED" });

    await expect(
      commitPublish({
        projectId: "p1",
        assetId: ASSET_ID,
        path: "scripts/__pycache__/doppler.cpython-310.pyc",
        content: "ignored",
        expectedRevision: (
          await runGit(checkout, ["rev-parse", "HEAD"])
        ).stdout.trim(),
      }),
    ).rejects.toMatchObject({ code: "E_VALIDATION_FAILED" });
  });
});
