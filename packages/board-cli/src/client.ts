import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { BoardApiError, ConnectionError } from "./errors.js";

export const PLUGIN_ID = "agentstorm-task-board";

export interface BoardRpcClient {
  call(method: string, input: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface BoardClientOptions {
  url: string;
  password?: string;
}

interface Envelope {
  ok?: unknown;
  value?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
}

function asEnvelope(value: unknown): Envelope {
  if (!value || typeof value !== "object") {
    throw new BoardApiError(
      "E_PROTOCOL",
      "Plugin RPC returned a non-object response",
    );
  }
  return value as Envelope;
}

export async function createBoardClient(
  options: BoardClientOptions,
): Promise<BoardRpcClient> {
  const client = new DaemonClient({
    url: options.url,
    password: options.password,
    clientId: `paseo-board-${process.pid}`,
    reconnect: { enabled: false },
    connectTimeoutMs: 10_000,
  });

  try {
    await client.connect();
  } catch (error) {
    const authFailure = client.authFailureReason;
    try {
      await client.close();
    } catch {
      // ignore close failures after a failed connection
    }
    if (authFailure === "incorrect_password") {
      throw new ConnectionError(
        `Incorrect password for Paseo daemon at ${options.url}`,
      );
    }
    if (authFailure === "password_required") {
      throw new ConnectionError(
        `Password required for Paseo daemon at ${options.url}. Set PASEO_BOARD_PASSWORD or pass --password.`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ConnectionError(
      `Cannot connect to Paseo daemon at ${options.url}: ${message}`,
    );
  }

  return {
    async call(method, input) {
      let response: unknown;
      try {
        response = await client.invokePluginRpc(PLUGIN_ID, method, input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new BoardApiError(
          "E_RPC_FAILED",
          `Plugin ${PLUGIN_ID} call ${method} failed: ${message}`,
        );
      }
      const envelope = asEnvelope(response);
      if (envelope.ok === true) return envelope.value;
      if (envelope.ok === false && envelope.error) {
        const code =
          typeof envelope.error.code === "string"
            ? envelope.error.code
            : "E_INTERNAL";
        const message =
          typeof envelope.error.message === "string"
            ? envelope.error.message
            : "Unknown plugin error";
        const details =
          envelope.error.details && typeof envelope.error.details === "object"
            ? (envelope.error.details as Record<string, unknown>)
            : undefined;
        throw new BoardApiError(code, message, details);
      }
      throw new BoardApiError(
        "E_PROTOCOL",
        "Plugin RPC response is missing ok/value/error",
      );
    },
    async close() {
      await client.close();
    },
  };
}
