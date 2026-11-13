import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const PLUGIN_ID = "agentstorm-task-board";

export function paseoHome(): string | null {
  return process.env.PASEO_HOME ?? null;
}

export function pluginDataDir(): string {
  const home = paseoHome();
  if (!home) {
    throw new Error(
      "PASEO_HOME is not set; the host did not provide a plugin data root",
    );
  }
  return join(home, "plugin-data", PLUGIN_ID);
}

export function tasksPath(): string {
  return join(pluginDataDir(), "tasks.json");
}

export function agentIndexPath(): string {
  return join(pluginDataDir(), "agentIndex.json");
}

export function eventsPath(): string {
  return join(pluginDataDir(), "events.jsonl");
}

export function deletedPath(): string {
  return join(pluginDataDir(), "deleted.jsonl");
}

export function settingsPath(): string {
  return join(pluginDataDir(), "settings.json");
}

export function notificationsPath(): string {
  return join(pluginDataDir(), "notifications.jsonl");
}

export function migrationsPath(): string {
  return join(pluginDataDir(), "migrations", "tasks.json");
}

export function locksDir(): string {
  return join(pluginDataDir(), "locks");
}

export function schedulerLockPath(): string {
  return join(locksDir(), "scheduler.lock");
}

export function legacyTasksPath(): string {
  const home = paseoHome();
  if (!home) {
    throw new Error(
      "PASEO_HOME is not set; cannot locate the legacy tasks file",
    );
  }
  return join(home, "tasks", "tasks.json");
}

export async function ensureDataDir(): Promise<void> {
  await mkdir(pluginDataDir(), { recursive: true });
}
