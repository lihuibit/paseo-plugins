import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { PaseoApi } from "./paseo-types";
import { locksDir, schedulerLockPath } from "./plugin-data";

const TICK_MS = 5_000;
const RECONCILE_MS = 30_000;
const HEARTBEAT_MS = 30_000;
export const STALE_LOCK_MS = 90_000;

interface SchedulerLockFile {
  pluginId: string;
  instanceId: string;
  pid: number;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface SchedulerService {
  runDueScheduled(paseo: PaseoApi, now: Date): Promise<void>;
  reconcileAgents(paseo: PaseoApi, now: Date): Promise<void>;
}

export interface SchedulerStatus {
  instanceId: string;
  lockHeld: boolean;
  lockOwner: string | null;
  lastTickAt: string | null;
  lastReconcileAt: string | null;
  lastError: string | null;
}

async function readLock(): Promise<{
  raw: string;
  value: SchedulerLockFile | null;
} | null> {
  try {
    const raw = await readFile(schedulerLockPath(), "utf8");
    try {
      return { raw, value: JSON.parse(raw) as SchedulerLockFile };
    } catch {
      return { raw, value: null };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWriteLock(value: SchedulerLockFile): Promise<void> {
  const path = schedulerLockPath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

export class SchedulerLock {
  readonly instanceId: string;
  private held = false;
  private lastHeartbeat = 0;
  private owner: string | null = null;

  constructor(
    instanceId: string = randomUUID(),
    private readonly options: {
      now?: () => number;
      staleMs?: number;
    } = {},
  ) {
    this.instanceId = instanceId;
  }

  isHeld(): boolean {
    return this.held;
  }

  currentOwner(): string | null {
    return this.owner;
  }

  async acquire(): Promise<boolean> {
    await mkdir(locksDir(), { recursive: true });
    const existing = await readLock();
    const now = this.now();
    const stamp = new Date(now).toISOString();
    const payload: SchedulerLockFile = {
      pluginId: "paseo-task-board",
      instanceId: this.instanceId,
      pid: process.pid,
      acquiredAt: stamp,
      heartbeatAt: stamp,
    };
    if (existing) {
      const heartbeat = existing.value
        ? Date.parse(existing.value.heartbeatAt)
        : Number.NaN;
      if (
        existing.value &&
        existing.value.instanceId !== this.instanceId &&
        Number.isFinite(heartbeat) &&
        now - heartbeat < (this.options.staleMs ?? STALE_LOCK_MS)
      ) {
        this.owner = existing.value.instanceId;
        this.held = false;
        return false;
      }
      if (
        existing.value &&
        heartbeat >= 0 &&
        now - heartbeat >= (this.options.staleMs ?? STALE_LOCK_MS)
      ) {
        console.warn(
          `[paseo-task-board] taking over stale scheduler lock from ${existing.value.instanceId}`,
        );
      }
    } else {
      try {
        const handle = await open(schedulerLockPath(), "wx");
        await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`);
        await handle.close();
        this.held = true;
        this.owner = this.instanceId;
        this.lastHeartbeat = now;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return this.acquire();
      }
    }

    await atomicWriteLock(payload);
    this.held = true;
    this.owner = this.instanceId;
    this.lastHeartbeat = now;
    return true;
  }

  async heartbeat(): Promise<void> {
    if (!this.held) return;
    const now = this.now();
    if (now - this.lastHeartbeat < HEARTBEAT_MS) return;
    const existing = await readLock();
    const current = existing?.value;
    if (!current || current.instanceId !== this.instanceId) {
      this.held = false;
      this.owner = current?.instanceId ?? null;
      return;
    }
    const stamp = new Date(now).toISOString();
    await atomicWriteLock({
      pluginId: "paseo-task-board",
      instanceId: this.instanceId,
      pid: process.pid,
      acquiredAt: current.acquiredAt,
      heartbeatAt: stamp,
    });
    this.lastHeartbeat = now;
  }

  async release(): Promise<void> {
    if (!this.held) return;
    const existing = await readLock();
    if (existing?.value?.instanceId === this.instanceId) {
      await unlink(schedulerLockPath()).catch(() => undefined);
    }
    this.held = false;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}

export class Scheduler {
  readonly lock: SchedulerLock;
  private timer: ReturnType<typeof setInterval> | null = null;
  private paseo: PaseoApi | null = null;
  private running = false;
  private stopped = false;
  private lastTickAt: string | null = null;
  private lastReconcileAt: string | null = null;
  private lastError: string | null = null;
  private readonly now: () => Date;
  private readonly tickMs: number;

  constructor(
    private readonly service: SchedulerService,
    options: {
      instanceId?: string;
      now?: () => Date;
      tickMs?: number;
    } = {},
  ) {
    this.lock = new SchedulerLock(options.instanceId, {
      now: options.now ? () => options.now!().getTime() : undefined,
    });
    this.now = options.now ?? (() => new Date());
    this.tickMs = options.tickMs ?? TICK_MS;
  }

  start(paseo: PaseoApi): void {
    if (this.paseo || this.stopped) return;
    this.paseo = paseo;
    console.log(
      `[paseo-task-board] scheduler starting (instance ${this.lock.instanceId})`,
    );
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped || !this.paseo) return;
    this.running = true;
    try {
      if (!this.lock.isHeld()) {
        const acquired = await this.lock.acquire();
        if (!acquired) return;
        console.log(
          `[paseo-task-board] scheduler lock acquired by ${this.lock.instanceId}`,
        );
      } else {
        await this.lock.heartbeat();
      }
      if (!this.lock.isHeld()) return;

      const now = this.now();
      await this.service.runDueScheduled(this.paseo, now);
      this.lastTickAt = now.toISOString();
      const lastReconcile = this.lastReconcileAt
        ? Date.parse(this.lastReconcileAt)
        : 0;
      if (now.getTime() - lastReconcile >= RECONCILE_MS) {
        await this.service.reconcileAgents(this.paseo, now);
        this.lastReconcileAt = now.toISOString();
      }
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error("[paseo-task-board] scheduler tick failed", this.lastError);
    } finally {
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.lock.release();
  }

  status(): SchedulerStatus {
    return {
      instanceId: this.lock.instanceId,
      lockHeld: this.lock.isHeld(),
      lockOwner: this.lock.currentOwner(),
      lastTickAt: this.lastTickAt,
      lastReconcileAt: this.lastReconcileAt,
      lastError: this.lastError,
    };
  }
}
