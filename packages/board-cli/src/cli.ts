import type { BoardClientOptions, BoardRpcClient } from "./client.js";
import {
  allFlags,
  boolFlag,
  flag,
  hasFlag,
  parseArgs,
  requirePositional,
  type ParsedArgs,
} from "./args.js";
import { BoardApiError, CliError, UsageError } from "./errors.js";
import {
  printEvents,
  printLogs,
  printProfiles,
  printProviderCatalog,
  printResult,
  printStatus,
  printTask,
  printTaskList,
  type RenderContext,
} from "./render.js";
import type {
  AgentSummary,
  BoardEvent,
  BoardStatus,
  BoardTask,
  Candidates,
  LogFilter,
  LogsResult,
  Profile,
  ProviderOptions,
  StatusResult,
  TaskSummary,
} from "./types.js";
import { resolveConnection } from "./url.js";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  isTTY: boolean;
  columns: number;
}

export interface CliDeps {
  createClient: (options: BoardClientOptions) => Promise<BoardRpcClient>;
  env: NodeJS.ProcessEnv;
}

interface CommandContext {
  parsed: ParsedArgs;
  io: CliIO;
  json: boolean;
  render: RenderContext;
}

const STATUSES: BoardStatus[] = [
  "planning",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

const PRIORITIES = ["none", "low", "medium", "high", "urgent"];
const LOG_FILTERS: LogFilter[] = [
  "all",
  "text",
  "tools",
  "errors",
  "permissions",
];
const DECLARE_KINDS = ["review", "blocked", "waiting", "progress"] as const;
const BLOCK_REASONS = [
  "human_required",
  "permission",
  "question",
  "manual",
] as const;

const HELP = `paseo-board - manage the Paseo task board from a shell

Usage:
  paseo-board <command> [options]

Commands:
  list [--status S] [--parent TASK-x] [--label L] [--query Q] [--limit 50]
  show TASK-x
  status TASK-x [--tail 5]
  logs TASK-x [--tail 20] [--filter all|text|tools|errors|permissions]
  events TASK-x [--kind K] [--tail 50]
  create "title" --description ... --acceptance ... [--kind task-planning] [--parent TASK-x]
  update TASK-x [--title ...] [--status ...] [--description ...] ...
  assign TASK-x --project P --workspace W [--profile ... | --provider ... --model ... --mode ... --thinking ...]
  start|stop|cancel|unassign TASK-x
  done TASK-x
  send TASK-x "message" [--wait [seconds]]
  wait TASK-x --until review|blocked|idle --timeout 120
  profiles
  providers [--provider ...] [--cwd ...]
  declare TASK-x review|blocked|waiting|progress --summary ...

Global options:
  --url <http(s)://host:port>   Daemon URL (env PASEO_BOARD_URL)
  --password <value>            Daemon password (env PASEO_BOARD_PASSWORD)
  --home <path>                 Paseo home; reads daemon.listen from config.json
  --json                        Print machine-readable JSON on stdout
  --no-color                    Disable ANSI colors
  -h, --help                    Show help
  -V, --version                 Show version

Exit codes: 0 success, 1 business error, 2 usage error, 3 connection/auth error.
`;

const COMMAND_HELP: Record<string, string> = {
  list: "paseo-board list [--status planning|todo|in_progress|in_review|blocked|done|cancelled] [--parent TASK-x] [--label L] [--query Q] [--limit 50] [--exclude-finished] [--json]",
  show: "paseo-board show TASK-x [--json]",
  status: "paseo-board status TASK-x [--tail 5] [--json]",
  logs: "paseo-board logs TASK-x [--tail 20] [--filter all|text|tools|errors|permissions] [--json]",
  events: "paseo-board events TASK-x [--kind K] [--tail 50] [--json]",
  create:
    'paseo-board create "title" [--description text] [--acceptance item]... [--priority P] [--label L]... [--kind task|task-planning] [--parent TASK-x] [--status S] [--json]',
  update:
    "paseo-board update TASK-x [--title text] [--description text] [--acceptance item]... [--priority P] [--label L]... [--parent TASK-x|none] [--status S] [--json]",
  assign:
    "paseo-board assign TASK-x --project P --workspace W [--profile ID|name] [--provider P] [--model M] [--mode MODE] [--thinking ID] [--title text] [--message text] [--start] [--json]",
  start: "paseo-board start TASK-x [--message text] [--json]",
  stop: "paseo-board stop TASK-x [--json]",
  cancel: "paseo-board cancel TASK-x [--json]",
  unassign: "paseo-board unassign TASK-x [--json]",
  done: "paseo-board done TASK-x [--json]",
  send: 'paseo-board send TASK-x "message" [--wait [seconds]] [--json]  (answers a pending question first)',
  wait: "paseo-board wait TASK-x [--until review|blocked|idle] [--timeout seconds] [--json]",
  profiles: "paseo-board profiles [--json]",
  providers: "paseo-board providers [--provider P] [--cwd PATH] [--json]",
  declare:
    "paseo-board declare TASK-x review|blocked|waiting|progress --summary text [--stage name] [--block-reason reason] [--agent ID] [--json]",
};

type Handler = (ctx: CommandContext, client: BoardRpcClient) => Promise<void>;

export async function runCli(
  argv: string[],
  io: CliIO,
  deps: CliDeps,
): Promise<number> {
  try {
    return await runInner(argv, io, deps);
  } catch (error) {
    const cliError =
      error instanceof CliError
        ? error
        : new CliError(
            error instanceof Error ? error.message : String(error),
            1,
          );
    const code = cliError instanceof BoardApiError ? `${cliError.code}: ` : "";
    io.stderr(`paseo-board: ${code}${cliError.message}\n`);
    return cliError.exitCode;
  }
}

async function runInner(
  argv: string[],
  io: CliIO,
  deps: CliDeps,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (boolFlag(parsed, "version")) {
    io.stdout("0.2.0\n");
    return 0;
  }
  if (!parsed.command || parsed.command === "help") {
    const target = parsed.positionals[0];
    io.stdout(
      target && COMMAND_HELP[target] ? `${COMMAND_HELP[target]}\n` : HELP,
    );
    return 0;
  }
  const handler = HANDLERS[parsed.command];
  if (!handler) throw new UsageError(`Unknown command: ${parsed.command}`);
  if (boolFlag(parsed, "help")) {
    io.stdout(`${COMMAND_HELP[parsed.command] ?? HELP}\n`);
    return 0;
  }

  const connection = await resolveConnection(
    {
      url: flag(parsed, "url"),
      password: flag(parsed, "password"),
      home: flag(parsed, "home"),
    },
    deps.env,
  );
  const client = await deps.createClient({
    url: connection.url,
    password: connection.password,
  });
  const json = boolFlag(parsed, "json");
  const render: RenderContext = {
    write: io.stdout,
    color: !boolFlag(parsed, "no-color") && !deps.env.NO_COLOR && io.isTTY,
    columns: io.columns,
  };
  try {
    await handler({ parsed, io, json, render }, client);
  } finally {
    try {
      await client.close();
    } catch {
      // The command result is already known; cleanup failures are not useful.
    }
  }
  return 0;
}

async function call<T>(
  client: BoardRpcClient,
  method: string,
  input: unknown,
): Promise<T> {
  return (await client.call(method, input)) as T;
}

function emitJson(io: CliIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function invalid(flagName: string, value: string, allowed: readonly string[]) {
  throw new UsageError(
    `Invalid value for --${flagName}: ${value} (expected ${allowed.join("|")})`,
  );
}

function validateStatus(value: string): BoardStatus {
  if (!(STATUSES as string[]).includes(value)) {
    invalid("status", value, STATUSES);
  }
  return value as BoardStatus;
}

function validatePriority(value: string): string {
  if (!PRIORITIES.includes(value)) invalid("priority", value, PRIORITIES);
  return value;
}

function validateFilter(value: string): LogFilter {
  if (!(LOG_FILTERS as string[]).includes(value)) {
    invalid("filter", value, LOG_FILTERS);
  }
  return value as LogFilter;
}

function numberValue(
  value: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(
      `--${name} must be an integer between ${min} and ${max}`,
    );
  }
  return parsed;
}

async function listTasks(client: BoardRpcClient): Promise<BoardTask[]> {
  const result = await call<{ tasks: BoardTask[] }>(client, "task-board.list", {
    includeFinished: true,
  });
  return result.tasks;
}

function matchTask(tasks: BoardTask[], ref: string): BoardTask | undefined {
  const lowered = ref.toLowerCase();
  return tasks.find(
    (task) => task.id === ref || task.displayId.toLowerCase() === lowered,
  );
}

async function resolveTask(
  client: BoardRpcClient,
  ref: string,
): Promise<BoardTask> {
  const tasks = await listTasks(client);
  const task = matchTask(tasks, ref);
  if (!task) {
    throw new BoardApiError("E_TASK_NOT_FOUND", `Task not found: ${ref}`);
  }
  return task;
}

async function freshTask(
  client: BoardRpcClient,
  ref: string,
): Promise<BoardTask> {
  const task = await resolveTask(client, ref);
  const result = await call<{ task: BoardTask }>(client, "task-board.get", {
    taskId: task.id,
  });
  return result.task;
}

async function taskSummaryOf(
  client: BoardRpcClient,
  taskId: string,
): Promise<TaskSummary> {
  const result = await call<StatusResult>(client, "task-board.status", {
    taskId,
  });
  return result.task;
}

async function emitTaskResult(
  ctx: CommandContext,
  client: BoardRpcClient,
  verb: string,
  taskId: string,
): Promise<void> {
  const summary = await taskSummaryOf(client, taskId);
  if (ctx.json) emitJson(ctx.io, { task: summary });
  else printResult(ctx.render, verb, summary);
}

async function resolveParent(
  client: BoardRpcClient,
  value: string | undefined,
): Promise<string | null | undefined> {
  if (value === undefined) return undefined;
  if (value === "none" || value === "-") return null;
  const parent = await resolveTask(client, value);
  return parent.id;
}

function findProject(
  candidates: Candidates,
  ref: string,
): Candidates["projects"][number] {
  const lowered = ref.toLowerCase();
  const matches = candidates.projects.filter(
    (project) =>
      project.projectId === ref || project.name.toLowerCase() === lowered,
  );
  if (matches.length === 0) {
    throw new BoardApiError(
      "E_PROJECT_NOT_FOUND",
      `Project not found: ${ref}. Available: ${
        candidates.projects.map((project) => project.name).join(", ") || "-"
      }`,
    );
  }
  if (matches.length > 1) {
    throw new UsageError(`Project name is ambiguous: ${ref}`);
  }
  return matches[0] as Candidates["projects"][number];
}

function findWorkspace(
  project: Candidates["projects"][number],
  ref: string,
): Candidates["projects"][number]["workspaces"][number] {
  const lowered = ref.toLowerCase();
  const matches = project.workspaces.filter(
    (workspace) =>
      workspace.workspaceId === ref || workspace.name.toLowerCase() === lowered,
  );
  if (matches.length === 0) {
    throw new BoardApiError(
      "E_WORKSPACE_NOT_FOUND",
      `Workspace not found in project ${project.name}: ${ref}. Available: ${
        project.workspaces.map((workspace) => workspace.name).join(", ") || "-"
      }`,
    );
  }
  if (matches.length > 1) {
    throw new UsageError(`Workspace name is ambiguous: ${ref}`);
  }
  return matches[0] as Candidates["projects"][number]["workspaces"][number];
}

function findProfile(profiles: Profile[], ref: string): Profile | undefined {
  const lowered = ref.toLowerCase();
  const matches = profiles.filter(
    (profile) => profile.id === ref || profile.name.toLowerCase() === lowered,
  );
  if (matches.length > 1) {
    throw new UsageError(`Profile name is ambiguous: ${ref}`);
  }
  return matches[0];
}

const list: Handler = async (ctx, client) => {
  const status = flag(ctx.parsed, "status");
  const input: Record<string, unknown> = {
    includeFinished: !boolFlag(ctx.parsed, "exclude-finished"),
  };
  if (status) input.status = validateStatus(status);
  const parent = await resolveParent(client, flag(ctx.parsed, "parent"));
  if (parent !== undefined) input.hierarchyParentId = parent;
  const label = flag(ctx.parsed, "label");
  if (label) input.label = label;
  const query = flag(ctx.parsed, "query");
  if (query) input.query = query;
  input.limit = numberValue(flag(ctx.parsed, "limit"), 50, "limit", 1, 200);
  const result = await call<{
    tasks: TaskSummary[];
    total: number;
    counts: Record<string, number>;
  }>(client, "task-board.list-summary", input);
  if (ctx.json) emitJson(ctx.io, result);
  else printTaskList(ctx.render, result.tasks);
};

const show: Handler = async (ctx, client) => {
  const task = await freshTask(
    client,
    requirePositional(ctx.parsed, 0, "task id"),
  );
  if (ctx.json) emitJson(ctx.io, { task });
  else printTask(ctx.render, task);
};

const status: Handler = async (ctx, client) => {
  const task = await resolveTask(
    client,
    requirePositional(ctx.parsed, 0, "task id"),
  );
  const tail = numberValue(flag(ctx.parsed, "tail"), 5, "tail", 1, 20);
  const result = await call<StatusResult>(client, "task-board.status", {
    taskId: task.id,
    tail,
  });
  if (ctx.json) emitJson(ctx.io, result);
  else printStatus(ctx.render, result);
};

const logs: Handler = async (ctx, client) => {
  const task = await resolveTask(
    client,
    requirePositional(ctx.parsed, 0, "task id"),
  );
  const limit = numberValue(flag(ctx.parsed, "tail"), 20, "tail", 1, 200);
  const filter = validateFilter(flag(ctx.parsed, "filter") ?? "all");
  const result = await call<LogsResult>(client, "task-board.logs", {
    taskId: task.id,
    limit,
    filter,
  });
  if (ctx.json) emitJson(ctx.io, result);
  else printLogs(ctx.render, task.displayId, result);
};

const events: Handler = async (ctx, client) => {
  const task = await resolveTask(
    client,
    requirePositional(ctx.parsed, 0, "task id"),
  );
  const limit = numberValue(flag(ctx.parsed, "tail"), 50, "tail", 1, 500);
  const input: Record<string, unknown> = { taskId: task.id, limit };
  const kind = flag(ctx.parsed, "kind");
  if (kind) input.kind = kind;
  const result = await call<{ events: BoardEvent[] }>(
    client,
    "task-board.events",
    input,
  );
  if (ctx.json) emitJson(ctx.io, result);
  else printEvents(ctx.render, result.events);
};

const create: Handler = async (ctx, client) => {
  const title = requirePositional(ctx.parsed, 0, "title");
  const input: Record<string, unknown> = { title };
  const description = flag(ctx.parsed, "description");
  if (description !== undefined) input.description = description;
  const acceptance = allFlags(ctx.parsed, "acceptance");
  if (acceptance.length > 0) input.acceptanceCriteria = acceptance;
  const priority = flag(ctx.parsed, "priority");
  if (priority) input.priority = validatePriority(priority);
  const labels = allFlags(ctx.parsed, "label");
  if (labels.length > 0) input.labels = labels;
  const kind = flag(ctx.parsed, "kind");
  if (kind) {
    if (kind !== "task" && kind !== "task-planning") {
      invalid("kind", kind, ["task", "task-planning"]);
    }
    input.kind = kind;
  }
  const parent = await resolveParent(client, flag(ctx.parsed, "parent"));
  if (parent !== undefined) input.hierarchyParentId = parent;
  const statusValue = flag(ctx.parsed, "status");
  if (statusValue) input.status = validateStatus(statusValue);
  const result = await call<{ task: BoardTask }>(
    client,
    "task-board.create",
    input,
  );
  await emitTaskResult(ctx, client, "Created", result.task.id);
};

const update: Handler = async (ctx, client) => {
  const task = await freshTask(
    client,
    requirePositional(ctx.parsed, 0, "task id"),
  );
  const patch: Record<string, unknown> = {};
  const title = flag(ctx.parsed, "title");
  if (title !== undefined) patch.title = title;
  const description = flag(ctx.parsed, "description");
  if (description !== undefined) {
    patch.description = description.length > 0 ? description : null;
  }
  if (hasFlag(ctx.parsed, "acceptance")) {
    patch.acceptanceCriteria = allFlags(ctx.parsed, "acceptance");
  }
  const priority = flag(ctx.parsed, "priority");
  if (priority) patch.priority = validatePriority(priority);
  if (hasFlag(ctx.parsed, "label")) {
    patch.labels = allFlags(ctx.parsed, "label");
  }
  if (hasFlag(ctx.parsed, "parent")) {
    patch.hierarchyParentId = await resolveParent(
      client,
      flag(ctx.parsed, "parent"),
    );
  }
  const statusValue = flag(ctx.parsed, "status");
  if (Object.keys(patch).length === 0 && !statusValue) {
    throw new UsageError(
      "update needs at least one of --title, --description, --acceptance, --priority, --label, --parent or --status",
    );
  }
  let current = task;
  if (Object.keys(patch).length > 0) {
    const result = await call<{ task: BoardTask }>(
      client,
      "task-board.update",
      {
        taskId: task.id,
        expectedRevision: task.revision,
        patch,
      },
    );
    current = result.task;
  }
  if (statusValue) {
    const result = await call<{ task: BoardTask }>(
      client,
      "task-board.set-status",
      {
        taskId: current.id,
        expectedRevision: current.revision,
        status: validateStatus(statusValue),
      },
    );
    current = result.task;
  }
  await emitTaskResult(ctx, client, "Updated", current.id);
};

const assign: Handler = async (ctx, client) => {
  const task = await freshTask(
    client,
    requirePositional(ctx.parsed, 0, "task id"),
  );
  const projectRef = flag(ctx.parsed, "project");
  const workspaceRef = flag(ctx.parsed, "workspace");
  if (!projectRef) throw new UsageError("assign needs --project");
  if (!workspaceRef) throw new UsageError("assign needs --workspace");
  const candidates = await call<Candidates>(
    client,
    "task-board.candidates",
    {},
  );
  const project = findProject(candidates, projectRef);
  const workspace = findWorkspace(project, workspaceRef);

  let provider = flag(ctx.parsed, "provider");
  let model = flag(ctx.parsed, "model");
  let modeId = flag(ctx.parsed, "mode");
  let thinkingOptionId = flag(ctx.parsed, "thinking");
  let title = flag(ctx.parsed, "title");
  const profileRef = flag(ctx.parsed, "profile");
  if (profileRef) {
    const profile = findProfile(candidates.profiles, profileRef);
    if (!profile) {
      throw new BoardApiError(
        "E_PROFILE_NOT_FOUND",
        `Agent profile not found: ${profileRef}`,
      );
    }
    provider = provider ?? profile.provider;
    model = model ?? profile.model;
    modeId = modeId ?? profile.modeId;
    thinkingOptionId = thinkingOptionId ?? profile.thinkingOptionId;
    title = title ?? profile.name;
  }
  if (!provider) {
    throw new UsageError("assign needs --profile or --provider");
  }

  const result = await call<{ task: BoardTask }>(client, "task-board.assign", {
    taskId: task.id,
    expectedRevision: task.revision,
    projectId: project.projectId,
    workspaceId: workspace.workspaceId,
    agent: {
      kind: "create",
      provider,
      model,
      modeId,
      thinkingOptionId,
      title,
    },
    message: flag(ctx.parsed, "message"),
    start: boolFlag(ctx.parsed, "start"),
  });
  const summary = await taskSummaryOf(client, result.task.id);
  if (ctx.json) emitJson(ctx.io, { task: summary });
  else {
    printResult(ctx.render, "Assigned", summary);
    ctx.io.stdout(
      `  ${project.name} / ${workspace.name} -> ${provider}/${model ?? "-"} mode=${modeId ?? "-"}\n`,
    );
  }
};

const start: Handler = async (ctx, client) => {
  const task = await freshTask(
    client,
    requirePositional(ctx.parsed, 0, "task id"),
  );
  const input: Record<string, unknown> = { taskId: task.id };
  const message = flag(ctx.parsed, "message");
  if (message) input.message = message;
  const result = await call<{ task: BoardTask }>(
    client,
    "task-board.start",
    input,
  );
  await emitTaskResult(ctx, client, "Started", result.task.id);
};

const stop: Handler = async (ctx, client) => {
  const task = await freshTask(
    client,
    requirePositional(ctx.parsed, 0, "task id"),
  );
  const result = await call<{ task: BoardTask }>(client, "task-board.stop", {
    taskId: task.id,
  });
  await emitTaskResult(ctx, client, "Stopped", result.task.id);
};

const cancel: Handler = async (ctx, client) => {
  const task = await freshTask(
    client,
    requirePositional(ctx.parsed, 0, "task id"),
  );
  const result = await call<{ task: BoardTask }>(client, "task-board.cancel", {
    taskId: task.id,
    expectedRevision: task.revision,
  });
  await emitTaskResult(ctx, client, "Cancelled", result.task.id);
};

const unassign: Handler = async (ctx, client) => {
  const task = await freshTask(
    client,
    requirePositional(ctx.parsed, 0, "task id"),
  );
  const result = await call<{ task: BoardTask }>(
    client,
    "task-board.unassign",
    { taskId: task.id, expectedRevision: task.revision },
  );
  await emitTaskResult(ctx, client, "Unassigned", result.task.id);
};

const done: Handler = async (ctx, client) => {
  const task = await resolveTask(
    client,
    requirePositional(ctx.parsed, 0, "task id"),
  );
  const result = await call<{ task: TaskSummary }>(client, "task-board.done", {
    taskId: task.id,
  });
  if (ctx.json) emitJson(ctx.io, result);
  else printResult(ctx.render, "Done", result.task);
};

const send: Handler = async (ctx, client) => {
  const task = await resolveTask(
    client,
    requirePositional(ctx.parsed, 0, "task id"),
  );
  const message = requirePositional(ctx.parsed, 1, "message");
  const waitFlag = flag(ctx.parsed, "wait");
  const waitSeconds = hasFlag(ctx.parsed, "wait")
    ? numberValue(waitFlag ?? "300", 300, "wait", 0, 300)
    : 0;
  const result = await call<{
    task: TaskSummary;
    interrupted?: boolean;
    answered?: boolean;
    wait: {
      status: string;
      lastMessage: string | null;
      error: string | null;
    } | null;
  }>(client, "task-board.send", {
    taskId: task.id,
    message,
    waitSeconds,
  });
  if (ctx.json) emitJson(ctx.io, result);
  else {
    ctx.io.stdout(
      result.answered
        ? `Answered the pending question on ${result.task.displayId}.\n`
        : `Sent to ${result.task.displayId}${
            result.interrupted ? " after interrupting the current turn" : ""
          }.\n`,
    );
    if (result.wait) {
      ctx.io.stdout(
        `  turn ${result.wait.status}${
          result.wait.error ? `: ${result.wait.error}` : ""
        }\n`,
      );
      if (result.wait.lastMessage) {
        ctx.io.stdout(`  ${result.wait.lastMessage}\n`);
      }
    }
  }
};

const wait: Handler = async (ctx, client) => {
  const task = await resolveTask(
    client,
    requirePositional(ctx.parsed, 0, "task id"),
  );
  const rawUntil = allFlags(ctx.parsed, "until").flatMap((value) =>
    value.split(","),
  );
  const until = (rawUntil.length > 0 ? rawUntil : ["review", "blocked"]).filter(
    (value): value is "review" | "blocked" | "idle" =>
      value === "review" || value === "blocked" || value === "idle",
  );
  if (until.length === 0) {
    throw new UsageError("--until expects review, blocked or idle");
  }
  const timeout = numberValue(
    flag(ctx.parsed, "timeout"),
    60,
    "timeout",
    1,
    120,
  );
  const result = await call<{
    reached: "review" | "blocked" | "idle" | null;
    task: BoardTask;
    agent: AgentSummary | null;
  }>(client, "task-board.wait", {
    taskId: task.id,
    until,
    timeoutMs: timeout * 1_000,
  });
  if (ctx.json) emitJson(ctx.io, result);
  else if (result.reached) {
    ctx.io.stdout(
      `${result.task.displayId} reached ${result.reached} (status=${result.task.status}).\n`,
    );
  } else {
    ctx.io.stdout(
      `Timed out after ${timeout}s waiting for ${result.task.displayId} (status=${result.task.status}).\n`,
    );
  }
};

const profiles: Handler = async (ctx, client) => {
  const result = await call<{ profiles: Profile[] }>(
    client,
    "task-board.profiles.list",
    {},
  );
  if (ctx.json) emitJson(ctx.io, result);
  else printProfiles(ctx.render, result.profiles);
};

const providers: Handler = async (ctx, client) => {
  const input: Record<string, unknown> = {};
  const provider = flag(ctx.parsed, "provider");
  if (provider) input.provider = provider;
  const cwd = flag(ctx.parsed, "cwd");
  if (cwd) input.cwd = cwd;
  const result = await call<{
    providers: Array<{ provider: string; available: boolean }>;
    catalog?: ProviderOptions;
  }>(client, "task-board.providers", input);
  if (ctx.json) emitJson(ctx.io, result);
  else printProviderCatalog(ctx.render, result.providers, result.catalog);
};

const declare: Handler = async (ctx, client) => {
  const task = await resolveTask(
    client,
    requirePositional(ctx.parsed, 0, "task id"),
  );
  const kind = requirePositional(ctx.parsed, 1, "declaration kind");
  if (!(DECLARE_KINDS as readonly string[]).includes(kind)) {
    invalid("kind", kind, DECLARE_KINDS);
  }
  const agentId = flag(ctx.parsed, "agent") ?? task.execution?.agentId;
  if (!agentId) {
    throw new BoardApiError(
      "E_NOT_ASSIGNED",
      `${task.displayId} has no bound agent; pass --agent`,
    );
  }
  const input: Record<string, unknown> = {
    taskId: task.id,
    agentId,
    kind,
  };
  const summary = flag(ctx.parsed, "summary");
  if (summary) input.summary = summary;
  if (kind === "progress" && !summary) {
    throw new UsageError("declare progress needs --summary");
  }
  const stage = flag(ctx.parsed, "stage");
  if (stage) input.stage = stage;
  const blockReason = flag(ctx.parsed, "block-reason");
  if (blockReason) {
    if (!(BLOCK_REASONS as readonly string[]).includes(blockReason)) {
      invalid("block-reason", blockReason, BLOCK_REASONS);
    }
    input.blockReason = blockReason;
  }
  const result = await call<{ task: BoardTask; accepted: boolean }>(
    client,
    "task-board.declare",
    input,
  );
  if (ctx.json) {
    emitJson(ctx.io, {
      accepted: result.accepted,
      taskId: result.task.id,
      displayId: result.task.displayId,
      status: result.task.status,
      revision: result.task.revision,
    });
  } else {
    ctx.io.stdout(
      `Declared ${kind} for ${result.task.displayId} (status=${result.task.status}).\n`,
    );
  }
};

const HANDLERS: Record<string, Handler> = {
  list,
  show,
  status,
  logs,
  events,
  create,
  update,
  assign,
  start,
  stop,
  cancel,
  unassign,
  done,
  send,
  wait,
  profiles,
  providers,
  declare,
};
