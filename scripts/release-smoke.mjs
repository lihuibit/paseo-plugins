#!/usr/bin/env node
import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const home =
  process.env.PASEO_RELEASE_HOME ?? join(homedir(), ".paseo-plugin-test");
const port = process.env.PASEO_RELEASE_PORT ?? "6769";
const projectId = process.env.PASEO_RELEASE_PROJECT_ID;
const workspaceId = process.env.PASEO_RELEASE_WORKSPACE_ID;
const teamRepo = process.env.PASEO_RELEASE_TEAM_REPO;
const action = process.env.PASEO_SMOKE_ACTION ?? "verify";
const statePath =
  process.env.PASEO_SMOKE_STATE ?? join(home, "release-smoke-state.json");

const password = (
  await readFile(join(home, "local-credential"), "utf8")
).trim();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  password,
  clientId: `release-smoke-${process.pid}`,
  reconnect: { enabled: false },
});

async function call(pluginId, method, input = {}) {
  const envelope = await client.invokePluginRpc(pluginId, method, input);
  if (!envelope || typeof envelope !== "object" || envelope.ok !== true) {
    throw new Error(
      `${pluginId}.${method} failed: ${JSON.stringify(envelope)}`,
    );
  }
  return envelope.value;
}

async function exists(path) {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

function requireEnv(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function seed() {
  requireEnv("PASEO_RELEASE_PROJECT_ID", projectId);
  requireEnv("PASEO_RELEASE_WORKSPACE_ID", workspaceId);
  requireEnv("PASEO_RELEASE_TEAM_REPO", teamRepo);

  const projects = await call(
    "paseo-shared-assets",
    "shared-assets.projects.list",
  );
  const project = projects.find((entry) => entry.projectId === projectId);
  if (!project)
    throw new Error(`Project not found in clean home: ${projectId}`);
  if (project.bound) {
    await call("paseo-shared-assets", "shared-assets.unbind", {
      projectId,
      force: true,
    });
  }

  await call("paseo-shared-assets", "shared-assets.configure", {
    projectId,
    repoUrl: teamRepo,
    branch: null,
    syncMode: "manual",
    trustConfirmed: true,
  });
  const status = await call("paseo-shared-assets", "shared-assets.status", {
    projectId,
  });
  const assets = await call(
    "paseo-shared-assets",
    "shared-assets.assets.list",
    {
      projectId,
    },
  );

  for (const assetId of ["skill:project/code-review"]) {
    await call("paseo-shared-assets", "shared-assets.skills.set-enabled", {
      projectId,
      workspaceId,
      assetId,
      provider: "both",
      enabled: true,
    });
  }
  await call("paseo-shared-assets", "shared-assets.instructions.set-enabled", {
    projectId,
    workspaceId,
    provider: "both",
    enabled: true,
  });
  const skills = await call(
    "paseo-shared-assets",
    "shared-assets.skills.list",
    {
      projectId,
      workspaceId,
    },
  );
  const instructions = await call(
    "paseo-shared-assets",
    "shared-assets.instructions.status",
    { projectId, workspaceId },
  );

  const created = await call("paseo-task-board", "task-board.create", {
    title: `I5 release smoke ${new Date().toISOString()}`,
    description:
      "Created by scripts/release-smoke.mjs; survives upgrade and restart.",
    labels: ["i5-release"],
    projectId,
  });
  const scheduledRunAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const scheduled = await call("paseo-task-board", "task-board.create", {
    title: `I5 scheduled probe ${scheduledRunAt}`,
    description: "Scheduled trigger must survive upgrade and daemon restart.",
    labels: ["i5-release", "i5-scheduled"],
    projectId,
    trigger: { kind: "scheduled", runAt: scheduledRunAt },
  });
  const recurring = await call("paseo-task-board", "task-board.create", {
    title: "I5 recurring probe",
    description: "Recurring trigger must survive upgrade and daemon restart.",
    labels: ["i5-release", "i5-recurring"],
    projectId,
    trigger: {
      kind: "recurring",
      cadence: { type: "every", everyMs: 3_600_000 },
    },
  });
  const health = await call("paseo-task-board", "task-board.health", {});

  const projections = [];
  for (const projection of skills.projections) {
    projections.push({
      assetId: projection.assetId,
      provider: projection.provider,
      targetPath: projection.targetPath,
      exists: await exists(projection.targetPath),
    });
  }
  const instructionTargets = [];
  for (const target of instructions.targets) {
    instructionTargets.push({
      provider: target.provider,
      targetPath: target.targetPath,
      exists: await exists(target.targetPath),
    });
  }

  const state = {
    createdAt: new Date().toISOString(),
    projectId,
    workspaceId,
    teamRepo,
    cardId: created.task.id,
    cardStatus: created.task.status,
    cardRevision: created.task.revision,
    scheduledCardId: scheduled.task.id,
    scheduledRunAt,
    recurringCardId: recurring.task.id,
    recurringEveryMs: 3_600_000,
    bindingLocalRevision: status.binding.state.localRevision,
    assetIds: assets.map((asset) => asset.assetId),
    projections,
    instructionTargets,
    boardHealth: health,
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { action: "seed", state, statePath };
}

async function verify() {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const status = await call("paseo-shared-assets", "shared-assets.status", {
    projectId: state.projectId,
  });
  const assets = await call(
    "paseo-shared-assets",
    "shared-assets.assets.list",
    {
      projectId: state.projectId,
    },
  );
  const skills = await call(
    "paseo-shared-assets",
    "shared-assets.skills.list",
    {
      projectId: state.projectId,
      workspaceId: state.workspaceId,
    },
  );
  const instructions = await call(
    "paseo-shared-assets",
    "shared-assets.instructions.status",
    { projectId: state.projectId, workspaceId: state.workspaceId },
  );
  const card = await call("paseo-task-board", "task-board.get", {
    taskId: state.cardId,
  });
  const scheduled = await call("paseo-task-board", "task-board.get", {
    taskId: state.scheduledCardId,
  });
  const recurring = await call("paseo-task-board", "task-board.get", {
    taskId: state.recurringCardId,
  });
  const health = await call("paseo-task-board", "task-board.health", {});

  const projections = [];
  for (const projection of skills.projections) {
    projections.push({
      assetId: projection.assetId,
      provider: projection.provider,
      targetPath: projection.targetPath,
      exists: await exists(projection.targetPath),
    });
  }
  const instructionTargets = [];
  for (const target of instructions.targets) {
    instructionTargets.push({
      provider: target.provider,
      targetPath: target.targetPath,
      exists: await exists(target.targetPath),
    });
  }

  const missingAssets = state.assetIds.filter(
    (assetId) =>
      !assetId.startsWith("skill:global/") &&
      !assets.some((asset) => asset.assetId === assetId),
  );
  const removedGlobalSkills = state.assetIds.filter(
    (assetId) =>
      assetId.startsWith("skill:global/") &&
      !assets.some((asset) => asset.assetId === assetId),
  );
  const missingProjections = projections.filter(
    (projection) => !projection.exists,
  );
  const result = {
    action: "verify",
    ok:
      status.binding.state.localRevision === state.bindingLocalRevision &&
      card.task.id === state.cardId &&
      card.task.revision >= state.cardRevision &&
      scheduled.task.trigger?.kind === "scheduled" &&
      scheduled.task.trigger.runAt === state.scheduledRunAt &&
      recurring.task.trigger?.kind === "recurring" &&
      recurring.task.trigger.cadence?.type === "every" &&
      recurring.task.trigger.cadence.everyMs === state.recurringEveryMs &&
      missingAssets.length === 0 &&
      missingProjections.length === 0,
    binding: {
      bound: status.binding.projectId === state.projectId,
      localRevision: status.binding.state.localRevision,
      expectedLocalRevision: state.bindingLocalRevision,
    },
    card: {
      id: card.task.id,
      status: card.task.status,
      revision: card.task.revision,
      expectedRevision: state.cardRevision,
      title: card.task.title,
    },
    scheduled: {
      id: scheduled.task.id,
      trigger: scheduled.task.trigger,
      expectedRunAt: state.scheduledRunAt,
    },
    recurring: {
      id: recurring.task.id,
      trigger: recurring.task.trigger,
      expectedEveryMs: state.recurringEveryMs,
    },
    assets: {
      count: assets.length,
      missing: missingAssets,
      removedGlobalSkills,
    },
    projections,
    missingProjections,
    instructionTargets,
    boardHealth: health,
  };
  if (!result.ok)
    throw new Error(`Smoke verification failed: ${JSON.stringify(result)}`);
  return result;
}

await client.connect();
try {
  const result = action === "seed" ? await seed() : await verify();
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
}
