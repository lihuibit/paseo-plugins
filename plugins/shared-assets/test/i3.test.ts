import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { listDrift } from "../server/drift";
import { previewMerge, applyMerge } from "../server/merge";
import { materializeWorkspace } from "../server/materialize";
import {
  commitBatchPublish,
  previewBatchPublish,
} from "../server/batch-publish";
import { migrateLegacy } from "../server/migration";
import { repoDir } from "../server/plugin-data";
import { currentBranch, runGit } from "../server/git";
import { readConfig, writeConfig } from "../server/registry";
import { runAutoSync } from "../server/service";

const GUIDE_BASE = "# Guide\n\none\ntwo\nthree\n";

let home: string;
let workspace: string;
let checkout: string;

async function seedCheckout(): Promise<void> {
  checkout = repoDir("p1");
  await mkdir(join(checkout, "knowledge"), { recursive: true });
  await mkdir(join(checkout, "docs", "design"), { recursive: true });
  await writeFile(
    join(checkout, "team-assets.json"),
    JSON.stringify({
      schemaVersion: 1,
      libraryId: "team",
      displayName: "Team",
    }),
  );
  await writeFile(
    join(checkout, "AGENTS.md"),
    "# Team instructions\n\nAlways run tests.\n",
  );
  await writeFile(join(checkout, "knowledge", "guide.md"), GUIDE_BASE);
  await writeFile(
    join(checkout, "docs", "design", "README.md"),
    "# Design\n\n![flow](assets/flow.png)\n",
  );
  await runGit(checkout, ["init", "--quiet"]);
  await runGit(checkout, ["config", "user.name", "Test"]);
  await runGit(checkout, ["config", "user.email", "test@example.invalid"]);
  await runGit(checkout, ["add", "."]);
  await runGit(checkout, ["commit", "--quiet", "-m", "seed"]);
}

async function localGuide(): Promise<string> {
  return join(workspace, ".paseo", "knowledge", "guide.md");
}

async function remoteGuide(): Promise<string> {
  return join(checkout, "knowledge", "guide.md");
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "shared-assets-i3-"));
  workspace = await mkdtemp(join(tmpdir(), "shared-assets-i3-ws-"));
  process.env.PASEO_HOME = home;
  await seedCheckout();
  await materializeWorkspace("p1", workspace);
});

describe("drift detection", () => {
  it("omits synced assets from the drift list", async () => {
    const items = await listDrift("p1", workspace);
    expect(items).toEqual([]);
  });

  it("distinguishes local-update, remote-update and diverged", async () => {
    await writeFile(await localGuide(), `${GUIDE_BASE}local\n`);
    let items = await listDrift("p1", workspace);
    expect(
      items.find((item) => item.assetId === "knowledge/guide.md")?.status,
    ).toBe("local-update");

    await writeFile(await localGuide(), GUIDE_BASE);
    await materializeWorkspace("p1", workspace);
    await writeFile(await remoteGuide(), `${GUIDE_BASE}remote\n`);
    items = await listDrift("p1", workspace);
    expect(
      items.find((item) => item.assetId === "knowledge/guide.md")?.status,
    ).toBe("remote-update");

    await writeFile(await localGuide(), `${GUIDE_BASE}local again\n`);
    items = await listDrift("p1", workspace);
    expect(
      items.find((item) => item.assetId === "knowledge/guide.md")?.status,
    ).toBe("diverged");
  });

  it("marks assets ignored by shared rules", async () => {
    await writeFile(await localGuide(), `${GUIDE_BASE}local\n`);
    await writeFile(join(checkout, "ignore-rules"), "kind:knowledge\n");
    const items = await listDrift("p1", workspace);
    expect(
      items.find((item) => item.assetId === "knowledge/guide.md")?.ignored,
    ).toBe(true);
  });

  it("omits missing copies instead of reporting them as drift", async () => {
    await rm(await localGuide());
    await rm(await remoteGuide());
    const items = await listDrift("p1", workspace);
    expect(
      items.find((item) => item.assetId === "knowledge/guide.md"),
    ).toBeUndefined();
  });
});

