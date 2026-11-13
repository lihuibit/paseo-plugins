#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const root = fileURLToPath(new URL("..", import.meta.url));
const pluginPath = join(root, "plugins/task-board");
const home = process.env.E2E_MIGRATE_HOME ?? "/home/ubuntu/.paseo-i4-migrate";
const port = process.env.E2E_MIGRATE_PORT ?? "6769";
const reportPath = process.env.E2E_REPORT ?? null;
const pluginId = "agentstorm-task-board";
const report = { steps: [], assertions: {} };

function step(name, detail) {
  report.steps.push({ name, at: new Date().toISOString(), detail });
  console.error(`[i4-migrate] ${name}`);
}

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function waitFor(work, predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await work();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out; last=${JSON.stringify(last)}`);
}

async function main() {
  await rm(home, { recursive: true, force: true });
  await mkdir(join(home, "tasks"), { recursive: true });
  await writeFile(
    join(home, "config.json"),
    `${JSON.stringify(
      {
        version: 1,
        daemon: {
          listen: `127.0.0.1:${port}`,
          relay: { enabled: false },
        },
        pluginsEnabled: true,
        features: { webUi: { enabled: true } },
      },
      null,
      2,
    )}\n`,
  );
  execFileSync("paseo", ["daemon", "start", "--home", home], {
    stdio: "pipe",
  });
  await waitFor(
    async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
      } catch {
        return false;
      }
    },
    Boolean,
    30_000,
  );
  execFileSync("paseo", ["plugin", "install", pluginPath, "--home", home], {
    stdio: "pipe",
  });
  step("daemon started", { home, port });

  const legacy = {
    version: 1,
    nextNumber: 12,
    tasks: [
      {
        id: "btask_legacy_parent",
        displayId: "TASK-7",
        title: "Legacy recurring parent",
        description: "Imported from the previous task store.",
        status: "todo",
        labels: ["legacy"],
        trigger: {
          kind: "recurring",
          cadence: { type: "every", everyMs: 60000 },
          session: "new",
        },
        nextRunAt: "2026-11-13T07:00:00.000Z",
        revision: 4,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        activity: [{ at: "2026-10-01T00:00:00.000Z", kind: "created" }],
      },
      {
        id: "btask_legacy_child",
        displayId: "TASK-8",
        title: "Legacy permission child",
        status: "blocked",
        blockReason: "permission",
        blockDetail: "Legacy shell approval",
        pendingPermission: {
          requestId: "legacy_perm_1",
          kind: "permission",
          title: "Allow legacy shell",
          detail: "bash -lc 'make test'",
          at: "2026-10-02T00:00:00.000Z",
        },
        hierarchyParentId: "btask_legacy_parent",
        execution: {
          kind: "agent",
          project: {
            projectId: "prj_legacy",
            projectName: "legacy",
            projectRoot: "/tmp/legacy",
          },
          workspace: {
            workspaceId: "wks_legacy",
            workspaceName: "legacy",
            workspaceDirectory: "/tmp/legacy",
            created: false,
          },
          agentId: "agent_that_does_not_exist",
          provider: "codex",
          startedAt: "2026-10-02T00:00:00.000Z",
        },
        revision: 2,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        activity: [],
      },
      {
        id: "btask_legacy_done",
        displayId: "TASK-9",
        title: "Legacy done card",
        status: "done",
        revision: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        activity: [],
      },
      {
        id: "btask_legacy_unknown",
        displayId: "TASK-10",
        title: "Legacy unknown status",
        status: "mystery",
        revision: 0,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        activity: [],
      },
    ],
  };
  const sourcePath = join(home, "tasks", "tasks.json");
  const source = `${JSON.stringify(legacy, null, 2)}\n`;
  await writeFile(sourcePath, source);
  const sourceDigest = digest(source);
  report.assertions.source = { path: sourcePath, digest: sourceDigest };
  step("legacy source written", report.assertions.source);

  const password = (
    await readFile(join(home, "local-credential"), "utf8")
  ).trim();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    password,
    clientId: "task-board-i4-migrate",
    reconnect: { enabled: false },
  });
  async function call(method, input = {}) {
    const envelope = await client.invokePluginRpc(pluginId, method, input);
    if (!envelope || envelope.ok !== true) {
      throw new Error(`${method} failed: ${JSON.stringify(envelope)}`);
    }
    return envelope.value;
  }
  await client.connect();
  await waitFor(
    () =>
      call("task-board.health")
        .then(() => true)
        .catch(() => false),
    Boolean,
    30_000,
  );
  const before = await call("task-board.list", { includeFinished: true });
  report.assertions.before = { taskCount: before.tasks.length };

  const dry = await call("task-board.migrate-legacy", { dryRun: true });
  report.assertions.dryRun = dry;
  const afterDry = await call("task-board.list", { includeFinished: true });
  report.assertions.afterDryRun = { taskCount: afterDry.tasks.length };
  const drySource = await readFile(sourcePath, "utf8");
  report.assertions.afterDryRun.sourceUnchanged =
    digest(drySource) === sourceDigest;

  const applied = await call("task-board.migrate-legacy", { dryRun: false });
  report.assertions.applied = applied;
  const afterApply = await call("task-board.list", { includeFinished: true });
  report.assertions.afterApply = {
    taskCount: afterApply.tasks.length,
    tasks: afterApply.tasks.map((task) => ({
      displayId: task.displayId,
      title: task.title,
      status: task.status,
      trigger: task.trigger ?? null,
      nextRunAt: task.nextRunAt ?? null,
      hierarchyParentId: task.hierarchyParentId,
      pendingPermission: task.pendingPermission ?? null,
      execution: task.execution?.agentId ?? null,
    })),
  };
  const appliedSource = await readFile(sourcePath, "utf8");
  report.assertions.afterApply.sourceUnchanged =
    digest(appliedSource) === sourceDigest;

  const repeated = await call("task-board.migrate-legacy", { dryRun: false });
  report.assertions.repeated = repeated;
  const afterRepeat = await call("task-board.list", { includeFinished: true });
  report.assertions.afterRepeat = {
    taskCount: afterRepeat.tasks.length,
  };

  const reviewCard = await call("task-board.create", {
    title: "UI review card",
    acceptanceCriteria: ["Layout is readable", "No console errors"],
    labels: ["ui", "i4"],
  });
  const reviewed = await call("task-board.set-status", {
    taskId: reviewCard.task.id,
    expectedRevision: reviewCard.task.revision,
    status: "in_review",
  });
  const scheduled = await call("task-board.create", {
    title: "UI scheduled card",
    labels: ["ui", "i4"],
  });
  await call("task-board.schedule", {
    taskId: scheduled.task.id,
    expectedRevision: scheduled.task.revision,
    trigger: {
      kind: "recurring",
      cadence: { type: "every", everyMs: 300000 },
      session: "reuse",
    },
  });
  await call("task-board.settings.update", {
    patch: {
      wecom: {
        enabled: true,
        webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo",
        notifyOnProgress: true,
      },
    },
  });
  report.assertions.uiCards = {
    reviewTaskId: reviewed.task.id,
    scheduledTaskId: scheduled.task.id,
  };
  step("ui cards seeded", report.assertions.uiCards);

  const migrationRecord = await readFile(
    join(home, "plugin-data", pluginId, "migrations", "tasks.json"),
    "utf8",
  );
  report.assertions.migrationRecord = JSON.parse(migrationRecord);
  await client.close();

  const daemonLog = await readFile(join(home, "daemon.log"), "utf8").catch(
    () => "",
  );
  await writeFile(
    join(dirname(sourcePath), "..", "i4-daemon-log-snippet.txt"),
    daemonLog.split("\n").slice(-80).join("\n"),
  );

  console.log(JSON.stringify(report, null, 2));
  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
}

await main().catch((error) => {
  console.error(error);
  report.error = String(error);
  process.exit(1);
});
