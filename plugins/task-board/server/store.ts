import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
  emptyBoardDocument,
  ensureTaskDocument,
} from "../shared/core/board/state";
import type { BoardTaskDocument } from "../shared/core/board/types";
import { deletedPath, eventsPath, tasksPath } from "./plugin-data";

export interface BoardEvent {
  at: string;
  kind: string;
  taskId?: string;
  detail?: Record<string, unknown>;
}

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

export class BoardStore {
  private document: BoardTaskDocument = emptyBoardDocument();
  private tail: Promise<void> = Promise.resolve();
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await readJson(tasksPath());
    if (raw === null) {
      this.document = emptyBoardDocument();
      this.loaded = true;
      return;
    }
    try {
      this.document = ensureTaskDocument(raw);
    } catch (error) {
      console.error(
        "[agentstorm-task-board] tasks.json is invalid; starting empty",
        error,
      );
      this.document = emptyBoardDocument();
    }
    this.loaded = true;
  }

  async read(): Promise<BoardTaskDocument> {
    await this.load();
    return structuredClone(this.document);
  }

  async transact<T>(
    work: (document: BoardTaskDocument) => {
      document: BoardTaskDocument;
      result: T;
    },
  ): Promise<T> {
    await this.load();
    let resolveResult: (value: T | PromiseLike<T>) => void = () => {};
    let rejectResult: (reason: unknown) => void = () => {};
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.tail = this.tail
      .then(async () => {
        const outcome = work(structuredClone(this.document));
        await atomicWrite(
          tasksPath(),
          `${JSON.stringify(outcome.document, null, 2)}\n`,
        );
        this.document = outcome.document;
        resolveResult(outcome.result);
      })
      .catch((error: unknown) => {
        rejectResult(error);
      });
    return result;
  }
}

export async function appendEvent(event: BoardEvent): Promise<void> {
  try {
    await mkdir(dirname(eventsPath()), { recursive: true });
    await appendFile(eventsPath(), `${JSON.stringify(event)}\n`);
  } catch (error) {
    console.error("[agentstorm-task-board] cannot append event", error);
  }
}

export async function appendDeleted(event: BoardEvent): Promise<void> {
  try {
    await mkdir(dirname(deletedPath()), { recursive: true });
    await appendFile(deletedPath(), `${JSON.stringify(event)}\n`);
  } catch (error) {
    console.error(
      "[agentstorm-task-board] cannot append deletion audit",
      error,
    );
  }
}
