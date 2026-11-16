#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const home = process.env.E2E_PASEO_HOME ?? "/home/ubuntu/.paseo-dev";
const port = process.env.E2E_PASEO_PORT ?? "6767";
const projectId = process.env.E2E_PROJECT_ID ?? "prj_573bd023500d0137";
const workspaceId = process.env.E2E_WORKSPACE_ID ?? "wks_67a40b3951690da8";
const provider = process.env.E2E_PROVIDER ?? "codex";
const model = process.env.E2E_MODEL ?? "workbuddy/hy4flash-dev";
const modeId = process.env.E2E_MODE ?? "full-access";
const pluginId = "paseo-task-board";
const reportPath = process.env.E2E_REPORT ?? null;

const password = (await readFile(`${home}/local-credential`, "utf8")).trim();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  password,
  clientId: "task-board-e2e",
  reconnect: { enabled: false },
});

const report = { steps: [], assertions: {} };

function step(name, detail) {
  report.steps.push({ name, at: new Date().toISOString(), detail });
}

async function call(method, input = {}) {
  const envelope = await client.invokePluginRpc(pluginId, method, input);
  if (!envelope || typeof envelope !== "object" || envelope.ok !== true) {
    throw new Error(`${method} failed: ${JSON.stringify(envelope)}`);
  }
  return envelope.value;
}

async function raw(method, input = {}) {
  return client.invokePluginRpc(pluginId, method, input);
}

async function waitForStatus(taskId, wanted, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { tasks } = await call("task-board.list", { includeFinished: true });
    last = tasks.find((task) => task.id === taskId) ?? null;
    if (last && wanted.includes(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(
    `task ${taskId} did not reach ${wanted.join("/")}: ${JSON.stringify(last)}`,
  );
}

async function main() {
  await client.connect();
  step("connect", { home, port });

  const health = await call("task-board.health");
  report.assertions.health = health;
  if (!health.toolInjectionEnabled) {
    throw new Error(
      "daemon.mcp.injectIntoAgents is false; board_declare cannot be injected",
    );
  }

  const created = await call("task-board.create", {
    title: `E2E board demo ${new Date().toISOString()}`,
    description: "Created by scripts/e2e-task-board.mjs",
    acceptanceCriteria: ["Card reaches in_review", "Revision increases"],
    priority: "medium",
    labels: ["e2e", "task-board"],
  });
  const task = created.task;
  report.assertions.created = {
    id: task.id,
    displayId: task.displayId,
    revision: task.revision,
  };
  step("created", report.assertions.created);

  const assigned = await call("task-board.assign", {
    taskId: task.id,
    expectedRevision: task.revision,
    projectId,
    workspaceId,
    agent: {
      kind: "create",
      provider,
      model,
      modeId,
    },
    message:
      'Do not modify any files. Call board_declare with kind="review" and ' +
      'summary="E2E review ready". Then reply exactly DONE.',
    start: true,
  });
  report.assertions.assignment = {
    status: assigned.task.status,
    revision: assigned.task.revision,
    agentId: assigned.task.execution?.agentId,
    labels: {
      "paseo.board": "1",
      "paseo.task-id": task.id,
      "paseo.kind": "task",
    },
    background: false,
  };
  step("assigned and started", report.assertions.assignment);

  const reviewed = await waitForStatus(task.id, ["in_review", "blocked"]);
  report.assertions.review = {
    status: reviewed.status,
    revision: reviewed.revision,
    declaration: reviewed.declaration,
    lifecycle: reviewed.execution?.lastLifecycle,
    runCount: reviewed.runCount,
  };
  step("agent declared review", report.assertions.review);
  if (reviewed.status !== "in_review") {
    throw new Error(`expected in_review, got ${reviewed.status}`);
  }

  const conflict = await raw("task-board.update", {
    taskId: task.id,
    expectedRevision: task.revision,
    patch: { title: "stale" },
  });
  report.assertions.revisionConflict = conflict;
  if (conflict.ok !== false || conflict.error?.code !== "E_REVISION_CONFLICT") {
    throw new Error(
      `expected E_REVISION_CONFLICT, got ${JSON.stringify(conflict)}`,
    );
  }

  const restarted = (
    await call("task-board.start", {
      taskId: task.id,
      message:
        "Run this shell command and wait: sleep 120. Then reply DONE. " +
        "Do not call board_declare.",
    })
  ).task;
  report.assertions.restart = {
    status: restarted.status,
    runCount: restarted.runCount,
  };
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const stopped = (await call("task-board.stop", { taskId: task.id })).task;
  report.assertions.stop = {
    status: stopped.status,
    blockReason: stopped.blockReason,
    blockDetail: stopped.blockDetail,
    pendingStopAt: stopped.pendingStopAt,
  };
  if (stopped.status !== "blocked" || stopped.blockReason !== "manual") {
    throw new Error(
      `stop did not produce blocked(manual): ${JSON.stringify(stopped)}`,
    );
  }
  step("stopped", report.assertions.stop);

  const finalList = await call("task-board.list", { includeFinished: true });
  report.assertions.finalStatus = finalList.tasks.find(
    (entry) => entry.id === task.id,
  )?.status;
  report.assertions.taskId = task.id;
  console.log(JSON.stringify(report, null, 2));
  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  await client.close();
}

await main().catch(async (error) => {
  console.error(error);
  await client.close().catch(() => {});
  process.exit(1);
});
