#!/usr/bin/env node
// Verifies that done / cancelled / delete archive the bound Paseo agent.
//
// Usage:
//   E2E_PASEO_HOME=~/.paseo-plugin-test E2E_PASEO_PORT=6769 \
//   E2E_REPORT=<evidence-dir>/I9/archive-report.json \
//     node scripts/e2e-i9-archive.mjs
import { readFile, writeFile } from "node:fs/promises";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const home = process.env.E2E_PASEO_HOME ?? "/home/ubuntu/.paseo-plugin-test";
const port = process.env.E2E_PASEO_PORT ?? "6769";
const provider = process.env.E2E_PROVIDER ?? "codex";
const model = process.env.E2E_MODEL ?? "workbuddy/hy4flash-dev";
const modeId = process.env.E2E_MODE ?? "full-access";
const pluginId = "paseo-task-board";
const reportPath = process.env.E2E_REPORT ?? null;

const password = (await readFile(`${home}/local-credential`, "utf8")).trim();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  password,
  clientId: "task-board-i9-archive",
  reconnect: { enabled: false },
});

const report = { home, port, cases: [], assertions: {} };

async function call(method, input = {}) {
  const envelope = await client.invokePluginRpc(pluginId, method, input);
  if (!envelope || envelope.ok !== true) {
    throw new Error(`${method} failed: ${JSON.stringify(envelope)}`);
  }
  return envelope.value;
}

async function agentEntry(agentId) {
  const page = await client.fetchAgents({
    includeBackground: true,
    filter: { includeArchived: true, includeBackground: true },
  });
  const entry = page.entries.find(
    (candidate) => candidate.agent.id === agentId,
  );
  return entry?.agent ?? null;
}

async function seedTask(title) {
  const { task } = await call("task-board.create", {
    title,
    description: "Created by scripts/e2e-i9-archive.mjs",
  });
  return task;
}

async function assignAndStart(task, workspace, agent) {
  const assigned = await call("task-board.assign", {
    taskId: task.id,
    expectedRevision: task.revision,
    projectId: workspace.projectId,
    workspaceId: workspace.workspaceId,
    agent,
    message:
      "Do not modify any files. Reply exactly DONE and then stop. " +
      "Do not call board_declare.",
    start: true,
  });
  const agentId = assigned.task.execution?.agentId;
  if (!agentId) throw new Error("assign did not create an execution");
  return { task: assigned.task, agentId };
}

async function startWithFallback(task, workspace) {
  try {
    return await assignAndStart(task, workspace, {
      kind: "create",
      provider,
      model,
      modeId,
    });
  } catch (error) {
    report.assertions.createFallback = String(error);
    const idle = workspace.agents.find((agent) => agent.status === "idle");
    if (!idle) throw error;
    return await assignAndStart(task, workspace, {
      kind: "existing",
      agentId: idle.agentId,
    });
  }
}

async function runCase(name, action) {
  const task = await seedTask(`I9 archive ${name} ${Date.now()}`);
  const started = await startWithFallback(task, report.workspace);
  const before = await agentEntry(started.agentId);
  const current = await call("task-board.get", { taskId: task.id });
  let result;
  if (action === "done") {
    result = await call("task-board.set-status", {
      taskId: task.id,
      expectedRevision: current.task.revision,
      status: "done",
    });
  } else if (action === "cancelled") {
    result = await call("task-board.cancel", {
      taskId: task.id,
      expectedRevision: current.task.revision,
    });
  } else {
    result = await call("task-board.delete", {
      taskId: task.id,
      expectedRevision: current.task.revision,
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const after = await agentEntry(started.agentId);
  const taskAfter =
    action === "delete"
      ? await client
          .invokePluginRpc(pluginId, "task-board.get", { taskId: task.id })
          .then((envelope) => (envelope.ok ? envelope.value.task : envelope))
      : (await call("task-board.get", { taskId: task.id })).task;
  const index = JSON.parse(
    await readFile(
      `${home}/plugin-data/${pluginId}/agentIndex.json`,
      "utf8",
    ).catch(() => "{}"),
  );
  const entry = {
    name,
    action,
    taskId: task.id,
    displayId: task.displayId,
    agentId: started.agentId,
    statusBefore: before?.status ?? null,
    archivedAtBefore: before?.archivedAt ?? null,
    statusAfter: after?.status ?? null,
    archivedAtAfter: after?.archivedAt ?? null,
    taskStatusAfter: action === "delete" ? null : (taskAfter?.status ?? null),
    taskExecutionKept:
      action === "delete" ? null : Boolean(taskAfter?.execution?.agentId),
    indexBoundAfter: Object.prototype.hasOwnProperty.call(
      index,
      started.agentId,
    ),
    result: action === "delete" ? result : undefined,
  };
  report.cases.push(entry);
  if (!entry.archivedAtAfter) {
    throw new Error(`${name}: agent was not archived`);
  }
  if (entry.indexBoundAfter) {
    throw new Error(`${name}: agentIndex still binds the agent`);
  }
  if (action !== "delete" && !entry.taskExecutionKept) {
    throw new Error(`${name}: card lost its execution history`);
  }
  return entry;
}

async function main() {
  await client.connect();
  const candidates = await call("task-board.candidates", {});
  const project = candidates.projects[0];
  if (!project) throw new Error("no project candidate");
  const workspace = {
    projectId: project.projectId,
    workspaceId: project.workspaces[0]?.workspaceId,
    agents: project.agents,
  };
  if (!workspace.workspaceId) throw new Error("no workspace candidate");
  report.workspace = workspace;
  report.health = await call("task-board.health");

  await runCase("done", "done");
  await runCase("cancelled", "cancelled");
  await runCase("delete", "delete");

  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  await client.close();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await client.close();
  } catch {
    // ignore
  }
  process.exitCode = 1;
});
