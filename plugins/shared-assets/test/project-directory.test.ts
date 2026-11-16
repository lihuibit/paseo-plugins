import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureProjectDirectory } from "../server/migration";

let home: string;
let workspace: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "shared-assets-project-home-"));
  workspace = await mkdtemp(join(tmpdir(), "shared-assets-project-ws-"));
  process.env.PASEO_HOME = home;
});

describe("project directory migration", () => {
  it("copies AGENTS.md, knowledge and docs without modifying the source", async () => {
    await mkdir(join(workspace, ".agentstorm", "knowledge"), {
      recursive: true,
    });
    await mkdir(join(workspace, ".agentstorm", "docs", "design"), {
      recursive: true,
    });
    await mkdir(join(workspace, ".agentstorm", "workflows"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".agentstorm", "AGENTS.md"),
      "# Legacy instructions\n",
    );
    await writeFile(
      join(workspace, ".agentstorm", "knowledge", "guide.md"),
      "# Guide\n",
    );
    await writeFile(
      join(workspace, ".agentstorm", "docs", "design", "README.md"),
      "# Design\n",
    );
    await writeFile(
      join(workspace, ".agentstorm", "workflows", "old.md"),
      "# Workflow\n",
    );

    const result = await ensureProjectDirectory(workspace);

    expect(result.applied).toBe(true);
    expect(await readFile(join(workspace, ".paseo", "AGENTS.md"), "utf8")).toBe(
      "# Legacy instructions\n",
    );
    expect(
      await readFile(
        join(workspace, ".paseo", "knowledge", "guide.md"),
        "utf8",
      ),
    ).toBe("# Guide\n");
    expect(
      await readFile(
        join(workspace, ".paseo", "docs", "design", "README.md"),
        "utf8",
      ),
    ).toBe("# Design\n");
    expect(
      await stat(join(workspace, ".paseo", "workflows")).catch(() => null),
    ).toBeNull();
    expect(
      await readFile(
        join(workspace, ".agentstorm", "knowledge", "guide.md"),
        "utf8",
      ),
    ).toBe("# Guide\n");
    expect(
      await readFile(join(workspace, ".agentstorm", "AGENTS.md"), "utf8"),
    ).toBe("# Legacy instructions\n");
  });

  it("keeps .paseo authoritative and never merges the legacy directory", async () => {
    await mkdir(join(workspace, ".paseo"), { recursive: true });
    await mkdir(join(workspace, ".agentstorm", "knowledge"), {
      recursive: true,
    });
    await writeFile(join(workspace, ".paseo", "AGENTS.md"), "# Current\n");
    await writeFile(
      join(workspace, ".agentstorm", "knowledge", "legacy.md"),
      "# Legacy\n",
    );

    const result = await ensureProjectDirectory(workspace);

    expect(result.applied).toBe(false);
    expect(await readFile(join(workspace, ".paseo", "AGENTS.md"), "utf8")).toBe(
      "# Current\n",
    );
    expect(
      await stat(join(workspace, ".paseo", "knowledge")).catch(() => null),
    ).toBeNull();
  });

  it("records the migration result in the plugin log", async () => {
    await mkdir(join(workspace, ".agentstorm", "knowledge"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".agentstorm", "knowledge", "guide.md"),
      "# Guide\n",
    );

    await ensureProjectDirectory(workspace);

    const log = await readFile(
      join(home, "plugin-data", "agentstorm-shared-assets", "logs", "rpc.log"),
      "utf8",
    );
    expect(log).toContain("project-migration");
    expect(log).toContain('"copied":1');
  });
});
