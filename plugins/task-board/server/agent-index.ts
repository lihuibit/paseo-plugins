import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import {
  BOARD_LABEL,
  BOARD_TASK_LABEL,
  LEGACY_BOARD_LABEL,
  LEGACY_BOARD_TASK_LABEL,
  type BoardTask,
} from "../shared/core/board/types";
import {
  isBoardAgent,
  preferredTaskForAgent,
  taskIdFromAgent,
} from "../shared/core/board/agent-index";
import { agentIndexPath } from "./plugin-data";

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

function parseIndex(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const index: Record<string, string> = {};
  for (const [agentId, taskId] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (typeof taskId === "string" && taskId.length > 0)
      index[agentId] = taskId;
  }
  return index;
}

export class AgentIndex {
  private index: Record<string, string> = {};

  async load(): Promise<void> {
    this.index = parseIndex(await readJson(agentIndexPath()));
  }

  all(): Record<string, string> {
    return { ...this.index };
  }

  taskIdFor(agentId: string): string | null {
    return this.index[agentId] ?? null;
  }

  async bind(agentId: string, taskId: string): Promise<void> {
    if (this.index[agentId] === taskId) return;
    this.index[agentId] = taskId;
    await this.save();
  }

  async unbind(agentId: string): Promise<void> {
    if (!(agentId in this.index)) return;
    delete this.index[agentId];
    await this.save();
  }

  async replace(index: Record<string, string>): Promise<void> {
    this.index = index;
    await this.save();
  }

  private async save(): Promise<void> {
    await atomicWrite(
      agentIndexPath(),
      `${JSON.stringify(this.index, null, 2)}\n`,
    );
  }

  resolve(
    agent:
      | PluginHookAgent
      | {
          id: string;
          labels?: Record<string, string> | null;
          metadata?: Record<string, unknown> | null;
        },
  ): string | null {
    const fromIndex = this.index[agent.id];
    if (fromIndex) return fromIndex;
    if (!isBoardAgent(agent)) return null;
    return taskIdFromAgent(agent);
  }
}

export async function rebuildFromPaseo(
  paseo: PaseoApi,
  tasks: readonly BoardTask[],
): Promise<Record<string, string>> {
  const pages = await Promise.all(
    [BOARD_LABEL, LEGACY_BOARD_LABEL].map((label) =>
      paseo.agents.list({
        includeBackground: true,
        filter: { labels: { [label]: "1" } },
        page: { limit: 200 },
      }),
    ),
  );
  const known = new Set(tasks.map((task) => task.id));
  const index: Record<string, string> = {};
  for (const page of pages) {
    for (const entry of page.entries) {
      const agent = entry.agent;
      if (agent.archivedAt) continue;
      const taskId =
        agent.labels?.[BOARD_TASK_LABEL] ??
        agent.labels?.[LEGACY_BOARD_TASK_LABEL] ??
        taskIdFromAgent(agent);
      if (!taskId || !known.has(taskId)) continue;
      index[agent.id] = taskId;
    }
  }
  const agentIds = new Set([
    ...Object.keys(index),
    ...tasks
      .map((task) => task.execution?.agentId)
      .filter((agentId): agentId is string => Boolean(agentId)),
  ]);
  for (const agentId of agentIds) {
    const preferred = preferredTaskForAgent(tasks, agentId);
    if (preferred) index[agentId] = preferred.id;
  }
  return index;
}
