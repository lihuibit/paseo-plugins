#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";

const home = process.env.E2E_PASEO_HOME ?? "/home/ubuntu/.paseo-plugin-test";
const port = process.env.E2E_PASEO_PORT ?? "6769";
const projectId = process.env.E2E_PROJECT_ID ?? null;
const workspaceId = process.env.E2E_WORKSPACE_ID ?? null;
const provider = process.env.E2E_PROVIDER ?? "codex";
const model = process.env.E2E_MODEL ?? "workbuddy/hy4flash-dev";
const modeId = process.env.E2E_MODE ?? "full-access";
const thinking = process.env.E2E_THINKING ?? "high";
const reportPath = process.env.E2E_REPORT ?? null;
const pluginId = "paseo-task-board";

const password = (await readFile(`${home}/local-credential`, "utf8")).trim();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  password,
  clientId: `planning-tools-e2e-${process.pid}`,
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

async function listTasks() {
  return (await call("task-board.list", { includeFinished: true })).tasks;
}

async function getTask(taskId) {
  return (await call("task-board.get", { taskId })).task;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function waitForStatus(taskId, wanted, timeoutMs = 600_000) {
  return waitFor(
    async () => {
      const task = await getTask(taskId);
      return wanted.includes(task.status) ? task : null;
    },
    timeoutMs,
    `${taskId} to reach ${wanted.join("/")}`,
  );
}

async function agentTools(agentId) {
  const page = await paseo.agents.ref(agentId).timeline.refetch({
    direction: "tail",
    limit: 200,
  });
  return page.entries
    .filter(
      (entry) =>
        entry.item?.type === "tool_call" && typeof entry.item.name === "string",
    )
    .map((entry) =>
      entry.item.name.replace(/^mcp__paseo__/, "").replace(/^paseo\./, ""),
    );
}

async function inspectAgent(agentId) {
  const agentsRoot = join(home, "agents");
  const directories = await readdir(agentsRoot, { withFileTypes: true }).catch(
    () => [],
  );
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    try {
      const raw = await readFile(
        join(agentsRoot, directory.name, `${agentId}.json`),
        "utf8",
      );
      return JSON.parse(raw);
    } catch {
      continue;
    }
  }
  return null;
}

async function cancelQuietly(taskId) {
  try {
    const task = await getTask(taskId);
    if (task.execution?.agentId) {
      await paseo.agents
        .ref(task.execution.agentId)
        .archive()
        .catch(() => {});
    }
    await call("task-board.set-status", {
      taskId,
      expectedRevision: task.revision,
      status: "cancelled",
    }).catch(() => {});
  } catch {
    // Best-effort cleanup for probe cards.
  }
}

const CUSTOM_PLANNING_PROMPT = `E2E-MARKER 你是任务看板卡片 {{taskId}} 的规划 Agent。
这是自动化验收；用户已经预先批准所有 G1/G2/G4 门禁。
严格按用户消息中的顺序调用 board_* 工具，每一步都必须真的调用，不要修改任何文件，
不要调用外部命令行。全部完成后调用 board_declare{kind:"review"}。`;

