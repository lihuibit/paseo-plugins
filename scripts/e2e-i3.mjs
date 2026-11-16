#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const root = fileURLToPath(new URL("..", import.meta.url));
const home = process.env.E2E_PASEO_HOME ?? "/home/ubuntu/.paseo-dev";
const port = process.env.E2E_PASEO_PORT ?? "6767";
const projectId = process.env.E2E_PROJECT_ID ?? "prj_a8ff4ccb22d60287";
const workspaceId = process.env.E2E_WORKSPACE_ID ?? "wks_de5b6f178e4150c4";
const bare = process.env.E2E_BARE ?? join(root, ".e2e/team.git");
const origin = process.env.E2E_ORIGIN ?? join(root, ".e2e/team-origin");
const demo = process.env.E2E_DEMO ?? join(root, ".e2e/demo-project");
const out = process.env.E2E_OUT ?? join(root, ".e2e/evidence/I3/e2e-i3.json");
const pluginId = "paseo-shared-assets";
const checkout = join(home, "plugin-data", pluginId, "repos", projectId);
const evidence = {
  startedAt: new Date().toISOString(),
  steps: [],
  assertions: {},
};

const password = (await readFile(`${home}/local-credential`, "utf8")).trim();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  password,
  clientId: "shared-assets-i3-e2e",
  reconnect: { enabled: false },
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function step(name, detail) {
  evidence.steps.push({ name, at: new Date().toISOString(), detail });
  console.log(`- ${name}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function call(method, input = {}) {
  const envelope = await client.invokePluginRpc(pluginId, method, input);
  if (!envelope || typeof envelope !== "object" || envelope.ok !== true) {
    throw new Error(`${method} failed: ${JSON.stringify(envelope)}`);
  }
  return envelope.value;
}

async function exists(path) {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

async function drift() {
  return await call("shared-assets.drift.list", { projectId, workspaceId });
}

function statusOf(items, assetId) {
  return items.find((item) => item.assetId === assetId)?.status ?? null;
}

async function remoteCommit(message, mutate) {
  const current = git(origin, "symbolic-ref", "--short", "HEAD");
  git(origin, "pull", "--quiet", "--ff-only", bare, current);
  await mutate(origin);
  git(origin, "add", ".");
  git(origin, "commit", "--quiet", "-m", message);
  const branch = git(origin, "symbolic-ref", "--short", "HEAD");
  git(origin, "push", "--quiet", bare, `HEAD:${branch}`);
}

function pushCheckout() {
  const branch = git(checkout, "symbolic-ref", "--short", "HEAD");
  git(checkout, "push", "--quiet", "origin", `HEAD:${branch}`);
}

async function main() {
  await client.connect();
  step("connect", { home, port, projectId, workspaceId });

  const projects = await call("shared-assets.projects.list");
  const project = projects.find((entry) => entry.projectId === projectId);
  assert(project, `project ${projectId} not found`);
  if (project.bound) {
    await call("shared-assets.unbind", { projectId, force: true });
    step("reset existing binding", { projectId });
  }
  await rm(
    join(home, "plugin-data", pluginId, "migrations", `${projectId}.json`),
    { force: true },
  );

  const configured = await call("shared-assets.configure", {
    projectId,
    repoUrl: bare,
    branch: null,
    syncMode: "manual",
    trustConfirmed: true,
  });
  evidence.assertions.binding = configured.binding;
  step("configure", {
    libraryId: configured.binding.libraryId,
    localRevision: configured.binding.state.localRevision,
    syncMode: configured.binding.syncMode,
  });

  const pulled = await call("shared-assets.workspace.pull", {
    projectId,
    workspaceId,
  });
  evidence.assertions.pull = pulled;
  assert(
    await exists(join(demo, ".paseo", "knowledge", "deploy.md")),
    "workspace pull did not copy deploy.md",
  );
  step("workspace pull", {
    imported: pulled.imported.length,
    updated: pulled.updated.length,
    kept: pulled.kept.length,
  });

  const syncedDrift = await drift();
  evidence.assertions.initialDrift = syncedDrift;
  assert(
    syncedDrift.every((item) => item.status === "synced"),
    "fresh drift is not fully synced",
  );
  step(
    "drift after pull",
    syncedDrift.map((item) => `${item.assetId}:${item.status}`),
  );

  const localGuide = join(demo, ".paseo", "knowledge", "deploy.md");
  const remoteGuide = join(checkout, "knowledge", "deploy.md");
  const baseGuide = await readFile(localGuide, "utf8");
  await writeFile(
    localGuide,
    `${baseGuide.trimEnd()}\n- local conflict note\n`,
  );
  let driftNow = await drift();
  assert(
    statusOf(driftNow, "knowledge/deploy.md") === "local-update",
    "local edit was not detected",
  );
  evidence.assertions.localUpdateDrift = driftNow.find(
    (item) => item.assetId === "knowledge/deploy.md",
  );
  step("drift local-update", statusOf(driftNow, "knowledge/deploy.md"));

  await remoteCommit("docs: remote conflict note", async (dir) => {
    const path = join(dir, "knowledge", "deploy.md");
    const current = await readFile(path, "utf8");
    await writeFile(path, `${current.trimEnd()}\n- remote conflict note\n`);
  });
  await call("shared-assets.sync", { projectId });
  driftNow = await drift();
  assert(
    statusOf(driftNow, "knowledge/deploy.md") === "diverged",
    `expected diverged, got ${statusOf(driftNow, "knowledge/deploy.md")}`,
  );
  evidence.assertions.divergedDrift = driftNow.find(
    (item) => item.assetId === "knowledge/deploy.md",
  );
  step("drift diverged", statusOf(driftNow, "knowledge/deploy.md"));

  const blockedPreview = await call("shared-assets.publish.batch.preview", {
    projectId,
    workspaceId,
    items: [{ assetId: "knowledge/deploy.md" }],
  });
  evidence.assertions.blockedPublishPreview = blockedPreview;
  assert(
    blockedPreview.items[0]?.state === "ineligible",
    "diverged asset should be ineligible",
  );
  assert(
    blockedPreview.items[0]?.reasons.some(
      (reason) => reason.code === "E_CONFLICT_UNRESOLVED",
    ),
    "missing E_CONFLICT_UNRESOLVED reason",
  );
  const blocked = await call("shared-assets.publish.batch.commit", {
    projectId,
    workspaceId,
    items: [{ assetId: "knowledge/deploy.md" }],
    expectedRevision: blockedPreview.expectedRevision,
  });
  evidence.assertions.blockedPublish = blocked;
  assert(blocked.commit === null, "unresolved conflict must not commit");
  assert(
    (await readFile(remoteGuide, "utf8")).includes("remote conflict note") &&
      !(await readFile(remoteGuide, "utf8")).includes("local conflict note"),
    "unresolved publish modified shared content",
  );
  step("batch publish blocked by conflict", {
    state: blockedPreview.items[0]?.state,
    reasons: blockedPreview.items[0]?.reasons,
  });

  const mergePreview = await call("shared-assets.merge.preview", {
    projectId,
    workspaceId,
    assetId: "knowledge/deploy.md",
  });
  evidence.assertions.mergePreview = mergePreview;
  assert(mergePreview.hasConflicts, "expected a merge conflict");
  const applied = await call("shared-assets.merge.apply", {
    projectId,
    workspaceId,
    assetId: "knowledge/deploy.md",
    resolutions: mergePreview.conflicts.map((conflict) => ({
      conflictId: conflict.id,
      choice: "both",
    })),
    expectedLocalDigest: mergePreview.expectedLocalDigest,
    expectedRemoteDigest: mergePreview.expectedRemoteDigest,
  });
  evidence.assertions.mergeApplied = applied;
  const mergedLocal = await readFile(localGuide, "utf8");
  assert(
    mergedLocal.includes("local conflict note") &&
      mergedLocal.includes("remote conflict note"),
    "merge did not keep both sides",
  );
  driftNow = await drift();
  assert(
    statusOf(driftNow, "knowledge/deploy.md") === "local-update",
    "resolved merge should become local-update",
  );
  step("merge conflict resolved", {
    conflicts: mergePreview.conflicts.length,
    repositoryPath: applied.repositoryPath,
  });

  const deployPreview = await call("shared-assets.publish.batch.preview", {
    projectId,
    workspaceId,
    items: [{ assetId: "knowledge/deploy.md" }],
  });
  assert(
    deployPreview.items[0]?.state === "eligible",
    "resolved asset should be publishable",
  );
  const deployCommit = await call("shared-assets.publish.batch.commit", {
    projectId,
    workspaceId,
    items: [{ assetId: "knowledge/deploy.md" }],
    expectedRevision: deployPreview.expectedRevision,
    message: "docs: resolve deploy conflict",
  });
  evidence.assertions.deployCommit = deployCommit;
  assert(deployCommit.commit, "resolved publish did not commit");
  assert(
    (await readFile(remoteGuide, "utf8")).includes("local conflict note"),
    "resolved local side was not published",
  );
  pushCheckout();
  step("publish after merge", { commit: deployCommit.commit });

  await remoteCommit("docs: add alpha and beta", async (dir) => {
    await writeFile(join(dir, "knowledge", "alpha.md"), "# Alpha\n\nbase\n");
    await writeFile(join(dir, "knowledge", "beta.md"), "# Beta\n\nbase\n");
  });
  await call("shared-assets.sync", { projectId });
  await call("shared-assets.workspace.pull", { projectId, workspaceId });
  const alphaLocal = join(demo, ".paseo", "knowledge", "alpha.md");
  const betaLocal = join(demo, ".paseo", "knowledge", "beta.md");
  await writeFile(alphaLocal, "# Alpha\n\nbase\n\nalpha local\n");
  await writeFile(betaLocal, "# Beta\n\nbase\n\nbeta local\n");
  await remoteCommit("docs: beta remote conflict", async (dir) => {
    await writeFile(
      join(dir, "knowledge", "beta.md"),
      "# Beta\n\nbase\n\nbeta remote\n",
    );
  });
  await call("shared-assets.sync", { projectId });

  const partialPreview = await call("shared-assets.publish.batch.preview", {
    projectId,
    workspaceId,
    items: [
      { assetId: "knowledge/alpha.md" },
      { assetId: "knowledge/beta.md" },
    ],
  });
  evidence.assertions.partialPreview = partialPreview;
  assert(
    partialPreview.items[0]?.state === "eligible" &&
      partialPreview.items[1]?.state === "ineligible",
    "partial preview did not separate eligible and conflicted items",
  );
  const partial = await call("shared-assets.publish.batch.commit", {
    projectId,
    workspaceId,
    items: [
      { assetId: "knowledge/alpha.md" },
      { assetId: "knowledge/beta.md" },
    ],
    expectedRevision: partialPreview.expectedRevision,
    message: "docs: partial batch",
  });
  evidence.assertions.partialCommit = partial;
  assert(
    partial.published.length === 1 &&
      partial.published[0].assetId === "knowledge/alpha.md",
    "partial batch did not publish only alpha",
  );
  assert(
    partial.failed.length === 1 &&
      partial.failed[0].assetId === "knowledge/beta.md",
    "partial batch did not report beta failure",
  );
  const changedFiles = git(
    checkout,
    "show",
    "--name-only",
    "--pretty=format:",
    "HEAD",
  )
    .split("\n")
    .filter(Boolean);
  evidence.assertions.partialCommitFiles = changedFiles;
  assert(
    changedFiles.length === 1 && changedFiles[0] === "knowledge/alpha.md",
    `batch commit contained unexpected paths: ${changedFiles.join(", ")}`,
  );
  assert(
    (await readFile(join(checkout, "knowledge", "beta.md"), "utf8")).includes(
      "beta remote",
    ),
    "conflicted beta was overwritten",
  );
  pushCheckout();
  step("selective batch publish", {
    published: partial.published.map((entry) => entry.assetId),
    failed: partial.failed.map((entry) => entry.assetId),
    files: changedFiles,
  });

  await remoteCommit("docs: add gamma", async (dir) => {
    await writeFile(join(dir, "knowledge", "gamma.md"), "# Gamma\n\nbase\n");
  });
  await call("shared-assets.sync", { projectId });
  await call("shared-assets.workspace.pull", { projectId, workspaceId });
  const gammaLocal = join(demo, ".paseo", "knowledge", "gamma.md");
  await writeFile(gammaLocal, "# Gamma\n\nlocal change\n");
  driftNow = await drift();
  assert(
    statusOf(driftNow, "knowledge/gamma.md") === "local-update",
    "gamma local edit not detected",
  );
  await call("shared-assets.drift.resolve", {
    projectId,
    workspaceId,
    assetId: "knowledge/gamma.md",
    path: null,
    action: "overwrite",
  });
  driftNow = await drift();
  assert(
    statusOf(driftNow, "knowledge/gamma.md") === null,
    "overwrite left gamma in the drift list",
  );
  assert(
    (await readFile(gammaLocal, "utf8")).includes("base"),
    "overwrite kept local gamma content",
  );
  step(
    "drift overwrite action",
    statusOf(driftNow, "knowledge/gamma.md") ?? "synced",
  );

  const ignoreSet = await call("shared-assets.ignore.rules.set", {
    projectId,
    raw: "kind:knowledge\n",
  });
  evidence.assertions.ignoreSet = ignoreSet;
  assert(ignoreSet.commit, "ignore rules were not committed");
  driftNow = await drift();
  assert(
    driftNow
      .filter((item) => item.kind === "knowledge")
      .every((item) => item.ignored),
    "knowledge assets were not ignored",
  );
  assert(
    (await readFile(join(checkout, "ignore-rules"), "utf8")).includes(
      "kind:knowledge",
    ),
    "ignore-rules was not persisted",
  );
  await call("shared-assets.ignore.rules.set", { projectId, raw: "" });
  step("ignore rules", { commit: ignoreSet.commit });

  await mkdir(join(demo, ".paseo", "docs", "legacy-i3"), {
    recursive: true,
  });
  await mkdir(join(demo, ".paseo", "workflows"), { recursive: true });
  await writeFile(
    join(demo, ".paseo", "knowledge", "legacy-i3.md"),
    "# Legacy I3\n\nMigrated knowledge.\n",
  );
  await writeFile(
    join(demo, ".paseo", "docs", "legacy-i3", "README.md"),
    "# Legacy I3 doc\n",
  );
  await writeFile(
    join(demo, ".paseo", "workflows", "old.md"),
    "# Workflow\n\nMust not migrate.\n",
  );
  const migrationPreview = await call("shared-assets.migrate", {
    projectId,
    workspaceId,
    dryRun: true,
  });
  evidence.assertions.migrationPreview = migrationPreview;
  assert(
    migrationPreview.files.some(
      (file) =>
        file.repositoryPath === "knowledge/legacy-i3.md" &&
        file.action === "import",
    ),
    "migration preview did not plan legacy knowledge",
  );
  assert(
    migrationPreview.skipped.some((entry) =>
      entry.path.startsWith("workflows/"),
    ),
    "migration preview did not skip workflows",
  );
  assert(
    !(await exists(join(checkout, "knowledge", "legacy-i3.md"))),
    "dry run wrote into the checkout",
  );
  const migrationApplied = await call("shared-assets.migrate", {
    projectId,
    workspaceId,
    dryRun: false,
  });
  evidence.assertions.migrationApplied = migrationApplied;
  assert(
    migrationApplied.applied && migrationApplied.commit,
    "migration did not apply",
  );
  assert(
    await exists(join(checkout, "knowledge", "legacy-i3.md")),
    "migration did not import knowledge",
  );
  assert(
    await exists(join(checkout, "docs", "legacy-i3", "README.md")),
    "migration did not import docs",
  );
  assert(
    await exists(join(demo, ".paseo", "knowledge", "legacy-i3.md")),
    "migration deleted the source",
  );
  assert(
    !(await exists(join(checkout, "workflows", "old.md"))),
    "migration imported workflows",
  );
  step("legacy migration", {
    before: migrationApplied.before,
    after: migrationApplied.after,
    commit: migrationApplied.commit,
  });

  const finalStatus = await call("shared-assets.status", { projectId });
  evidence.assertions.finalStatus = finalStatus;
  const config = JSON.parse(
    await readFile(join(home, "plugin-data", pluginId, "config.json"), "utf8"),
  );
  evidence.assertions.config = {
    binding: config.bindings[projectId],
    settings: config.settings ?? null,
  };
  const providers = await call("shared-assets.providers.list");
  evidence.assertions.providers = providers;
  step(
    "provider matrix",
    providers.map((entry) => `${entry.id}:${entry.installed}`),
  );

  evidence.finishedAt = new Date().toISOString();
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nEvidence written to ${out}`);
  await client.close();
}

await main().catch(async (error) => {
  evidence.error = error instanceof Error ? error.stack : String(error);
  evidence.finishedAt = new Date().toISOString();
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`).catch(
    () => {},
  );
  console.error(error);
  await client.close().catch(() => {});
  process.exit(1);
});
