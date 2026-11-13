#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";

const home =
  process.env.E2E_PASEO_HOME ?? join(homedir(), ".paseo-plugin-test");
const port = process.env.E2E_PASEO_PORT ?? "6769";
const provider = process.env.E2E_PROVIDER ?? "codex";
const model = process.env.E2E_MODEL ?? "workbuddy/hy4flash-dev";
const modeId = process.env.E2E_MODE ?? "full-access";
const thinking = process.env.E2E_THINKING ?? "high";
const reportPath = process.env.E2E_REPORT ?? null;
const pluginId = "agentstorm-task-board";

const password = (
  await readFile(join(home, "local-credential"), "utf8")
).trim();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  password,
  clientId: `planning-smoke-${process.pid}`,
  reconnect: { enabled: false },
});
const paseo = createPaseoApi(client);
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

async function waitFor(work, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await work();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function inspectAgent(agentId) {
  const agentsRoot = join(home, "agents");
  const directories = await readdir(agentsRoot, { withFileTypes: true }).catch(
    () => [],
  );
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    try {
      return JSON.parse(
        await readFile(
          join(agentsRoot, directory.name, `${agentId}.json`),
          "utf8",
        ),
      );
    } catch {
      continue;
    }
  }
  return null;
}

function normalizeToolName(name) {
  return name.replace(/^mcp__[a-z0-9_-]+__/i, "").replace(/^paseo\./, "");
}

async function toolCalls(agentId) {
  const page = await paseo.agents.ref(agentId).timeline.refetch({
    direction: "tail",
    limit: 200,
  });
  return page.entries
    .filter(
      (entry) =>
        entry.item?.type === "tool_call" && typeof entry.item.name === "string",
    )
    .map((entry) => normalizeToolName(entry.item.name));
}

async function cleanup(task) {
  let current = (await call("task-board.get", { taskId: task.id })).task;
  if (current.execution?.agentId) {
    await paseo.agents
      .ref(current.execution.agentId)
      .archive()
      .catch(() => {});
  }
  current = (await call("task-board.get", { taskId: task.id })).task;
  if (current.status !== "done" && current.status !== "cancelled") {
    current = (
      await call("task-board.cancel", {
        taskId: current.id,
        expectedRevision: current.revision,
      })
    ).task;
  }
  current = (await call("task-board.get", { taskId: task.id })).task;
  await call("task-board.delete", {
    taskId: current.id,
    expectedRevision: current.revision,
  }).catch(() => {});
}

async function main() {
  await client.connect();
  step("connect", { home, port });

  const health = await call("task-board.health");
  report.assertions.health = health;
  if (!health.toolInjectionEnabled) {
    throw new Error("daemon.mcp.injectIntoAgents is false");
  }

  const candidates = await call("task-board.candidates");
  const project =
    candidates.projects.find(
      (entry) => entry.projectId === process.env.E2E_PROJECT_ID,
    ) ?? candidates.projects[0];
  const workspace =
    project?.workspaces.find(
      (entry) => entry.workspaceId === process.env.E2E_WORKSPACE_ID,
    ) ?? project?.workspaces[0];
  if (!project || !workspace) throw new Error("no project/workspace available");
  report.assertions.target = {
    projectId: project.projectId,
    workspaceId: workspace.workspaceId,
  };

  const task = (
    await call("task-board.create", {
      title: `I5 planning smoke ${new Date().toISOString()}`,
      kind: "task-planning",
      description:
        "Verify planning prompt and board_* admin tools after release install.",
      acceptanceCriteria: [
        "systemPrompt contains the built-in planning prompt",
        "the planning agent can call board_get",
      ],
      labels: ["i5-release", "i5-planning"],
    })
  ).task;
  report.assertions.task = {
    id: task.id,
    displayId: task.displayId,
    kind: task.kind,
    status: task.status,
  };
  step("planning card created", report.assertions.task);

  const started = (
    await call("task-board.assign", {
      taskId: task.id,
      expectedRevision: task.revision,
      projectId: project.projectId,
      workspaceId: workspace.workspaceId,
      agent: {
        kind: "create",
        provider,
        model,
        modeId,
        thinkingOptionId: thinking,
      },
      message: `先调用 board_get 读取本卡（taskId="${task.id}"），然后只回复 OK。不要调用其他工具，不要修改文件。`,
      start: true,
    })
  ).task;
  const agentId = started.execution?.agentId;
  if (!agentId) throw new Error("planning card has no agent");
  report.assertions.agent = { id: agentId, status: started.status };
  step("planning agent started", report.assertions.agent);

  const snapshot = await waitFor(
    () => inspectAgent(agentId),
    120_000,
    "planning agent snapshot",
  );
  const systemPrompt = snapshot.config?.systemPrompt ?? "";
  report.assertions.systemPrompt = {
    hasG0: systemPrompt.includes("G0 读任务"),
    hasG5: systemPrompt.includes("G5 收尾"),
    mentionsBoardTools:
      systemPrompt.includes("board_list") &&
      systemPrompt.includes("board_declare"),
    interpolated: systemPrompt.includes(task.id),
    hasPlaceholder: systemPrompt.includes("{{taskId}}"),
    labels: snapshot.labels,
  };
  step("systemPrompt inspected", report.assertions.systemPrompt);
  if (!report.assertions.systemPrompt.hasG0) {
    throw new Error("planning prompt is missing G0 读任务");
  }
  if (!report.assertions.systemPrompt.hasG5) {
    throw new Error("planning prompt is missing G5 收尾");
  }
  if (!report.assertions.systemPrompt.mentionsBoardTools) {
    throw new Error("planning prompt does not mention board_* tools");
  }
  if (
    !report.assertions.systemPrompt.interpolated ||
    report.assertions.systemPrompt.hasPlaceholder
  ) {
    throw new Error("planning prompt did not interpolate {{taskId}}");
  }

  const observed = await waitFor(
    async () => {
      const names = await toolCalls(agentId);
      const board = names.filter((name) => name.startsWith("board_"));
      return board.length > 0 ? names : null;
    },
    180_000,
    "board_* tool call",
  );
  report.assertions.tools = {
    observed,
    hasBoardGet: observed.some((name) => name === "board_get"),
    boardTools: [
      ...new Set(observed.filter((name) => name.startsWith("board_"))),
    ],
  };
  step("tool calls inspected", report.assertions.tools);
  if (!report.assertions.tools.hasBoardGet) {
    throw new Error("board_get was not called by the planning agent");
  }

  await cleanup(task);
  report.ok = true;
  step("cleanup", { taskId: task.id });
}

try {
  await main();
} catch (error) {
  report.ok = false;
  report.error = error instanceof Error ? error.message : String(error);
  console.error(`[planning-smoke] FAILED: ${report.error}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
}