async function main() {
  await client.connect();
  step("connect", { home, port });

  const health = await call("task-board.health");
  report.assertions.health = health;
  if (!health.toolInjectionEnabled) {
    throw new Error("daemon.mcp.injectIntoAgents is false");
  }

  const candidates = await call("task-board.candidates");
  const project = projectId
    ? candidates.projects.find((entry) => entry.projectId === projectId)
    : candidates.projects[0];
  if (!project) throw new Error("no project available in the E2E home");
  const workspace = workspaceId
    ? project.workspaces.find((entry) => entry.workspaceId === workspaceId)
    : project.workspaces[0];
  if (!workspace) throw new Error("no workspace available in the E2E home");
  report.assertions.target = {
    projectId: project.projectId,
    workspaceId: workspace.workspaceId,
    directory: workspace.directory,
  };
  step("target", report.assertions.target);

  const originalSettings = (await call("task-board.settings.get")).settings;

  // 1. Settings override takes effect for a new planning session.
  const overridden = (
    await call("task-board.settings.update", {
      patch: { planningPrompt: CUSTOM_PLANNING_PROMPT },
    })
  ).settings;
  report.assertions.settingsOverride = {
    planningPrompt: overridden.planningPrompt,
  };

  const probeOne = (
    await call("task-board.create", {
      title: `E2E planning prompt override ${new Date().toISOString()}`,
      kind: "task-planning",
      description: "Probe card for the configurable planning prompt.",
      labels: ["e2e", "planning-tools"],
    })
  ).task;
  const probeOneStarted = (
    await call("task-board.assign", {
      taskId: probeOne.id,
      expectedRevision: probeOne.revision,
      projectId: project.projectId,
      workspaceId: workspace.workspaceId,
      agent: {
        kind: "create",
        provider,
        model,
        modeId,
        thinkingOptionId: thinking,
      },
      message: "只回复 OK，不要调用任何工具，不要修改文件。",
      start: true,
    })
  ).task;
  const probeOneAgentId = probeOneStarted.execution?.agentId;
  if (!probeOneAgentId) throw new Error("probe one has no agent");
  const probeOneSnapshot = await waitFor(
    async () => inspectAgent(probeOneAgentId),
    120_000,
    "probe one agent snapshot",
  );
  report.assertions.overridePrompt = {
    taskId: probeOne.id,
    agentId: probeOneAgentId,
    hasMarker: probeOneSnapshot.config?.systemPrompt?.includes("E2E-MARKER"),
    interpolated: probeOneSnapshot.config?.systemPrompt?.includes(probeOne.id),
    hasPlaceholder:
      probeOneSnapshot.config?.systemPrompt?.includes("{{taskId}}"),
    labels: probeOneSnapshot.labels,
  };
  step("probe one started", report.assertions.overridePrompt);
  if (!report.assertions.overridePrompt.hasMarker) {
    throw new Error("override planning prompt was not applied");
  }
  if (!report.assertions.overridePrompt.interpolated) {
    throw new Error("planning prompt did not interpolate {{taskId}}");
  }
  await cancelQuietly(probeOne.id);

  // 2. Resetting returns to the built-in G0-G5 prompt.
  const reset = (
    await call("task-board.settings.update", {
      patch: { planningPrompt: null },
    })
  ).settings;
  report.assertions.settingsReset = { planningPrompt: reset.planningPrompt };

  const probeTwo = (
    await call("task-board.create", {
      title: `E2E planning prompt default ${new Date().toISOString()}`,
      kind: "task-planning",
      labels: ["e2e", "planning-tools"],
    })
  ).task;
  const probeTwoStarted = (
    await call("task-board.assign", {
      taskId: probeTwo.id,
      expectedRevision: probeTwo.revision,
      projectId: project.projectId,
      workspaceId: workspace.workspaceId,
      agent: {
        kind: "create",
        provider,
        model,
        modeId,
        thinkingOptionId: thinking,
      },
      message: "只回复 OK，不要调用任何工具，不要修改文件。",
      start: true,
    })
  ).task;
  const probeTwoAgentId = probeTwoStarted.execution?.agentId;
  if (!probeTwoAgentId) throw new Error("probe two has no agent");
  const probeTwoSnapshot = await waitFor(
    async () => inspectAgent(probeTwoAgentId),
    120_000,
    "probe two agent snapshot",
  );
  report.assertions.builtinPrompt = {
    taskId: probeTwo.id,
    agentId: probeTwoAgentId,
    hasG0: probeTwoSnapshot.config?.systemPrompt?.includes("G0 读任务"),
    hasG5: probeTwoSnapshot.config?.systemPrompt?.includes("G5 收尾"),
    hasMarker: probeTwoSnapshot.config?.systemPrompt?.includes("E2E-MARKER"),
  };
  step("probe two started", report.assertions.builtinPrompt);
  if (!report.assertions.builtinPrompt.hasG0) {
    throw new Error("built-in planning prompt was not restored");
  }
  await cancelQuietly(probeTwo.id);

  // 3. Full sequence, using the override so the automated run has no human gates.
  await call("task-board.settings.update", {
    patch: { planningPrompt: CUSTOM_PLANNING_PROMPT },
  });

  const parent = (
    await call("task-board.create", {
      title: `E2E planning tools ${new Date().toISOString()}`,
      kind: "task-planning",
      description:
        "Run the board management sequence: list, create, assign, start, status, logs, send, done.",
      acceptanceCriteria: [
        "A child card is created and assigned",
        "The child agent reaches review",
        "The parent reports review",
      ],
      labels: ["e2e", "planning-tools"],
    })
  ).task;
  const parentStarted = (
    await call("task-board.assign", {
      taskId: parent.id,
      expectedRevision: parent.revision,
      projectId: project.projectId,
      workspaceId: workspace.workspaceId,
      agent: {
        kind: "create",
        provider,
        model,
        modeId,
        thinkingOptionId: thinking,
      },
      start: true,
      message: [
        "这是自动化验收。请严格按顺序调用工具，每一步都必须真的调用，完成后才进入下一步：",
        "1. board_list，参数 includeFinished=true。",
        `2. board_create 建子任务：title="E2E child ${parent.displayId}"，kind="task"，description="Child card created by the planning E2E"，hierarchyParentId="${parent.id}"。记下返回的 task.id。`,
        `3. board_assign：taskId=子任务 id，projectId="${project.projectId}"，workspaceId="${workspace.workspaceId}"，agent={"kind":"create","provider":"${provider}","model":"${model}","modeId":"${modeId}","thinkingOptionId":"${thinking}"}，start=false。`,
        '4. board_start：taskId=子任务 id，message="请只调用 board_declare，kind=\\"review\\"，summary=\\"child ready\\"，然后回复 DONE。不要修改任何文件。"。',
        "5. board_status：taskId=子任务 id。",
        "6. board_logs：taskId=子任务 id，limit=20。",
        '7. board_wait：taskId=子任务 id，until=["review","blocked"]，timeoutMs=120000。',
        '8. board_send：taskId=子任务 id，message="确认完成，请保持 review。"，waitSeconds=0。',
        "9. board_done：taskId=子任务 id。",
        `10. board_declare：kind="review"，summary="E2E planning sequence complete"。`,
      ].join("\n"),
    })
  ).task;
  const parentAgentId = parentStarted.execution?.agentId;
  if (!parentAgentId) throw new Error("planning card has no agent");
  report.assertions.parent = {
    taskId: parent.id,
    displayId: parent.displayId,
    agentId: parentAgentId,
    status: parentStarted.status,
  };
  step("planning agent started", report.assertions.parent);

  const child = await waitFor(
    async () => {
      const tasks = await listTasks();
      return (
        tasks.find(
          (task) =>
            task.hierarchyParentId === parent.id &&
            task.title.startsWith("E2E child"),
        ) ?? null
      );
    },
    600_000,
    "child card",
  );
  report.assertions.child = {
    taskId: child.id,
    agentId: child.execution?.agentId ?? null,
    status: child.status,
  };
  step("child created", report.assertions.child);

  let childTask = child;
  let parentTask = parentStarted;
  for (let round = 0; round < 4; round += 1) {
    try {
      [childTask, parentTask] = await Promise.all([
        waitFor(
          async () => {
            const task = await getTask(child.id);
            return ["in_review", "done"].includes(task.status) ? task : null;
          },
          420_000,
          "child review",
        ),
        waitForStatus(parent.id, ["in_review", "blocked", "done"], 420_000),
      ]);
      break;
    } catch (error) {
      if (round === 3) throw error;
      if ((await getTask(parent.id)).status === "blocked") {
        await call("task-board.start", {
          taskId: parent.id,
          message:
            "用户已确认，继续执行未完成的工具步骤，不要再次请示。完成后 board_declare review。",
        });
      }
    }
  }

  childTask = await getTask(child.id);
  parentTask = await getTask(parent.id);
  report.assertions.childFinal = {
    taskId: childTask.id,
    status: childTask.status,
    agentId: childTask.execution?.agentId ?? null,
    declaration: childTask.declaration ?? null,
  };
  report.assertions.parentFinal = {
    taskId: parentTask.id,
    status: parentTask.status,
    declaration: parentTask.declaration ?? null,
  };
  step("child and parent settled", {
    child: report.assertions.childFinal,
    parent: report.assertions.parentFinal,
  });

  const tools = await agentTools(parentAgentId);
  report.assertions.parentTools = tools;
  const required = [
    "board_list",
    "board_create",
    "board_assign",
    "board_start",
    "board_status",
    "board_logs",
    "board_send",
    "board_done",
    "board_declare",
  ];
  report.assertions.toolsObserved = Object.fromEntries(
    required.map((name) => [name, tools.includes(name)]),
  );
  step("parent tool calls", report.assertions.toolsObserved);
  const missingTools = required.filter((name) => !tools.includes(name));
  if (missingTools.length > 0) {
    throw new Error(`missing tool calls: ${missingTools.join(", ")}`);
  }
  if (childTask.status !== "done") {
    throw new Error(`child card did not reach done: ${childTask.status}`);
  }
  if (parentTask.status !== "in_review") {
    throw new Error(`parent card did not reach review: ${parentTask.status}`);
  }

  const parentSnapshot = await inspectAgent(parentAgentId);
  report.assertions.parentPrompt = {
    hasMarker: parentSnapshot?.config?.systemPrompt?.includes("E2E-MARKER"),
    labels: parentSnapshot?.labels ?? null,
  };
  const childAgentId = childTask.execution?.agentId;
  if (childAgentId) {
    const childSnapshot = await inspectAgent(childAgentId);
    report.assertions.childPrompt = {
      workerContract: childSnapshot?.config?.systemPrompt?.includes(
        "You are the assigned agent",
      ),
      hasPlanningGates:
        childSnapshot?.config?.systemPrompt?.includes("G0 读任务"),
      labels: childSnapshot?.labels ?? null,
    };
    if (report.assertions.childPrompt.hasPlanningGates) {
      throw new Error("worker prompt contains planning gates");
    }
  }

  await call("task-board.settings.update", {
    patch: { planningPrompt: originalSettings.planningPrompt || null },
  });

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
