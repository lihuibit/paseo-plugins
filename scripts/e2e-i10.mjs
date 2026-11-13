#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const root = fileURLToPath(new URL("..", import.meta.url));
const home = process.env.E2E_PASEO_HOME ?? "/home/ubuntu/.paseo-dev";
const port = process.env.E2E_PASEO_PORT ?? "6767";
const projectId = process.env.E2E_PROJECT_ID ?? "prj_a8ff4ccb22d60287";
const workspaceId = process.env.E2E_WORKSPACE_ID ?? "wks_de5b6f178e4150c4";
const bare = process.env.E2E_BARE ?? join(root, ".e2e/team.git");
const demo = process.env.E2E_DEMO ?? join(root, ".e2e/demo-project");
const out =
  process.env.E2E_OUT ??
  "/home/ubuntu/lihui/code/funny_projects/agentstorm/docs/plugins/evidence/implementation/I10/e2e-i10.json";
const pluginId = "agentstorm-shared-assets";
const checkout = join(home, "plugin-data", pluginId, "repos", projectId);
const configPath = join(home, "plugin-data", pluginId, "config.json");
const evidence = {
  startedAt: new Date().toISOString(),
  steps: [],
  assertions: {},
  failures: [],
};

const password = (await readFile(`${home}/local-credential`, "utf8")).trim();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  localCredential: () => password,
  clientId: "shared-assets-i10-e2e",
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
    return {
      error: envelope?.error ?? { code: "E_UNKNOWN", message: "no envelope" },
    };
  }
  return { value: envelope.value };
}

async function callOk(method, input = {}) {
  const result = await call(method, input);
  if (result.error) {
    throw new Error(`${method}: ${result.error.code} ${result.error.message}`);
  }
  return result.value;
}

async function relationshipRows(kind, provider = null) {
  return (
    await callOk("shared-assets.relationships.list", {
      projectId,
      workspaceId,
      kind,
      provider,
    })
  ).rows;
}

