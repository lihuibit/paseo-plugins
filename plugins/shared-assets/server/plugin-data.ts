import { cp, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const PLUGIN_ID = "paseo-shared-assets";
const LEGACY_PLUGIN_ID = "agentstorm-shared-assets";

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

let legacyMigration: Promise<void> | null = null;

async function migrateLegacyPluginData(): Promise<void> {
  const home = process.env.PASEO_HOME;
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

export function pluginDataDir(): string {
  const home = process.env.PASEO_HOME;
  if (!home) {
    throw new Error(
      "PASEO_HOME is not set; the host did not provide a plugin data root",
    );
  }
  return join(home, "plugin-data", PLUGIN_ID);
}

export function reposDir(): string {
  return join(pluginDataDir(), "repos");
}

export function repoDir(projectId: string): string {
  return join(reposDir(), projectId);
}

export function configPath(): string {
  return join(pluginDataDir(), "config.json");
}

export async function ensureDataDirs(): Promise<void> {
  await ensureLegacyMigrated();
  await mkdir(pluginDataDir(), { recursive: true });
  await mkdir(reposDir(), { recursive: true });
  await mkdir(join(pluginDataDir(), "logs"), { recursive: true });
}

export function logPath(): string {
  return join(pluginDataDir(), "logs", "rpc.log");
}
