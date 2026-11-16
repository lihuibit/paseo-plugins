import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  BoardSettingsSchema,
  BoardSettingsPatchSchema,
  DEFAULT_BOARD_SETTINGS,
  type BoardSettings,
  type BoardSettingsPatch,
} from "../shared/settings";
import { settingsPath } from "./plugin-data";

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
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

export class BoardSettingsStore {
  private settings: BoardSettings = structuredClone(DEFAULT_BOARD_SETTINGS);
  private loaded = false;
  private tail: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await readJson(settingsPath());
    if (raw !== null) {
      const parsed = BoardSettingsSchema.safeParse(raw);
      if (parsed.success) {
        this.settings = parsed.data;
      } else {
        console.error(
          "[paseo-task-board] settings.json is invalid; using defaults",
          parsed.error,
        );
      }
    }
    this.loaded = true;
  }

  async read(): Promise<BoardSettings> {
    await this.load();
    return structuredClone(this.settings);
  }

  async update(patch: BoardSettingsPatch): Promise<BoardSettings> {
    await this.load();
    const validated = BoardSettingsPatchSchema.parse(patch);
    let resolveResult: (value: BoardSettings) => void = () => {};
    let rejectResult: (reason: unknown) => void = () => {};
    const result = new Promise<BoardSettings>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.tail = this.tail
      .then(async () => {
        const next = BoardSettingsSchema.parse({
          timezone:
            validated.timezone === null
              ? undefined
              : (validated.timezone ?? this.settings.timezone),
          wecom: { ...this.settings.wecom, ...validated.wecom },
          planningPrompt:
            validated.planningPrompt === null
              ? ""
              : (validated.planningPrompt ?? this.settings.planningPrompt),
        });
        await atomicWrite(settingsPath(), `${JSON.stringify(next, null, 2)}\n`);
        this.settings = next;
        resolveResult(structuredClone(next));
      })
      .catch((error: unknown) => {
        rejectResult(error);
      });
    return result;
  }
}
