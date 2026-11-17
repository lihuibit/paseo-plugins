import { PluginError } from "../shared/core/errors";
import type { Binding, PluginConfig } from "../shared/core/types";
import { configPath, ensureDataDirs } from "./plugin-data";
import { readJson, writeJson } from "./fs-utils";

function emptyConfig(): PluginConfig {
  return {
    version: 1,
    bindings: {},
    skills: {},
    instructions: {},
    settings: { monitorIntervalMs: 60_000 },
  };
}

const projectQueues = new Map<string, Promise<unknown>>();

export async function readConfig(): Promise<PluginConfig> {
  const config = await readJson<PluginConfig>(configPath());
  if (!config) return emptyConfig();
  return {
    version: 1,
    bindings: config.bindings ?? {},
    skills: config.skills ?? {},
    instructions: config.instructions ?? {},
    settings: {
      monitorIntervalMs:
        config.settings?.monitorIntervalMs &&
        config.settings.monitorIntervalMs >= 5_000
          ? config.settings.monitorIntervalMs
          : 60_000,
    },
  };
}

export async function writeConfig(config: PluginConfig): Promise<void> {
  await ensureDataDirs();
  await writeJson(configPath(), config);
}

/** Serializes every mutation for one project, including projection writes. */
export async function withProjectLock<T>(
  projectId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = projectQueues.get(projectId) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => current);
  projectQueues.set(projectId, queued);
  await previous.catch(() => {});
  try {
    return await work();
  } finally {
    release();
    if (projectQueues.get(projectId) === queued)
      projectQueues.delete(projectId);
  }
}

export async function requireBinding(projectId: string): Promise<Binding> {
  const config = await readConfig();
  const binding = config.bindings[projectId];
  if (!binding) {
    throw new PluginError(
      "E_NOT_CONFIGURED",
      `Project ${projectId} has no shared-assets binding`,
    );
  }
  return binding;
}

export async function saveBinding(binding: Binding): Promise<void> {
  const config = await readConfig();
  config.bindings[binding.projectId] = binding;
  await writeConfig(config);
}

export function touchBinding(binding: Binding): Binding {
  binding.revision += 1;
  return binding;
}