describe("three-way merge", () => {
  async function diverge(): Promise<void> {
    await writeFile(await localGuide(), "# Guide\n\none\ntwo local\nthree\n");
    await writeFile(await remoteGuide(), "# Guide\n\none\ntwo remote\nthree\n");
  }

  it("reports a conflict and applies a per-block resolution", async () => {
    await diverge();
    const preview = await previewMerge({
      projectId: "p1",
      workspaceDirectory: workspace,
      assetId: "knowledge/guide.md",
    });
    expect(preview.hasConflicts).toBe(true);
    expect(preview.conflicts).toHaveLength(1);
    expect(preview.conflicts[0]?.local).toContain("two local");

    const applied = await applyMerge({
      projectId: "p1",
      workspaceDirectory: workspace,
      assetId: "knowledge/guide.md",
      resolutions: [
        { conflictId: preview.conflicts[0]?.id as string, choice: "both" },
      ],
      expectedLocalDigest: preview.expectedLocalDigest,
      expectedRemoteDigest: preview.expectedRemoteDigest,
    });
    expect(applied.conflictsRemaining).toBe(0);
    expect(applied.content).toContain("two local");
    expect(applied.content).toContain("two remote");
    const items = await listDrift("p1", workspace);
    expect(
      items.find((item) => item.assetId === "knowledge/guide.md")?.status,
    ).toBe("local-update");
  });

  it("refuses to save while a conflict is unresolved", async () => {
    await diverge();
    const preview = await previewMerge({
      projectId: "p1",
      workspaceDirectory: workspace,
      assetId: "knowledge/guide.md",
    });
    await expect(
      applyMerge({
        projectId: "p1",
        workspaceDirectory: workspace,
        assetId: "knowledge/guide.md",
        resolutions: [],
        expectedLocalDigest: preview.expectedLocalDigest,
        expectedRemoteDigest: preview.expectedRemoteDigest,
      }),
    ).rejects.toMatchObject({ code: "E_CONFLICT_UNRESOLVED" });
  });
});