async function writeConfigWithLegacyGlobal() {
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  raw.skills ??= {};
  raw.skills[projectId] ??= [];
  raw.skills[projectId].push({
    assetId: "skill:global/legacy",
    name: "legacy",
    provider: "codex",
    targetPath: join(demo, ".codex/skills/legacy"),
    baselineDigest: "legacy",
    updatedAt: new Date().toISOString(),
  });
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`);
}

async function main() {
  await client.connect();
  step("connect", { home, port, projectId, workspaceId });

  const projects = await callOk("shared-assets.projects.list");
  const project = projects.find((entry) => entry.projectId === projectId);
  assert(project, `project ${projectId} not found`);
  if (project.bound) {
    await callOk("shared-assets.unbind", { projectId, force: true });
    step("reset binding");
  }
  await rm(join(demo, ".codex/skills/code-review"), {
    recursive: true,
    force: true,
  });
  await rm(join(demo, ".codex/skills/legacy"), {
    recursive: true,
    force: true,
  });
  await rm(join(demo, ".agentstorm/knowledge/local-adopt.md"), {
    force: true,
  });

  const configured = await callOk("shared-assets.configure", {
    projectId,
    repoUrl: bare,
    branch: null,
    syncMode: "manual",
    trustConfirmed: true,
  });
  evidence.assertions.configuredRevision =
    configured.binding.state.localRevision;
  step("configure", { libraryId: configured.binding.libraryId });

  const synced = await callOk("shared-assets.sync", { projectId });
  assert(
    synced.binding.state.localRevision,
    "sync did not report a local revision",
  );
  evidence.assertions.sync = {
    changed: synced.changed,
    localRevision: synced.binding.state.localRevision,
  };
  step("sync", evidence.assertions.sync);

  await callOk("shared-assets.workspace.pull", { projectId, workspaceId });
  step("workspace pull");

  const sharedSkill = await callOk("shared-assets.assets.read", {
    projectId,
    assetId: "skill:project/code-review",
    path: "SKILL.md",
  });
  await execFileSync("mkdir", ["-p", join(demo, ".codex/skills/code-review")], {
    encoding: "utf8",
  });
  const modifiedSkill = `${sharedSkill.content}\nlocal association edit\n`;
  await writeFile(
    join(demo, ".codex/skills/code-review/SKILL.md"),
    modifiedSkill,
  );
  const candidateRows = await relationshipRows("skill", "codex");
  const candidate = candidateRows.find(
    (row) => row.shared?.assetId === "skill:project/code-review",
  );
  assert(candidate?.relationship === "candidate", "skill is not a candidate");
  evidence.assertions.candidate = candidate;
  step("relationship candidate", {
    relationship: candidate.relationship,
    local: candidate.local?.assetId,
  });

  await callOk("shared-assets.relationships.adopt", {
    projectId,
    workspaceId,
    kind: "skill",
    provider: "codex",
    assetId: "skill:project/code-review",
    localAssetId: "local-skill:codex/code-review",
    mode: "preserve-local",
  });
  const linkedRows = await relationshipRows("skill", "codex");
  const linked = linkedRows.find(
    (row) => row.shared?.assetId === "skill:project/code-review",
  );
  assert(linked?.relationship === "linked", "skill did not link");
  assert(
    await readFile(
      join(demo, ".codex/skills/code-review/SKILL.md"),
      "utf8",
    ).then((value) => value.includes("local association edit")),
    "preserve-local overwrote the local skill",
  );
  evidence.assertions.linked = {
    relationship: linked.relationship,
    syncStatus: linked.syncStatus,
  };
  step("adopt preserve-local", {
    relationship: linked.relationship,
    syncStatus: linked.syncStatus,
  });

  const unlinked = await callOk("shared-assets.relationships.unlink", {
    projectId,
    workspaceId,
    kind: "skill",
    provider: "codex",
    assetId: "skill:project/code-review",
    deleteLocal: false,
  });
  assert(unlinked.kept.length === 1, "unlink did not keep the local copy");
  assert(
    existsSync(join(demo, ".codex/skills/code-review/SKILL.md")),
    "local copy missing",
  );
  evidence.assertions.unlinked = unlinked;
  step("unlink keep-local", { kept: unlinked.kept.length });

  await callOk("shared-assets.relationships.adopt", {
    projectId,
    workspaceId,
    kind: "skill",
    provider: "codex",
    assetId: "skill:project/code-review",
    localAssetId: "local-skill:codex/code-review",
    mode: "use-remote",
  });
  assert(
    (await readFile(
      join(demo, ".codex/skills/code-review/SKILL.md"),
      "utf8",
    )) === sharedSkill.content,
    "use-remote did not copy the shared skill",
  );
  step("adopt use-remote");

  await callOk("shared-assets.relationships.unlink", {
    projectId,
    workspaceId,
    kind: "skill",
    provider: "codex",
    assetId: "skill:project/code-review",
    deleteLocal: false,
  });

  await writeFile(
    join(demo, ".agentstorm/knowledge/local-adopt.md"),
    "# Local adopt\n",
  );
  await writeFile(
    join(checkout, "knowledge/local-adopt.md"),
    "# Shared adopt\n",
  );
  await git(checkout, "add", "knowledge/local-adopt.md");
  await git(checkout, "commit", "--quiet", "-m", "test: add local-adopt");
  const knowledgeRows = await relationshipRows("knowledge");
  const knowledgeCandidate = knowledgeRows.find(
    (row) => row.shared?.assetId === "knowledge/local-adopt.md",
  );
  assert(
    knowledgeCandidate?.relationship === "candidate",
    "knowledge not candidate",
  );
  await callOk("shared-assets.relationships.adopt", {
    projectId,
    workspaceId,
    kind: "knowledge",
    provider: null,
    assetId: "knowledge/local-adopt.md",
    localAssetId: "local:knowledge/local-adopt",
    mode: "preserve-local",
  });
  await callOk("shared-assets.relationships.adopt", {
    projectId,
    workspaceId,
    kind: "skill",
    provider: "codex",
    assetId: "skill:project/code-review",
    localAssetId: "local-skill:codex/code-review",
    mode: "preserve-local",
  });
  const batch = await callOk("shared-assets.relationships.batch-unlink", {
    projectId,
    workspaceId,
    kind: "knowledge",
    provider: null,
    assetIds: ["knowledge/local-adopt.md", "knowledge/beta.md"],
    deleteLocal: false,
  });
  assert(
    batch.items.length === 2 && batch.failed.length === 0,
    "batch unlink failed",
  );
  evidence.assertions.batchUnlink = batch;
  step("batch unlink", {
    succeeded: batch.items.length,
    failed: batch.failed.length,
  });

  const betaPath = join(demo, ".agentstorm/knowledge/beta.md");
  const beta = await readFile(betaPath, "utf8");
  await writeFile(betaPath, `${beta}\nattention edit\n`);
  const attention = (await callOk("shared-assets.projects.list")).find(
    (entry) => entry.projectId === projectId,
  );
  assert(
    attention.attention.items.some(
      (item) => item.name === "beta" && item.reason === "local-update",
    ),
    "attention did not include the local knowledge update",
  );
  evidence.assertions.attention = attention.attention;
  step("project attention", attention.attention);

  const preview = await callOk("shared-assets.publish.batch.preview", {
    projectId,
    workspaceId,
    items: [{ assetId: "knowledge/beta.md" }],
  });
  const headBefore = git(checkout, "rev-parse", "HEAD");
  await writeFile(join(checkout, "knowledge/gamma.md"), "# Gamma moved\n");
  await git(checkout, "add", "knowledge/gamma.md");
  await git(checkout, "commit", "--quiet", "-m", "test: move checkout");
  const stale = await call("shared-assets.publish.batch.commit", {
    projectId,
    workspaceId,
    items: [{ assetId: "knowledge/beta.md" }],
    expectedRevision: preview.expectedRevision,
  });
  assert(
    stale.error?.code === "E_REVISION_CONFLICT",
    "stale preview was not rejected",
  );
  assert(
    git(checkout, "rev-parse", "HEAD") !== headBefore,
    "checkout did not move",
  );
  const refreshed = await callOk("shared-assets.publish.batch.preview", {
    projectId,
    workspaceId,
    items: [{ assetId: "knowledge/beta.md" }],
  });
  assert(
    refreshed.expectedRevision !== preview.expectedRevision,
    "preview did not reload after the checkout moved",
  );
  evidence.assertions.stalePreview = {
    rejectedCode: stale.error.code,
    oldRevision: preview.expectedRevision,
    newRevision: refreshed.expectedRevision,
  };
  step("stale preview", evidence.assertions.stalePreview);

  const ignoreSet = await callOk("shared-assets.ignore.rules.set", {
    projectId,
    raw: "path:knowledge/ignored-*\nkind:doc\n",
    message: "test: ignore rules",
  });
  const ignoreGet = await callOk("shared-assets.ignore.rules.get", {
    projectId,
  });
  assert(ignoreSet.rules.length === 2, "ignore rules were not saved");
  assert(ignoreGet.raw === ignoreSet.raw, "ignore rules did not round-trip");
  evidence.assertions.ignoreRules = {
    rules: ignoreGet.rules,
    errors: ignoreGet.errors,
    commit: ignoreSet.commit,
  };
  step("ignore rules", evidence.assertions.ignoreRules);

  await execFileSync("mkdir", ["-p", join(checkout, "skills/global/legacy")], {
    encoding: "utf8",
  });
  await writeFile(
    join(checkout, "skills/global/legacy/SKILL.md"),
    "---\nname: legacy\n---\n# Global legacy\n",
  );
  await git(checkout, "add", "skills/global/legacy/SKILL.md");
  await git(checkout, "commit", "--quiet", "-m", "test: add global skill");
  const assets = await callOk("shared-assets.assets.list", { projectId });
  assert(
    assets.every((asset) => !asset.assetId.includes("global")),
    "global skill leaked into the asset scanner",
  );
  evidence.assertions.globalIgnored = assets.map((asset) => asset.assetId);
  step("global skill ignored", evidence.assertions.globalIgnored);

  await execFileSync("mkdir", ["-p", join(demo, ".codex/skills/legacy")], {
    encoding: "utf8",
  });
  await writeFile(
    join(demo, ".codex/skills/legacy/SKILL.md"),
    "---\nname: legacy\n---\n# Legacy projection\n",
  );
  await writeConfigWithLegacyGlobal();
  await callOk("shared-assets.unbind", { projectId, force: true });
  assert(
    existsSync(join(demo, ".codex/skills/legacy/SKILL.md")),
    "legacy global projection was deleted by unbind",
  );
  evidence.assertions.legacyProjectionPreserved = true;
  step("legacy global projection preserved");

  await callOk("shared-assets.configure", {
    projectId,
    repoUrl: bare,
    branch: null,
    syncMode: "manual",
    trustConfirmed: true,
  });
  await callOk("shared-assets.workspace.pull", { projectId, workspaceId });
  step("restore binding for UI evidence");

  evidence.finishedAt = new Date().toISOString();
  evidence.ok = true;
}

try {
  await main();
} catch (error) {
  evidence.ok = false;
  evidence.failures.push(
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
  console.error(error);
} finally {
  await client.disconnect?.().catch(() => {});
  await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`evidence: ${out}`);
  process.exit(process.exitCode ?? 0);
}
