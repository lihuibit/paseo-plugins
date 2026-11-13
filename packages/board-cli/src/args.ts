import { UsageError } from "./errors.js";

export type FlagKind = "value" | "bool" | "optional-value";
export type FlagSpec = Record<string, FlagKind>;
export type FlagValue = string | true;

export interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Record<string, FlagValue[]>;
}

export const GLOBAL_FLAGS: FlagSpec = {
  url: "value",
  password: "value",
  home: "value",
  json: "bool",
  "no-color": "bool",
  help: "bool",
  version: "bool",
};

export const COMMAND_FLAGS: Record<string, FlagSpec> = {
  list: {
    status: "value",
    parent: "value",
    label: "value",
    query: "value",
    limit: "value",
    "exclude-finished": "bool",
  },
  show: {},
  status: { tail: "value" },
  logs: { tail: "value", filter: "value" },
  events: { kind: "value", tail: "value" },
  create: {
    description: "value",
    acceptance: "value",
    priority: "value",
    label: "value",
    kind: "value",
    parent: "value",
    status: "value",
  },
  update: {
    title: "value",
    description: "value",
    acceptance: "value",
    priority: "value",
    label: "value",
    status: "value",
    parent: "value",
  },
  assign: {
    project: "value",
    workspace: "value",
    profile: "value",
    provider: "value",
    model: "value",
    mode: "value",
    thinking: "value",
    title: "value",
    message: "value",
    start: "bool",
  },
  start: { message: "value" },
  stop: {},
  cancel: {},
  unassign: {},
  done: {},
  send: { wait: "optional-value" },
  wait: { until: "value", timeout: "value" },
  profiles: {},
  providers: { provider: "value", cwd: "value" },
  declare: {
    summary: "value",
    stage: "value",
    agent: "value",
    "block-reason": "value",
  },
  help: {},
};

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, FlagValue[]> = {};
  const positionals: string[] = [];
  let command: string | undefined;

  const store = (name: string, value: FlagValue) => {
    const values = flags[name] ?? [];
    values.push(value);
    flags[name] = values;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token === "-h") {
      store("help", true);
      continue;
    }
    if (token === "-V") {
      store("version", true);
      continue;
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
      const inline = equals === -1 ? undefined : token.slice(equals + 1);
      const spec = command
        ? { ...GLOBAL_FLAGS, ...COMMAND_FLAGS[command] }
        : GLOBAL_FLAGS;
      const kind = spec[name];
      if (!kind) throw new UsageError(`Unknown option: --${name}`);
      if (kind === "bool") {
        if (inline !== undefined) {
          throw new UsageError(`--${name} does not take a value`);
        }
        store(name, true);
        continue;
      }
      if (inline !== undefined) {
        store(name, inline);
        continue;
      }
      if (kind === "optional-value") {
        const next = argv[index + 1];
        if (next !== undefined && /^\d+$/.test(next)) {
          store(name, next);
          index += 1;
        } else {
          store(name, true);
        }
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined) {
        throw new UsageError(`Missing value for --${name}`);
      }
      store(name, next);
      index += 1;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      throw new UsageError(`Unknown option: ${token}`);
    }
    if (!command) command = token;
    else positionals.push(token);
  }

  return { command, positionals, flags };
}

export function flagValues(parsed: ParsedArgs, name: string): FlagValue[] {
  return parsed.flags[name] ?? [];
}

export function flag(parsed: ParsedArgs, name: string): string | undefined {
  const values = flagValues(parsed, name);
  const last = values[values.length - 1];
  return typeof last === "string" ? last : undefined;
}

export function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return flagValues(parsed, name).length > 0;
}

export function boolFlag(parsed: ParsedArgs, name: string): boolean {
  return hasFlag(parsed, name);
}

export function allFlags(parsed: ParsedArgs, name: string): string[] {
  return flagValues(parsed, name).filter(
    (value): value is string => typeof value === "string",
  );
}

export function requirePositional(
  parsed: ParsedArgs,
  index: number,
  label: string,
): string {
  const value = parsed.positionals[index];
  if (!value) throw new UsageError(`Missing ${label}`);
  return value;
}