describe("batch publish", () => {
  it("publishes only selected assets and reports conflicts without stopping", async () => {
    await writeFile(join(checkout, "knowledge", "other.md"), "# Other\n");
    await runGit(checkout, ["add", "."]);
    await runGit(checkout, ["commit", "--quiet", "-m", "add other"]);
    await materializeWorkspace("p1", workspace);

    await writeFile(await localGuide(), `${GUIDE_BASE}local edit\n`);
    await writeFile(
      join(workspace, ".paseo", "knowledge", "other.md"),
      "# Other\n\nlocal edit\n",
    );
    await writeFile(await remoteGuide(), `${GUIDE_BASE}remote edit\n`);

    const preview = await previewBatchPublish({
      projectId: "p1",
      workspaceDirectory: workspace,
      items: [
        { assetId: "knowledge/guide.md" },
        { assetId: "knowledge/other.md" },
      ],
    });
    expect(preview.items.map((item) => item.state)).toEqual([
      "ineligible",
      "eligible",
    ]);
    expect(preview.items[0]?.reasons[0]?.code).toBe("E_CONFLICT_UNRESOLVED");

    const result = await commitBatchPublish({
      projectId: "p1",
      workspaceDirectory: workspace,
      items: [
        { assetId: "knowledge/guide.md" },
        { assetId: "knowledge/other.md" },
      ],
      expectedRevision: preview.expectedRevision,
      message: "docs: batch update",
    });
    expect(result.failed.map((item) => item.assetId)).toEqual([
      "knowledge/guide.md",
    ]);
    expect(result.published.map((item) => item.assetId)).toEqual([
      "knowledge/other.md",
    ]);
    const files = await runGit(checkout, [
      "show",
      "--name-only",
      "--pretty=format:",
      "HEAD",
    ]);
    expect(files.stdout.trim()).toBe("knowledge/other.md");
    expect(
      await readFile(join(checkout, "knowledge", "other.md"), "utf8"),
    ).toContain("local edit");
    expect(
      await readFile(join(checkout, "knowledge", "guide.md"), "utf8"),
    ).toContain("remote edit");
  });

  it("rejects a stale expected revision without writing", async () => {
    await writeFile(await localGuide(), `${GUIDE_BASE}local edit\n`);
    await expect(
      commitBatchPublish({
        projectId: "p1",
        workspaceDirectory: workspace,
        items: [{ assetId: "knowledge/guide.md" }],
        expectedRevision: "0000000000000000000000000000000000000000",
      }),
    ).rejects.toMatchObject({ code: "E_REVISION_CONFLICT" });
    expect(await readFile(await remoteGuide(), "utf8")).toBe(GUIDE_BASE);
  });

  it("rolls back written files when the git commit fails", async () => {
    await writeFile(await localGuide(), `${GUIDE_BASE}local edit\n`);
    const preview = await previewBatchPublish({
      projectId: "p1",
      workspaceDirectory: workspace,
      items: [{ assetId: "knowledge/guide.md" }],
    });
    await writeFile(
      join(checkout, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\nexit 1\n",
      { mode: 0o755 },
    );
    await expect(
      commitBatchPublish({
        projectId: "p1",
        workspaceDirectory: workspace,
        items: [{ assetId: "knowledge/guide.md" }],
        expectedRevision: preview.expectedRevision,
      }),
    ).rejects.toMatchObject({ code: "E_INTERNAL" });
    expect(await readFile(await remoteGuide(), "utf8")).toBe(GUIDE_BASE);
    const status = await runGit(checkout, [
      "status",
      "--porcelain",
      "--",
      "knowledge/guide.md",
    ]);
    expect(status.stdout.trim()).toBe("");
  });
});

describe("project asset migration", () => {
  it("imports .paseo assets, keeps the source and skips workflows", async () => {
    await mkdir(join(workspace, ".paseo", "workflows"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".paseo", "workflows", "old.md"),
      "# Workflow\n",
    );
    await mkdir(join(workspace, ".paseo", "docs", "legacy"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".paseo", "docs", "legacy", "README.md"),
      "# Legacy\n",
    );
    await writeFile(
      join(workspace, ".paseo", "knowledge", "legacy.md"),
      "# Legacy knowledge\n",
    );
    await writeFile(await localGuide(), "# Guide\n\nchanged locally\n");

    const dryRun = await migrateLegacy({
      projectId: "p1",
      workspaceId: "w1",
      workspaceDirectory: workspace,
      dryRun: true,
    });
    expect(dryRun.applied).toBe(false);
    expect(dryRun.files.some((file) => file.action === "import")).toBe(true);
    expect(
      dryRun.files.find((file) => file.repositoryPath === "knowledge/guide.md")
        ?.action,
    ).toBe("conflict");
    expect(
      dryRun.skipped.some((entry) => entry.path.startsWith("workflows/")),
    ).toBe(true);
    expect(
      await stat(join(checkout, "knowledge", "legacy.md")).catch(() => null),
    ).toBeNull();

    const applied = await migrateLegacy({
      projectId: "p1",
      workspaceId: "w1",
      workspaceDirectory: workspace,
      dryRun: false,
    });
    expect(applied.applied).toBe(true);
    expect(applied.commit).toBeTruthy();
    expect(
      await readFile(join(checkout, "knowledge", "legacy.md"), "utf8"),
    ).toContain("Legacy knowledge");
    expect(
      await readFile(join(checkout, "docs", "legacy", "README.md"), "utf8"),
    ).toContain("Legacy");
    expect(
      await stat(join(checkout, "workflows", "old.md")).catch(() => null),
    ).toBeNull();
    expect(
      await readFile(
        join(workspace, ".paseo", "knowledge", "legacy.md"),
        "utf8",
      ),
    ).toContain("Legacy knowledge");

    const repeated = await migrateLegacy({
      projectId: "p1",
      workspaceId: "w1",
      workspaceDirectory: workspace,
      dryRun: false,
    });
    expect(repeated.reused).toBe(true);
  });

  it("falls back to .agentstorm only when .paseo is absent", async () => {
    const legacyWorkspace = await mkdtemp(
      join(tmpdir(), "shared-assets-legacy-"),
    );
    await mkdir(join(legacyWorkspace, ".agentstorm", "knowledge"), {
      recursive: true,
    });
    await writeFile(
      join(legacyWorkspace, ".agentstorm", "knowledge", "legacy-only.md"),
      "# Legacy only\n",
    );

    const report = await migrateLegacy({
      projectId: "p1",
      workspaceId: "w2",
      workspaceDirectory: legacyWorkspace,
      dryRun: false,
    });
    expect(report.applied).toBe(true);
    expect(
      await readFile(join(checkout, "knowledge", "legacy-only.md"), "utf8"),
    ).toContain("Legacy only");
    expect(
      await readFile(
        join(legacyWorkspace, ".agentstorm", "knowledge", "legacy-only.md"),
        "utf8",
      ),
    ).toContain("Legacy only");
  });
});

describe("auto sync mode", () => {
  async function autoBinding(mode: "auto" | "manual"): Promise<void> {
    const branch = (await currentBranch(checkout)) as string;
    const config = await readConfig();
    config.bindings.p1 = {
      projectId: "p1",
      projectRoot: workspace,
      libraryId: "team",
      displayName: "Team",
      repoUrl: join(home, "remote.git"),
      branch,
      syncMode: mode,
      configuredAt: new Date().toISOString(),
      revision: 0,
      state: {
        localRevision: null,
        remoteRevision: null,
        lastFetchedAt: null,
        lastSyncedAt: null,
        operation: "idle",
        dirty: false,
        ahead: 0,
        behind: 0,
        lastError: null,
      },
    };
    await writeConfig(config);
  }

  async function publishRemoteCommit(): Promise<void> {
    const branch = (await currentBranch(checkout)) as string;
    const bare = join(home, "remote.git");
    await runGit(null, ["clone", "--bare", "--quiet", checkout, bare]);
    await runGit(checkout, ["remote", "add", "origin", bare]);
    await runGit(checkout, ["fetch", "--quiet", "origin"]);
    const cloneDir = await mkdtemp(join(tmpdir(), "shared-assets-i3-remote-"));
    await runGit(null, ["clone", "--quiet", bare, cloneDir]);
    await runGit(cloneDir, ["config", "user.name", "Test"]);
    await runGit(cloneDir, ["config", "user.email", "test@example.invalid"]);
    await writeFile(
      join(cloneDir, "knowledge", "auto.md"),
      "# Auto\n\nremote update\n",
    );
    await runGit(cloneDir, ["add", "."]);
    await runGit(cloneDir, ["commit", "--quiet", "-m", "remote auto"]);
    await runGit(cloneDir, ["push", "--quiet", "origin", branch]);
  }

  it("fetches and fast-forwards only for auto bindings", async () => {
    await publishRemoteCommit();
    await autoBinding("manual");
    await runAutoSync();
    expect(
      await stat(join(checkout, "knowledge", "auto.md")).catch(() => null),
    ).toBeNull();

    await autoBinding("auto");
    await runAutoSync();
    expect(
      await readFile(join(checkout, "knowledge", "auto.md"), "utf8"),
    ).toContain("remote update");
    const config = await readConfig();
    expect(config.bindings.p1?.state.localRevision).toBeTruthy();
  });
});
