import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  BLOCK_REASON_LABELS,
  BOARD_STATUS_LABELS,
  type BoardTask,
} from "../shared/core/board/types";
import type { BoardSettingsStore } from "./settings";
import { notificationsPath } from "./plugin-data";

export type NotificationEvent = "review" | "blocked" | "scheduled" | "progress";

export interface NotificationAttempt {
  at: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface NotificationRecord {
  at: string;
  taskId: string;
  displayId: string;
  revision: number;
  event: NotificationEvent;
  attempts: NotificationAttempt[];
  ok: boolean;
  skipped?: string;
}

export interface NotifierOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: number[];
  timeoutMs?: number;
  now?: () => Date;
  record?: (record: NotificationRecord) => Promise<void>;
}

const PROGRESS_INTERVAL_MS = 60_000;
const DEDUPE_TTL_MS = 10 * 60_000;
const MAX_DEDUPE_ENTRIES = 500;

function eventEnabled(
  event: NotificationEvent,
  settings: Awaited<ReturnType<BoardSettingsStore["read"]>>,
): boolean {
  switch (event) {
    case "review":
      return settings.wecom.notifyOnReview;
    case "blocked":
      return settings.wecom.notifyOnBlocked;
    case "scheduled":
      return settings.wecom.notifyOnScheduled;
    case "progress":
      return settings.wecom.notifyOnProgress;
  }
}

function messageFor(task: BoardTask, event: NotificationEvent): string {
  const lines = [
    `### 任务看板 · ${event === "review" ? "待验收" : event === "blocked" ? "阻塞" : event === "scheduled" ? "定时触发" : "进度"}`,
    `> **${task.displayId}** ${task.title}`,
    `> 状态：${BOARD_STATUS_LABELS[task.status]}`,
  ];
  if (task.blockReason) {
    lines.push(`> 原因：${BLOCK_REASON_LABELS[task.blockReason]}`);
  }
  if (task.blockDetail) lines.push(`> 详情：${task.blockDetail}`);
  if (task.progress) {
    lines.push(
      `> 进度：${task.progress.stage ? `${task.progress.stage} · ` : ""}${task.progress.summary}`,
    );
  }
  if (task.execution?.agentTitle) {
    lines.push(`> Agent：${task.execution.agentTitle}`);
  }
  lines.push(`> revision：${task.revision}`);
  return lines.join("\n");
}

async function defaultRecord(record: NotificationRecord): Promise<void> {
  try {
    await mkdir(dirname(notificationsPath()), { recursive: true });
    await appendFile(notificationsPath(), `${JSON.stringify(record)}\n`);
  } catch (error) {
    console.error(
      "[paseo-task-board] cannot append notification record",
      error,
    );
  }
}

export class WeComNotifier {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelaysMs: number[];
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly record: (record: NotificationRecord) => Promise<void>;
  private readonly recent = new Map<string, number>();
  private readonly lastByTask = new Map<string, number>();
  private readonly lastProgress = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly settings: BoardSettingsStore,
    options: NotifierOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 5_000, 15_000];
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.now = options.now ?? (() => new Date());
    this.record = options.record ?? defaultRecord;
  }

  enqueue(task: BoardTask, event: NotificationEvent): void {
    this.queue = this.queue
      .then(() => this.deliverIfEnabled(task, event))
      .catch((error: unknown) => {
        console.error("[paseo-task-board] notification queue failed", error);
      });
  }

  async test(webhookUrl?: string): Promise<{
    ok: boolean;
    attempts: NotificationAttempt[];
    error?: string;
  }> {
    const settings = await this.settings.read();
    const url = (webhookUrl ?? settings.wecom.webhookUrl).trim();
    if (!url) {
      return {
        ok: false,
        attempts: [],
        error: "Webhook URL is empty",
      };
    }
    const attempts = await this.post(
      url,
      "### 任务看板测试消息\n> WeCom Webhook 配置可用。",
      settings.wecom.retries,
    );
    const ok = attempts.at(-1)?.ok === true;
    await this.record({
      at: this.now().toISOString(),
      taskId: "test",
      displayId: "TEST",
      revision: 0,
      event: "review",
      attempts,
      ok,
    });
    return {
      ok,
      attempts,
      error: ok ? undefined : (attempts.at(-1)?.error ?? "Send failed"),
    };
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private async deliverIfEnabled(
    task: BoardTask,
    event: NotificationEvent,
  ): Promise<void> {
    const settings = await this.settings.read();
    const url = settings.wecom.webhookUrl.trim();
    if (!settings.wecom.enabled || !url) return;
    if (!eventEnabled(event, settings)) return;

    const now = this.now();
    const dedupeKey = `${task.id}:${task.revision}:${event}`;
    const lastKeyAt = this.recent.get(dedupeKey);
    if (lastKeyAt !== undefined && now.getTime() - lastKeyAt < DEDUPE_TTL_MS) {
      return;
    }
    if (event === "progress") {
      const lastAt = this.lastProgress.get(task.id) ?? 0;
      if (now.getTime() - lastAt < PROGRESS_INTERVAL_MS) return;
      this.lastProgress.set(task.id, now.getTime());
    }

    const lastTaskAt = this.lastByTask.get(task.id) ?? 0;
    const waitMs = settings.wecom.minIntervalMs - (now.getTime() - lastTaskAt);
    if (waitMs > 0) await this.sleep(waitMs);
    this.lastByTask.set(task.id, this.now().getTime());

    this.remember(dedupeKey, now.getTime());
    const attempts = await this.post(
      url,
      messageFor(task, event),
      settings.wecom.retries,
    );
    await this.record({
      at: this.now().toISOString(),
      taskId: task.id,
      displayId: task.displayId,
      revision: task.revision,
      event,
      attempts,
      ok: attempts.at(-1)?.ok === true,
    });
  }

  private remember(key: string, at: number): void {
    this.recent.set(key, at);
    if (this.recent.size <= MAX_DEDUPE_ENTRIES) return;
    for (const [entry, entryAt] of this.recent) {
      if (at - entryAt > DEDUPE_TTL_MS) this.recent.delete(entry);
    }
    while (this.recent.size > MAX_DEDUPE_ENTRIES) {
      const oldest = this.recent.keys().next().value;
      if (oldest === undefined) break;
      this.recent.delete(oldest);
    }
  }

  private async post(
    url: string,
    content: string,
    retries: number,
  ): Promise<NotificationAttempt[]> {
    const attempts: NotificationAttempt[] = [];
    const maxAttempts = Math.max(1, retries + 1);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        const delay =
          this.retryDelaysMs[attempt - 1] ??
          this.retryDelaysMs[this.retryDelaysMs.length - 1] ??
          0;
        if (delay > 0) await this.sleep(delay);
      }
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            msgtype: "markdown",
            markdown: { content },
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const body = (await response.json().catch(() => null)) as {
          errcode?: number;
          errmsg?: string;
        } | null;
        const ok =
          response.ok && (body?.errcode === undefined || body.errcode === 0);
        attempts.push({
          at: this.now().toISOString(),
          ok,
          status: response.status,
          error: ok ? undefined : (body?.errmsg ?? `HTTP ${response.status}`),
        });
        if (ok) return attempts;
      } catch (error) {
        attempts.push({
          at: this.now().toISOString(),
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return attempts;
  }
}
