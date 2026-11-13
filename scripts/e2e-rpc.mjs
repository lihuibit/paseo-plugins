#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const root = new URL("..", import.meta.url).pathname;
const home = process.env.E2E_PASEO_HOME ?? "/home/ubuntu/.paseo-dev";
const port = process.env.E2E_PASEO_PORT ?? "6767";
const projectId = process.env.E2E_PROJECT_ID ?? "prj_a8ff4ccb22d60287";
const workspaceId = process.env.E2E_WORKSPACE_ID ?? "wks_de5b6f178e4150c4";
const bare = process.env.E2E_BARE ?? join(root, ".e2e/team.git");
const origin = process.env.E2E_ORIGIN ?? join(root, ".e2e/team-origin");
const demo = process.env.E2E_DEMO ?? join(root, ".e2e/demo-project");
const pluginId = "agentstorm-shared-assets";
const checkout = join(home, "plugin-data", pluginId, "repos", projectId);
const evidence = { steps: [], assertions: {} };

const password = (await readFile(`${home}/local-credential`, "utf8")).trim();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  localCredential: () => password,
  clientId: "shared-assets-e2e",
  reconnect: { enabled: false },
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function step(name, detail) {
  evidence.steps.push({ name, at: new Date().toISOString(), detail });
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

async function main() {
  await client.connect();
  step("connect", { home, port });

  const projects = await call("shared-assets.projects.list");
  const project = projects.find((entry) => entry.projectId === projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  evidence.assertions.projectRoot = project.rootPath;
  evidence.assertions.workspaces = project.workspaces;
  step("projects.list", project);

  if (project.bound) {
    await call("shared-assets.unbind", { projectId, force: true });
    step("reset existing binding", { projectId });
  }

  const configured = await call("shared-assets.configure", {
    projectId,
    repoUrl: bare,
    branch: null,
    syncMode: "manual",
    trustConfirmed: true,
  });
  evidence.assertions.binding = configured.binding;
  evidence.assertions.checkout = checkout;
  evidence.assertions.checkoutExists = await exists(
    join(checkout, "team-assets.json"),
  );
  step("configure", configured);

  const initialStatus = await call("shared-assets.status", { projectId });
  evidence.assertions.initialStatus = initialStatus;
  step("status after configure", initialStatus);

  await writeFile(
    join(origin, "knowledge", "release.md"),
    `# Release\n\nNew remote knowledge added at ${new Date().toISOString()}.\n`,
  );
  git(origin, "add", ".");
  git(origin, "commit", "--quiet", "-m", "docs: add release knowledge");
  const branch = git(origin, "symbolic-ref", "--short", "HEAD");
  git(origin, "push", "--quiet", bare, `HEAD:${branch}`);
  const synced = await call("shared-assets.sync", { projectId });
  evidence.assertions.sync = {
    changed: synced.changed,
    localRevision: synced.binding.state.localRevision,
    remoteRevision: synced.binding.state.remoteRevision,
    releaseExists: await exists(join(checkout, "knowledge/release.md")),
  };
  step("sync after remote commit", evidence.assertions.sync);

  const assets = await call("shared-assets.assets.list", { projectId });
  evidence.assertions.assets = assets.map((asset) => ({
    assetId: asset.assetId,
    kind: asset.kind,
    name: asset.name,
    fileCount: asset.fileCount,
  }));
  step("assets.list", evidence.assertions.assets);

  const skillsBefore = await call("shared-assets.skills.list", {
    projectId,
    workspaceId,
  });
  evidence.assertions.skillsBefore = skillsBefore;
  await call("shared-assets.skills.set-enabled", {
    projectId,
    workspaceId,
    assetId: "skill:project/code-review",
    provider: "both",
    enabled: true,
  });
  evidence.assertions.skillFiles = {
    codex: await exists(join(demo, ".codex/skills/code-review/SKILL.md")),
    claude: await exists(join(demo, ".claude/skills/code-review/SKILL.md")),
    writingCodex: await exists(join(demo, ".codex/skills/writing/SKILL.md")),
  };
  if (evidence.assertions.skillFiles.writingCodex !== false) {
    throw new Error("skills/global must be ignored");
  }
  if (
    !evidence.assertions.assets.every(
      (asset) => !asset.assetId.includes("global"),
    )
  ) {
    throw new Error("assets.list must not include skills/global");
  }
  step("skills enabled", evidence.assertions.skillFiles);

  const instructions = await call("shared-assets.instructions.status", {
    projectId,
    workspaceId,
  });
  evidence.assertions.instructionsBefore = instructions;
  const enabledInstructions = await call(
    "shared-assets.instructions.set-enabled",
    {
      projectId,
      workspaceId,
      provider: "both",
      enabled: true,
    },
  );
  evidence.assertions.instructionsAfter = enabledInstructions;
  evidence.assertions.instructionFiles = {
    canonical: await readFile(join(demo, ".agentstorm/AGENTS.md"), "utf8"),
    codexLink: await exists(join(demo, "AGENTS.md")),
    claudeLink: await exists(join(demo, ".claude/CLAUDE.md")),
  };
  step("instructions enabled", enabledInstructions);

  const knowledge = await call("shared-assets.assets.read", {
    projectId,
    assetId: "knowledge/deploy.md",
  });
  evidence.assertions.knowledge = {
    kind: knowledge.kind,
    size: knowledge.size,
    startsWith: knowledge.content?.slice(0, 30),
  };
  step("read knowledge", evidence.assertions.knowledge);

  const doc = await call("shared-assets.assets.read", {
    projectId,
    assetId: "doc/design",
    path: "README.md",
  });
  const image = await call("shared-assets.assets.read", {
    projectId,
    assetId: "doc/design",
    path: "assets/flow.png",
  });
  evidence.assertions.doc = {
    kind: doc.kind,
    size: doc.size,
    imageKind: image.kind,
    imageMime: image.mimeType,
    imageDataUriPrefix: image.dataUri?.slice(0, 22),
  };
  step("read doc package", evidence.assertions.doc);

  const oldKnowledge = await readFile(
    join(checkout, "knowledge/deploy.md"),
    "utf8",
  );
  const newKnowledge = `${oldKnowledge.trimEnd()}\n4. Verify the rollback path.\n`;
  const preview = await call("shared-assets.publish.preview", {
    projectId,
    assetId: "knowledge/deploy.md",
    content: newKnowledge,
  });
  evidence.assertions.publishPreview = preview;
  const commit = await call("shared-assets.publish.commit", {
    projectId,
    assetId: "knowledge/deploy.md",
    content: newKnowledge,
    expectedRevision: preview.expectedRevision,
    message: "docs: document rollback",
  });
  evidence.assertions.publishCommit = commit;
  evidence.assertions.publishVerification = {
    subject: git(checkout, "log", "-1", "--pretty=%s"),
    files: git(checkout, "show", "--name-only", "--pretty=format:", "HEAD")
      .trim()
      .split("\n"),
    content: await readFile(join(checkout, "knowledge/deploy.md"), "utf8"),
  };
  step("publish knowledge", evidence.assertions.publishCommit);

  const finalStatus = await call("shared-assets.status", { projectId });
  evidence.assertions.finalStatus = finalStatus;
  const config = JSON.parse(
    await readFile(join(home, "plugin-data", pluginId, "config.json"), "utf8"),
  );
  evidence.assertions.persistedConfig = {
    path: join(home, "plugin-data", pluginId, "config.json"),
    binding: config.bindings[projectId],
    skillRecords: (config.skills[projectId] ?? []).length,
    instructionProviders: (config.instructions[projectId]?.providers ?? [])
      .length,
  };
  step("persisted config", evidence.assertions.persistedConfig);

  console.log(JSON.stringify(evidence, null, 2));
  await client.close();
}

await main().catch(async (error) => {
  console.error(error);
  await client.close().catch(() => {});
  process.exit(1);
});
