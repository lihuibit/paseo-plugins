import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentIndex } from "../server/agent-index";
import { TaskBoardService } from "../server/service";
import { BoardStore } from "../server/store";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "task-board-test-"));
  process.env.PASEO_HOME = home;
});

afterEach(async () => {
  delete process.env.PASEO_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("task board persistence", () => {
  it("writes tasks.json atomically and reloads it", async () => {
    const first = new BoardStore();
    const service = new TaskBoardService(first, new AgentIndex());
    const task = await service.create({ title: "Persisted card" });
    expect(task.displayId).toBe("TASK-1");

    const raw = JSON.parse(
      await readFile(
        join(home, "plugin-data/paseo-task-board/tasks.json"),
        "utf8",
      ),
    ) as { tasks: Array<{ id: string }> };
    expect(raw.tasks.map((entry) => entry.id)).toEqual([task.id]);

    const reloaded = new BoardStore();
    await reloaded.load();
    const document = await reloaded.read();
    expect(document.tasks[0]?.title).toBe("Persisted card");
    expect(document.nextNumber).toBe(2);
  });

  it("serializes concurrent writes and enforces revisions", async () => {
    const store = new BoardStore();
    const service = new TaskBoardService(store, new AgentIndex());
    const task = await service.create({ title: "Concurrent" });
    await Promise.all([
      service.update(task.id, { description: "one" }, task.revision),
      service
        .update(task.id, { priority: "high" }, task.revision)
        .catch((error: unknown) => error),
    ]);
    const current = await service.get(task.id);
    expect(current.revision).toBe(1);

    await expect(
      service.update(task.id, { title: "stale" }, task.revision),
    ).rejects.toMatchObject({ code: "E_REVISION_CONFLICT" });
  });

  it("lists and filters cards", async () => {
    const store = new BoardStore();
    const service = new TaskBoardService(store, new AgentIndex());
    const one = await service.create({ title: "Alpha", labels: ["cli"] });
    await service.create({ title: "Beta" });
    const filtered = await service.list({
      includeFinished: true,
      query: "alpha",
      label: "cli",
    });
    expect(filtered.tasks.map((task) => task.id)).toEqual([one.id]);
    expect(filtered.counts.planning).toBe(2);
  });
});
