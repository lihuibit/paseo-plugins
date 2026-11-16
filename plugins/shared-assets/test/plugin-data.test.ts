import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "shared-assets-data-"));
  process.env.PASEO_HOME = home;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.PASEO_HOME;
  await rm(home, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

describe("plugin data migration", () => {
  it("copies legacy agentstorm-shared-assets data into paseo-shared-assets", async () => {
    const legacy = join(home, "plugin-data", "agentstorm-shared-assets");
    await mkdir(join(legacy, "repos", "prj_1"), { recursive: true });
    await writeFile(join(legacy, "config.json"), '{"projects":{}}\n');
    await writeFile(join(legacy, "repos", "prj_1", "AGENTS.md"), "# Shared\n");

    const { ensureDataDirs, pluginDataDir } =
      await import("../server/plugin-data");
    await ensureDataDirs();

    expect(await readFile(join(pluginDataDir(), "config.json"), "utf8")).toBe(
      '{"projects":{}}\n',
    );
    expect(
      await readFile(
        join(pluginDataDir(), "repos", "prj_1", "AGENTS.md"),
        "utf8",
      ),
    ).toBe("# Shared\n");
    expect(await exists(join(legacy, "config.json"))).toBe(true);
  });

  it("does not merge when the new directory already exists", async () => {
    const legacy = join(home, "plugin-data", "agentstorm-shared-assets");
    const target = join(home, "plugin-data", "paseo-shared-assets");
    await mkdir(legacy, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(legacy, "config.json"), '{"projects":{"old":1}}\n');
    await writeFile(join(target, "config.json"), '{"projects":{}}\n');

    const { ensureDataDirs, pluginDataDir } =
      await import("../server/plugin-data");
    await ensureDataDirs();

    expect(await readFile(join(pluginDataDir(), "config.json"), "utf8")).toBe(
      '{"projects":{}}\n',
    );
  });
});
