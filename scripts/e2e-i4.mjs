#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";

const home = process.env.E2E_PASEO_HOME ?? "/home/ubuntu/.paseo-dev";
const port = process.env.E2E_PASEO_PORT ?? "6767";
const provider = process.env.E2E_PROVIDER ?? "codex";
const model = process.env.E2E_MODEL ?? "workbuddy/hy4flash-dev";
const pluginId = "paseo-task-board";
const reportPath = process.env.E2E_REPORT ?? null;
const password = (await readFile(`${home}/local-credential`, "utf8")).trim();

const report = { steps: [], assertions: {} };

function step(name, detail) {
  report.steps.push({ name, at: new Date().toISOString(), detail });
  console.error(`[i4] ${name}`);
}

function makeClient() {
  return new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    password,
    clientId: `task-board-i4-${Date.now()}`,
    reconnect: { enabled: false },
  });
}

let client = makeClient();
let paseo = createPaseoApi(client);

async function connect() {
  client = makeClient();
  paseo = createPaseoApi(client);
  await client.connect();
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

async function waitFor(work, predicate, timeoutMs, intervalMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await work();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out; last=${JSON.stringify(last)}`);
}

async function taskById(taskId) {
  return (await call("task-board.get", { taskId })).task;
}

async function waitStatus(taskId, statuses, timeoutMs = 120_000) {
  return waitFor(
    () => taskById(taskId),
    (task) => task && statuses.includes(task.status),
    timeoutMs,
  );
}

async function deleteTask(taskId) {
  const task = await taskById(taskId);
  await raw("task-board.delete", {
    taskId,
    expectedRevision: task.revision,
  }).catch(() => undefined);
}

async function cleanup(taskIds) {
  for (const taskId of [...taskIds].reverse()) {
    await deleteTask(taskId).catch((error) => {
      step("cleanup failed", { taskId, error: String(error) });
    });
  }
}

async function main() {
  await connect();
  const health = await call("task-board.health");
  report.assertions.health = health;
  step("connected", { health });

  const candidates = await call("task-board.candidates");
  const project = candidates.projects.find(
    (entry) => entry.workspaces.length > 0,
  );
  if (!project) throw new Error("No project with a workspace");
  const workspace = project.workspaces[0];
  report.assertions.project = {
    projectId: project.projectId,
    workspaceId: workspace.workspaceId,
  };
  step("candidates", report.assertions.project);

  const createdIds = [];
  const host = await call("task-board.create", {
    title: `I4 agent host ${new Date().toISOString()}`,
    labels: ["i4"],
  });
  createdIds.push(host.task.id);
  await call("task-board.assign", {
    taskId: host.task.id,
    expectedRevision: host.task.revision,
    projectId: project.projectId,
    workspaceId: workspace.workspaceId,
    agent: { kind: "create", provider, model, modeId: "full-access" },
    message: "Only reply DONE. Do not modify any files.",
    start: true,
  });
  const hostReady = await waitStatus(
    host.task.id,
    ["in_review", "blocked"],
    180_000,
  );
  const workhorseAgentId = hostReady.execution?.agentId;
  if (!workhorseAgentId) throw new Error("Host agent was not created");
  report.assertions.workhorse = {
    taskId: host.task.id,
    agentId: workhorseAgentId,
    status: hostReady.status,
  };
  step("workhorse agent ready", report.assertions.workhorse);

  const scheduled = await call("task-board.create", {
    title: "I4 scheduled one-shot",
    labels: ["i4", "scheduled"],
  });
  createdIds.push(scheduled.task.id);
  await call("task-board.assign", {
    taskId: scheduled.task.id,
    expectedRevision: scheduled.task.revision,
    projectId: project.projectId,
    workspaceId: workspace.workspaceId,
    agent: { kind: "existing", agentId: workhorseAgentId },
    message: "Only reply SCHEDULED. Do not modify any files.",
    start: false,
  });
  const scheduledNow = await taskById(scheduled.task.id);
  const runAt = new Date(Date.now() + 12_000).toISOString();
  await call("task-board.schedule", {
    taskId: scheduled.task.id,
    expectedRevision: scheduledNow.revision,
    trigger: { kind: "scheduled", runAt },
  });
  step("scheduled card parked", { taskId: scheduled.task.id, runAt });

  execFileSync("paseo", ["daemon", "restart", "--home", home], {
    stdio: "pipe",
  });
  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        return response.ok;
      } catch {
        return false;
      }
    },
    Boolean,
    30_000,
    500,
  );
  await connect();
  await call("task-board.health");
  const fired = await waitStatus(
    scheduled.task.id,
    ["in_progress", "in_review", "blocked"],
    60_000,
  );
  report.assertions.scheduledRestart = {
    status: fired.status,
    runCount: fired.runCount,
    nextRunAt: fired.nextRunAt,
    agentId: fired.execution?.agentId,
  };
  step(
    "scheduled fired after daemon restart",
    report.assertions.scheduledRestart,
  );
  if (fired.runCount !== 1 || fired.nextRunAt !== null) {
    throw new Error(
      `scheduled run did not fire exactly once: ${JSON.stringify(fired)}`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const stillOnce = await taskById(scheduled.task.id);
  report.assertions.scheduledNoRepeat = {
    runCount: stillOnce.runCount,
    nextRunAt: stillOnce.nextRunAt,
  };
  if (stillOnce.runCount !== 1) {
    throw new Error("scheduled card ran more than once");
  }

  const recurring = await call("task-board.create", {
    title: "I4 recurring parent",
    labels: ["i4", "recurring"],
  });
  createdIds.push(recurring.task.id);
  await call("task-board.assign", {
    taskId: recurring.task.id,
    expectedRevision: recurring.task.revision,
    projectId: project.projectId,
    workspaceId: workspace.workspaceId,
    agent: { kind: "create", provider, model, modeId: "full-access" },
    message:
      "Run the shell command sleep 90, then reply DONE. Do not modify files.",
    start: false,
  });
  const recurringAssigned = await taskById(recurring.task.id);
  await call("task-board.schedule", {
    taskId: recurring.task.id,
    expectedRevision: recurringAssigned.revision,
    trigger: {
      kind: "recurring",
      cadence: { type: "every", everyMs: 15_000 },
      session: "new",
    },
  });
  const spawned = await waitFor(
    async () => {
      const document = await call("task-board.list", {
        includeFinished: true,
      });
      const parent = document.tasks.find(
        (entry) => entry.id === recurring.task.id,
      );
      const child = document.tasks.find(
        (entry) => entry.parentTaskId === recurring.task.id,
      );
      return { parent, child };
    },
    (value) => Boolean(value.parent && value.child),
    90_000,
  );
  report.assertions.recurringSpawn = {
    parentDerivedCount: spawned.parent.derivedCount,
    parentNextRunAt: spawned.parent.nextRunAt,
    childId: spawned.child.id,
    childStatus: spawned.child.status,
  };
  createdIds.push(spawned.child.id);
  step("recurring child spawned", report.assertions.recurringSpawn);
  await new Promise((resolve) => setTimeout(resolve, 20_000));
  const afterSkip = await taskById(recurring.task.id);
  const childrenAfter = (
    await call("task-board.list", { includeFinished: true })
  ).tasks.filter((entry) => entry.parentTaskId === recurring.task.id);
  report.assertions.recurringSkip = {
    derivedCount: afterSkip.derivedCount,
    nextRunAt: afterSkip.nextRunAt,
    childCount: childrenAfter.length,
    childStatus: childrenAfter[0]?.status,
  };
  step("recurring skipped while child active", report.assertions.recurringSkip);
  if (afterSkip.derivedCount !== 1 || childrenAfter.length !== 1) {
    throw new Error(
      "recurring spawned a second child while the first was active",
    );
  }

  const permission = await call("task-board.create", {
    title: "I4 permission probe",
    labels: ["i4", "permission"],
  });
  createdIds.push(permission.task.id);
  await call("task-board.assign", {
    taskId: permission.task.id,
    expectedRevision: permission.task.revision,
    projectId: project.projectId,
    workspaceId: workspace.workspaceId,
    agent: { kind: "create", provider, model, modeId: "auto" },
    message:
      "Do not modify files. Run exactly this shell command and nothing else: " +
      "curl -sS -m 5 https://example.com . Then reply DONE.",
    start: true,
  });
  let permissionResult;
  try {
    const blocked = await waitFor(
      () => taskById(permission.task.id),
      (task) =>
        task.status === "blocked" &&
        (task.blockReason === "permission" ||
          task.blockReason === "question") &&
        task.pendingPermission,
      120_000,
    );
    const requestId = blocked.pendingPermission.requestId;
    const handle = paseo.agents.ref(blocked.execution.agentId);
    await handle.respondToPermission({
      requestId,
      response: { behavior: "allow" },
    });
    const resumed = await waitFor(
      () => taskById(permission.task.id),
      (task) =>
        task.status !== "blocked" ||
        task.blockReason === "agent_error" ||
        task.blockReason === "agent_silent",
      60_000,
    );
    permissionResult = {
      requested: true,
      requestId,
      requestedKind: blocked.blockReason,
      detail: blocked.blockDetail,
      resumedStatus: resumed.status,
      resumedReason: resumed.blockReason ?? null,
    };
  } catch (error) {
    permissionResult = {
      requested: false,
      reason: String(error),
      final: await taskById(permission.task.id).catch(() => null),
    };
  }
  report.assertions.permission = permissionResult;
  step("permission probe", permissionResult);

  const wecomRequests = [];
  let wecomMode = "ok";
  const wecomServer = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = (() => {
        try {
          return JSON.parse(body);
        } catch {
          return null;
        }
      })();
      wecomRequests.push({
        at: new Date().toISOString(),
        path: request.url,
        body: parsed,
      });
      if (wecomMode === "ok") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
      } else {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("mock failure");
      }
    });
  });
  await new Promise((resolve) =>
    wecomServer.listen(16789, "127.0.0.1", resolve),
  );
  const wecomUrl = "http://127.0.0.1:16789/wecom";
  await call("task-board.settings.update", {
    patch: {
      wecom: {
        enabled: true,
        webhookUrl: wecomUrl,
        minIntervalMs: 0,
        retries: 2,
        notifyOnReview: true,
        notifyOnBlocked: true,
        notifyOnScheduled: true,
      },
    },
  });
  const tested = await call("task-board.notifications.test");
  const reviewCard = await call("task-board.create", {
    title: "I4 WeCom review",
    labels: ["i4", "wecom"],
  });
  createdIds.push(reviewCard.task.id);
  await call("task-board.set-status", {
    taskId: reviewCard.task.id,
    expectedRevision: reviewCard.task.revision,
    status: "in_review",
  });
  await waitFor(
    () => Promise.resolve(wecomRequests.length),
    (count) => count >= 2,
    20_000,
    300,
  );
  const blockedCard = await call("task-board.create", {
    title: "I4 WeCom blocked",
    labels: ["i4", "wecom"],
  });
  createdIds.push(blockedCard.task.id);
  await call("task-board.set-status", {
    taskId: blockedCard.task.id,
    expectedRevision: blockedCard.task.revision,
    status: "blocked",
  });
  await waitFor(
    () => Promise.resolve(wecomRequests.length),
    (count) => count >= 3,
    20_000,
    300,
  );
  wecomMode = "fail";
  const failingCard = await call("task-board.create", {
    title: "I4 WeCom retry",
    labels: ["i4", "wecom"],
  });
  createdIds.push(failingCard.task.id);
  await call("task-board.set-status", {
    taskId: failingCard.task.id,
    expectedRevision: failingCard.task.revision,
    status: "blocked",
  });
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const notificationLog = (
    await readFile(
      `${home}/plugin-data/paseo-task-board/notifications.jsonl`,
      "utf8",
    ).catch(() => "")
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  report.assertions.wecom = {
    test: tested,
    requests: wecomRequests.map((entry) => ({
      at: entry.at,
      msgtype: entry.body?.msgtype,
      content: entry.body?.markdown?.content,
    })),
    records: notificationLog.slice(-4),
  };
  step("wecom notifications", {
    testOk: tested.ok,
    requests: wecomRequests.length,
    retries: notificationLog.filter((entry) => !entry.ok).length,
  });
  await new Promise((resolve) => wecomServer.close(resolve));
  await call("task-board.settings.update", {
    patch: { wecom: { enabled: false } },
  });

  const hierarchyParent = await call("task-board.create", {
    title: "I4 hierarchy parent",
    labels: ["i4", "hierarchy"],
  });
  createdIds.push(hierarchyParent.task.id);
  const hierarchyChild = await call("task-board.create", {
    title: "I4 hierarchy child",
    labels: ["i4", "hierarchy"],
  });
  createdIds.push(hierarchyChild.task.id);
  await call("task-board.set-hierarchy", {
    taskId: hierarchyChild.task.id,
    expectedRevision: hierarchyChild.task.revision,
    parentId: hierarchyParent.task.id,
  });
  const childCurrent = await taskById(hierarchyChild.task.id);
  await call("task-board.set-status", {
    taskId: hierarchyChild.task.id,
    expectedRevision: childCurrent.revision,
    status: "done",
  });
  const tree = await call("task-board.hierarchy", {
    taskId: hierarchyParent.task.id,
  });
  const parentAfterChildDone = await taskById(hierarchyParent.task.id);
  report.assertions.hierarchy = {
    parentStatus: parentAfterChildDone.status,
    summary: tree.summary,
    children: tree.children.map((entry) => ({
      displayId: entry.displayId,
      status: entry.status,
    })),
  };
  step("hierarchy summary", report.assertions.hierarchy);
  if (parentAfterChildDone.status !== "planning") {
    throw new Error("parent status was auto-advanced by a child");
  }
  await call("task-board.delete", {
    taskId: hierarchyParent.task.id,
    expectedRevision: (await taskById(hierarchyParent.task.id)).revision,
  });
  const parentIndex = createdIds.indexOf(hierarchyParent.task.id);
  if (parentIndex >= 0) createdIds.splice(parentIndex, 1);
  const orphan = await taskById(hierarchyChild.task.id);
  report.assertions.deleteDetachesChild = {
    hierarchyParentId: orphan.hierarchyParentId,
  };
  step("delete detaches child", report.assertions.deleteDetachesChild);
  if (orphan.hierarchyParentId !== null) {
    throw new Error("child was not detached after parent delete");
  }

  const unassignCard = await call("task-board.create", {
    title: "I4 unassign",
    labels: ["i4", "unassign"],
  });
  createdIds.push(unassignCard.task.id);
  await call("task-board.assign", {
    taskId: unassignCard.task.id,
    expectedRevision: unassignCard.task.revision,
    projectId: project.projectId,
    workspaceId: workspace.workspaceId,
    agent: { kind: "existing", agentId: workhorseAgentId },
    start: false,
  });
  const assigned = await taskById(unassignCard.task.id);
  await call("task-board.schedule", {
    taskId: unassignCard.task.id,
    expectedRevision: assigned.revision,
    trigger: {
      kind: "recurring",
      cadence: { type: "every", everyMs: 60_000 },
      session: "new",
    },
  });
  const scheduledUnassign = await taskById(unassignCard.task.id);
  const unassigned = await call("task-board.unassign", {
    taskId: unassignCard.task.id,
    expectedRevision: scheduledUnassign.revision,
  });
  report.assertions.unassign = {
    status: unassigned.task.status,
    assignment: unassigned.task.assignment ?? null,
    trigger: unassigned.task.trigger ?? null,
    nextRunAt: unassigned.task.nextRunAt ?? null,
  };
  step("unassign", report.assertions.unassign);

  const cancelCard = await call("task-board.create", {
    title: "I4 cancel",
    labels: ["i4", "cancel"],
  });
  createdIds.push(cancelCard.task.id);
  const cancelled = await call("task-board.cancel", {
    taskId: cancelCard.task.id,
    expectedRevision: cancelCard.task.revision,
  });
  report.assertions.cancel = {
    status: cancelled.task.status,
    executionArchive: cancelled.task.executionArchive,
  };
  step("cancel", report.assertions.cancel);

  const finalList = await call("task-board.list", { includeFinished: true });
  report.assertions.finalTasks = finalList.tasks.map((entry) => ({
    id: entry.id,
    displayId: entry.displayId,
    title: entry.title,
    status: entry.status,
    blockReason: entry.blockReason ?? null,
    pendingPermission: entry.pendingPermission ?? null,
    nextRunAt: entry.nextRunAt ?? null,
    derivedCount: entry.derivedCount,
  }));

  await cleanup(createdIds);
  report.assertions.postCleanupTasks = (
    await call("task-board.list", { includeFinished: true })
  ).tasks.map((entry) => ({
    displayId: entry.displayId,
    title: entry.title,
    status: entry.status,
  }));
  await client.close();
  console.log(JSON.stringify(report, null, 2));
  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
}

await main().catch(async (error) => {
  console.error(error);
  report.error = String(error);
  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`).catch(
      () => undefined,
    );
  }
  await client.close().catch(() => undefined);
  process.exit(1);
});
