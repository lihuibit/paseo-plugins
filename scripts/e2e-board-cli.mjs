#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli =
  process.env.E2E_BOARD_CLI ??
  join(root, "packages/board-cli/bin/paseo-board.js");
const home =
  process.env.E2E_PASEO_HOME ?? join(homedir(), ".paseo-plugin-test");
const port = process.env.E2E_PASEO_PORT ?? "6769";
const provider = process.env.E2E_PROVIDER ?? "codex";
const model = process.env.E2E_MODEL ?? "workbuddy/hy4flash-dev";
const modeId = process.env.E2E_MODE ?? "full-access";
const thinking = process.env.E2E_THINKING ?? "high";
const reportPath = process.env.E2E_REPORT ?? null;
const authUrl = process.env.E2E_AUTH_URL ?? "http://127.0.0.1:6767";
const pluginId = "paseo-task-board";
const password = (
  await readFile(join(home, "local-credential"), "utf8")
).trim();
const baseUrl = `http://127.0.0.1:${port}`;

const report = {
  ok: false,
  startedAt: new Date().toISOString(),
  environment: { home, port, provider, model, modeId, thinking },
  task: null,
  steps: [],
  assertions: {},
};

function step(name, detail = {}) {
  report.steps.push({ name, at: new Date().toISOString(), ...detail });
  console.log(`[e2e] ${name}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function run(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        NO_COLOR: "1",
        PASEO_BOARD_URL: baseUrl,
        PASEO_BOARD_PASSWORD: password,
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function runJson(args) {
  const result = await run([...args, "--json"]);
  assert(
    result.code === 0,
    `expected exit 0 for ${args.join(" ")}, got ${result.code}: ${result.stderr}`,
  );
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `invalid JSON from ${args.join(" ")}: ${error.message}\n${result.stdout}`,
    );
  }
  return { parsed, result };
}

async function expectFailure(args, code, pattern, extraEnv = {}) {
  const result = await run(args, extraEnv);
  assert(
    result.code === code,
    `expected exit ${code} for ${args.join(" ")}, got ${result.code}`,
  );
  assert(
    pattern.test(result.stderr),
    `expected stderr to match ${pattern}, got: ${result.stderr}`,
  );
  return result;
}

async function candidates() {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    password,
    clientId: `board-cli-e2e-${process.pid}`,
    reconnect: { enabled: false },
  });
  await client.connect();
  try {
    const envelope = await client.invokePluginRpc(
      pluginId,
      "task-board.candidates",
      {},
    );
    if (!envelope?.ok) throw new Error(JSON.stringify(envelope));
    return envelope.value;
  } finally {
    await client.close();
  }
}

let created = null;
let finished = false;

try {
  const listing = await runJson(["list"]);
  report.assertions.exitCodes = { success: 0 };
  assert(Array.isArray(listing.parsed.tasks), "list returns tasks[]");
  step("list", { count: listing.parsed.tasks.length });

  const catalog = await candidates();
  const projectId =
    process.env.E2E_PROJECT_ID ?? catalog.projects[0]?.projectId;
  const workspaceId =
    process.env.E2E_WORKSPACE_ID ??
    catalog.projects[0]?.workspaces[0]?.workspaceId;
  assert(projectId, "a project exists in the test home");
  assert(workspaceId, "a workspace exists in the test home");
  report.environment.projectId = projectId;
  report.environment.workspaceId = workspaceId;

  const title = `E2E board CLI ${new Date().toISOString()}`;
  const createdResult = await runJson([
    "create",
    title,
    "--description",
    "Created by scripts/e2e-board-cli.mjs",
    "--acceptance",
    "list/create/assign/start/status/logs/send/stop/done",
    "--priority",
    "medium",
  ]);
  created = createdResult.parsed.task;
  report.task = {
    id: created.id,
    displayId: created.displayId,
    title: created.title,
  };
  assert(created.status === "planning", "new card is planning");
  step("create", { displayId: created.displayId });

  const updated = await runJson([
    "update",
    created.displayId,
    "--title",
    `${title} (updated)`,
  ]);
  assert(
    updated.parsed.task.title.endsWith("(updated)"),
    "update changes the title",
  );
  step("update", { title: updated.parsed.task.title });

  await runJson([
    "assign",
    created.displayId,
    "--project",
    projectId,
    "--workspace",
    workspaceId,
    "--provider",
    provider,
    "--model",
    model,
    "--mode",
    modeId,
    "--thinking",
    thinking,
    "--title",
    `CLI worker ${created.displayId}`,
  ]);
  step("assign");

  await runJson([
    "start",
    created.displayId,
    "--message",
    "Reply with exactly: cli-e2e-ok. Do not use tools.",
  ]);
  step("start");

  const waited = await runJson([
    "wait",
    created.displayId,
    "--until",
    "review,blocked",
    "--timeout",
    "120",
  ]);
  const statusAfterWait = await runJson(["status", created.displayId]);
  const agent = statusAfterWait.parsed.agent;
  report.assertions.agent = {
    lifecycle: agent?.lifecycle ?? null,
    modeId: agent?.modeId ?? null,
    pendingPermissions: agent?.pendingPermissions?.length ?? 0,
    activeTurn: agent?.activeTurn ?? null,
    lastError: agent?.lastError ?? null,
  };
  step("status", {
    reached: waited.parsed.reached,
    status: statusAfterWait.parsed.task.status,
    lifecycle: agent?.lifecycle ?? null,
  });
  assert(waited.parsed.reached === "review", "agent turn reaches review");
  assert(agent, "status includes the live agent");
  assert(
    Object.hasOwn(agent, "pendingPermissions"),
    "status includes pendingPermissions",
  );
  assert(Object.hasOwn(agent, "activeTurn"), "status includes activeTurn");
  assert(Object.hasOwn(agent, "lastError"), "status includes lastError");

  const logs = await runJson(["logs", created.displayId, "--tail", "20"]);
  report.assertions.logs = {
    count: logs.parsed.entries.length,
    kinds: [...new Set(logs.parsed.entries.map((entry) => entry.kind))],
  };
  step("logs", report.assertions.logs);
  assert(logs.parsed.entries.length > 0, "logs return entries");
  assert(
    logs.parsed.entries.some(
      (entry) => entry.kind === "assistant" || entry.kind === "user",
    ),
    "logs include assistant/user text",
  );
  for (const entry of logs.parsed.entries) {
    if (entry.text) assert(entry.text.length <= 500, "log text is truncated");
  }

  const events = await runJson(["events", created.displayId, "--tail", "10"]);
  assert(events.parsed.events.length > 0, "events are recorded");
  step("events", { count: events.parsed.events.length });

  const sent = await runJson([
    "send",
    created.displayId,
    "Reply with exactly: cli-e2e-second. Do not use tools.",
    "--wait",
    "90",
  ]);
  report.assertions.sendWait = {
    status: sent.parsed.wait?.status ?? null,
    error: sent.parsed.wait?.error ?? null,
    lastMessage: sent.parsed.wait?.lastMessage ?? null,
  };
  step("send", report.assertions.sendWait);
  assert(sent.parsed.wait, "send --wait returns a wait result");
  assert(
    sent.parsed.wait.status === "idle",
    `second turn completes (got ${sent.parsed.wait.status})`,
  );

  const stopped = await runJson(["stop", created.displayId]);
  assert(stopped.parsed.task.status === "blocked", "stop blocks the card");
  step("stop", { status: stopped.parsed.task.status });

  const completed = await runJson(["done", created.displayId]);
  assert(completed.parsed.task.status === "done", "done finishes the card");
  finished = true;
  step("done", { status: completed.parsed.task.status });

  const notFound = await expectFailure(
    ["show", "TASK-999999"],
    1,
    /Task not found: TASK-999999/,
  );
  report.assertions.exitCodes.notFound = notFound.code;
  step("error:task-not-found");

  if (process.env.E2E_SKIP_AUTH_TEST !== "1") {
    await expectFailure(["list"], 3, /Incorrect password/, {
      PASEO_BOARD_URL: authUrl,
      PASEO_BOARD_PASSWORD: "definitely-wrong",
    });
    step("error:bad-password");
  }

  const connect = await expectFailure(
    ["list"],
    3,
    /Cannot connect to Paseo daemon/,
    {
      PASEO_BOARD_URL: "http://127.0.0.1:1",
    },
  );
  report.assertions.exitCodes.connect = connect.code;
  step("error:connect");

  const usage = await expectFailure(
    ["list", "--bogus"],
    2,
    /Unknown option: --bogus/,
  );
  report.assertions.exitCodes.usage = usage.code;
  step("error:usage");

  report.ok = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(`[e2e] FAILED: ${report.error}`);
  if (created && !finished) {
    await run(["stop", created.displayId]).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
}
