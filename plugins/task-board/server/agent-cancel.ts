import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const RESPONSE_TIMEOUT_MS = 15_000;

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function paseoHome(): string {
  return expandHome(process.env.PASEO_HOME ?? join(homedir(), ".paseo"));
}

async function readDaemonListen(home: string): Promise<string | null> {
  try {
    const raw = await readFile(join(home, "config.json"), "utf8");
    const parsed = JSON.parse(raw) as { daemon?: { listen?: unknown } };
    const listen = parsed.daemon?.listen;
    return typeof listen === "string" && listen.trim() ? listen.trim() : null;
  } catch {
    return null;
  }
}

async function readLocalCredential(home: string): Promise<string | null> {
  try {
    const token = (
      await readFile(join(home, "local-credential"), "utf8")
    ).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

function daemonUrl(listen: string): string {
  const value = listen.trim();
  if (value.startsWith("http://") || value.startsWith("https://")) {
    const url = new URL(value);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (url.pathname === "/" || url.pathname === "") url.pathname = "/ws";
    return url.toString();
  }
  if (value.startsWith("ws://") || value.startsWith("wss://")) {
    const url = new URL(value);
    if (url.pathname === "/" || url.pathname === "") url.pathname = "/ws";
    return url.toString();
  }
  if (
    value.startsWith("unix://") ||
    value.startsWith("pipe://") ||
    value.startsWith("/") ||
    value.startsWith("\\\\.\\pipe\\")
  ) {
    throw new Error(
      "The Paseo daemon listens on a local socket; cancel through the Paseo app instead",
    );
  }

  let host = value;
  let port = "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) throw new Error(`Invalid daemon.listen: ${listen}`);
    host = value.slice(1, end);
    const rest = value.slice(end + 1);
    if (!rest.startsWith(":"))
      throw new Error(`Invalid daemon.listen: ${listen}`);
    port = rest.slice(1);
  } else {
    const index = value.lastIndexOf(":");
    if (index > 0) {
      host = value.slice(0, index);
      port = value.slice(index + 1);
    }
  }
  if (!port) throw new Error(`Invalid daemon.listen: ${listen}`);
  if (
    host === "0.0.0.0" ||
    host === "::" ||
    host === "localhost" ||
    host === ""
  ) {
    host = "127.0.0.1";
  }
  const formatted = host.includes(":") ? `[${host}]` : host;
  return `ws://${formatted}:${port}/ws`;
}

/**
 * Cancels an agent run through the daemon's `cancel_agent_request` RPC.
 *
 * Paseo's plugin SDK (`PaseoApi`) does not expose `cancelAgent`, and
 * `handle.reload()` reopens the provider session instead of only interrupting
 * the run. The plugin process runs next to the daemon and has its home, so it
 * opens one short-lived client connection for the cancel. This is the true
 * stop path: the daemon's `cancelAgentRun` settles the turn and clears
 * `pendingPermissions` before acknowledging.
 */
export async function cancelAgentViaDaemon(agentId: string): Promise<void> {
  const home = paseoHome();
  const listen = await readDaemonListen(home);
  if (!listen) {
    throw new Error(
      `Cannot locate the Paseo daemon: daemon.listen is missing from ${join(home, "config.json")}`,
    );
  }
  const url = daemonUrl(listen);
  const token = await readLocalCredential(home);
  const requestId = randomUUID();

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    let requested = false;
    const timer = setTimeout(
      () =>
        finish(
          new Error("Timed out waiting for the Paseo daemon to cancel the run"),
        ),
      RESPONSE_TIMEOUT_MS,
    );
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // The socket may already be closed.
      }
      if (error) reject(error);
      else resolve();
    }

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          clientId: `paseo-task-board-cancel-${process.pid}-${requestId}`,
          clientType: "cli",
          protocolVersion: 1,
          ...(token ? { auth: { kind: "localCredential", token } } : {}),
        }),
      );
    });

    function requestCancel(): void {
      if (requested || settled) return;
      requested = true;
      socket.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "cancel_agent_request",
            agentId,
            requestId,
          },
        }),
      );
    }

    socket.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;
      const record = message as Record<string, unknown>;
      if (record.type === "hello.rejected") {
        finish(
          new Error(
            record.reason === "password_required"
              ? "The Paseo daemon requires a password; open Paseo and cancel the run there"
              : "The Paseo daemon rejected the local credential",
          ),
        );
        return;
      }
      const inner =
        record.type === "session" &&
        record.message &&
        typeof record.message === "object"
          ? (record.message as Record<string, unknown>)
          : record;
      if (inner.type === "status" && inner.payload) {
        const status = inner.payload as Record<string, unknown>;
        if (status.status === "server_info") requestCancel();
        return;
      }
      if (inner.type !== "cancel_agent_response") return;
      const payload =
        inner.payload && typeof inner.payload === "object"
          ? (inner.payload as Record<string, unknown>)
          : {};
      if (payload.requestId !== requestId) return;
      if (typeof payload.error === "string" && payload.error.length > 0) {
        finish(new Error(payload.error));
      } else {
        finish();
      }
    });

    socket.on("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
    socket.on("close", () => {
      finish(
        new Error(
          "The Paseo daemon closed the connection before acknowledging the cancel",
        ),
      );
    });
  });
}
