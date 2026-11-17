import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { parseSkillAssetId } from "../shared/core/paths";
import { repoDir } from "../server/plugin-data";
import { scanSkills } from "../server/repo";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "shared-assets-home-"));
  process.env.PASEO_HOME = home;
});

describe("global skill scope removal", () => {
  it("ignores a skills/global directory even when it exists", async () => {
    const checkout = repoDir("p1");
    await mkdir(join(checkout, "skills/global/legacy"), { recursive: true });
    await writeFile(
      join(checkout, "skills/global/legacy/SKILL.md"),
      "---\nname: legacy\n---\n# Legacy\n",
    );
    await mkdir(join(checkout, "skills/project/review"), { recursive: true });
    await writeFile(
      join(checkout, "skills/project/review/SKILL.md"),
      "---\nname: review\n---\n# Review\n",
    );
    const scan = await scanSkills(checkout);
    expect(scan.assets.map((asset) => asset.assetId)).toEqual([
      "skill:project/review",
    ]);
  });

  it("does not parse skill:global asset ids", () => {
    expect(parseSkillAssetId("skill:global/legacy")).toBeNull();
    expect(parseSkillAssetId("skill:project/review")).toEqual({
      scope: "project",
      name: "review",
    });
  });
});
