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
  home = await mkdtemp(join(tmpdir(), "task-board-data-"));
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
  it("copies legacy agentstorm-task-board data into paseo-task-board", async () => {
    const legacy = join(home, "plugin-data", "agentstorm-task-board");
    await mkdir(join(legacy, "locks"), { recursive: true });
    await writeFile(join(legacy, "tasks.json"), '{"tasks":[]}\n');
    await writeFile(join(legacy, "locks", "scheduler.lock"), "lock\n");

    const { ensureDataDir, pluginDataDir } =
      await import("../server/plugin-data");
    await ensureDataDir();

    expect(await readFile(join(pluginDataDir(), "tasks.json"), "utf8")).toBe(
      '{"tasks":[]}\n',
    );
    expect(
      await readFile(join(pluginDataDir(), "locks", "scheduler.lock"), "utf8"),
    ).toBe("lock\n");
    expect(await exists(join(legacy, "tasks.json"))).toBe(true);
  });

  it("does not merge when the new directory already exists", async () => {
    const legacy = join(home, "plugin-data", "agentstorm-task-board");
    const target = join(home, "plugin-data", "paseo-task-board");
    await mkdir(legacy, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(legacy, "tasks.json"), '{"tasks":["legacy"]}\n');
    await writeFile(join(target, "settings.json"), '{"wecom":{}}\n');

    const { ensureDataDir, pluginDataDir } =
      await import("../server/plugin-data");
    await ensureDataDir();

    expect(await exists(join(pluginDataDir(), "tasks.json"))).toBe(false);
    expect(await readFile(join(pluginDataDir(), "settings.json"), "utf8")).toBe(
      '{"wecom":{}}\n',
    );
  });
});
