import { cp, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const PLUGIN_ID = "paseo-task-board";
const LEGACY_PLUGIN_ID = "agentstorm-task-board";

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

let legacyMigration: Promise<void> | null = null;

async function migrateLegacyPluginData(): Promise<void> {
  const home = paseoHome();
  if (!home) return;
  const target = join(home, "plugin-data", PLUGIN_ID);
  if (await exists(target)) return;
  const legacy = join(home, "plugin-data", LEGACY_PLUGIN_ID);
  if (!(await exists(legacy))) return;
  await cp(legacy, target, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
}

function ensureLegacyMigrated(): Promise<void> {
  legacyMigration ??= migrateLegacyPluginData().catch((error) => {
    legacyMigration = null;
    throw error;
  });
  return legacyMigration;
}

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
  await ensureLegacyMigrated();
  await mkdir(pluginDataDir(), { recursive: true });
}
