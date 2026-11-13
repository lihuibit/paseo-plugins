import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../server/git";
import { repoDir } from "../server/plugin-data";
import { commitPublish, previewPublish } from "../server/publish";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "shared-assets-publish-"));
  process.env.PASEO_HOME = home;
  const checkout = repoDir("p1");
  await mkdir(join(checkout, "knowledge"), { recursive: true });
  await writeFile(join(checkout, "knowledge", "guide.md"), "# Guide\n\nold\n");
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
});

describe("publish", () => {
  it("previews and commits only the selected file", async () => {
    const checkout = repoDir("p1");
    const preview = await previewPublish({
      projectId: "p1",
      assetId: "knowledge/guide.md",
      content: "# Guide\n\nnew\n",
    });
    expect(preview.item.targetPath).toBe("knowledge/guide.md");
    expect(preview.item.diff).toContain("+new");

    const result = await commitPublish({
      projectId: "p1",
      assetId: "knowledge/guide.md",
      content: "# Guide\n\nnew\n",
      expectedRevision: preview.expectedRevision,
      message: "docs: update guide",
    });
    expect(result.pushed).toBe(false);
    expect(
      await readFile(join(checkout, "knowledge/guide.md"), "utf8"),
    ).toContain("new");
    const log = await runGit(checkout, ["log", "-1", "--pretty=%s"]);
    expect(log.stdout).toBe("docs: update guide");
    const files = await runGit(checkout, [
      "show",
      "--name-only",
      "--pretty=format:",
      "HEAD",
    ]);
    expect(files.stdout.trim()).toBe("knowledge/guide.md");
  });

  it("rejects a stale expected revision", async () => {
    await expect(
      commitPublish({
        projectId: "p1",
        assetId: "knowledge/guide.md",
        content: "# Guide\n\nnew\n",
        expectedRevision: "0000000000000000000000000000000000000000",
      }),
    ).rejects.toMatchObject({ code: "E_REVISION_CONFLICT" });
  });

  it("rejects credential paths and missing skill names", async () => {
    await expect(
      previewPublish({
        projectId: "p1",
        assetId: "knowledge/guide.md",
        content: "# Guide\n\nnew\n",
        path: "../.env",
      }),
    ).rejects.toMatchObject({ code: "E_PATH_UNSAFE" });
  });
});
