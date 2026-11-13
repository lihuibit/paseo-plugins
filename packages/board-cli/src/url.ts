import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConnectionError } from "./errors.js";

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function normalizeDaemonUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new ConnectionError("Empty daemon URL");
  let url: URL;
  if (trimmed.startsWith("http://")) {
    url = new URL(trimmed);
    url.protocol = "ws:";
  } else if (trimmed.startsWith("https://")) {
    url = new URL(trimmed);
    url.protocol = "wss:";
  } else if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    url = new URL(trimmed);
  } else {
    url = new URL(`ws://${trimmed}`);
  }
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/ws";
  return url.toString();
}

export function listenToUrl(listen: string, fallbackPort = "6767"): string {
  const value = listen.trim();
  if (!value) return `http://127.0.0.1:${fallbackPort}`;
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }
  let host = value;
  let port = fallbackPort;
  const ipv6 = value.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6) {
    host = ipv6[1] ?? "127.0.0.1";
    port = ipv6[2] ?? fallbackPort;
  } else {
    const index = value.lastIndexOf(":");
    if (index > 0) {
      host = value.slice(0, index);
      port = value.slice(index + 1);
    }
  }
  if (
    host === "0.0.0.0" ||
    host === "::" ||
    host === "" ||
    host === "localhost"
  ) {
    host = "127.0.0.1";
  }
  return `http://${host}:${port}`;
}

export async function readHomeListen(home: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(join(home, "config.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConnectionError(
      `Cannot read ${join(home, "config.json")}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConnectionError(
      `Cannot parse ${join(home, "config.json")}: invalid JSON`,
    );
  }
  if (!parsed || typeof parsed !== "object") return null;
  const daemon = (parsed as { daemon?: unknown }).daemon;
  if (!daemon || typeof daemon !== "object") return null;
  const listen = (daemon as { listen?: unknown }).listen;
  return typeof listen === "string" && listen.trim() ? listen : null;
}

export interface ConnectionOptions {
  url: string;
  password?: string;
  home: string;
}

export async function resolveConnection(
  options: {
    url?: string;
    password?: string;
    home?: string;
  },
  env: NodeJS.ProcessEnv,
): Promise<ConnectionOptions> {
  const home = expandHome(
    options.home ?? env.PASEO_HOME ?? join(homedir(), ".paseo"),
  );
  const configuredUrl = options.url ?? env.PASEO_BOARD_URL;
  const listen = configuredUrl ? null : await readHomeListen(home);
  const url = normalizeDaemonUrl(
    configuredUrl ?? listenToUrl(listen ?? "127.0.0.1:6767"),
  );
  const password = options.password ?? env.PASEO_BOARD_PASSWORD;
  return {
    url,
    password: password && password.length > 0 ? password : undefined,
    home,
  };
}
