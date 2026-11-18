import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pluginDataDir } from "./plugin-data";

export interface SharedAssetEvent {
  at: string;
  kind: string;
  projectId: string;
  detail: Record<string, unknown>;
}

function eventsPath(): string {
  return join(pluginDataDir(), "logs", "events.jsonl");
}

export async function recordEvent(
  projectId: string,
  kind: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const event: SharedAssetEvent = {
    at: new Date().toISOString(),
    kind,
    projectId,
    detail,
  };
  try {
    await mkdir(dirname(eventsPath()), { recursive: true });
    await appendFile(eventsPath(), `${JSON.stringify(event)}\n`);
  } catch {
    // Events are diagnostic only and must not fail the RPC.
  }
}
