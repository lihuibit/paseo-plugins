import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const PLUGIN_ID = "agentstorm-shared-assets";

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
  await mkdir(pluginDataDir(), { recursive: true });
  await mkdir(reposDir(), { recursive: true });
  await mkdir(join(pluginDataDir(), "logs"), { recursive: true });
}

export function logPath(): string {
  return join(pluginDataDir(), "logs", "rpc.log");
}
