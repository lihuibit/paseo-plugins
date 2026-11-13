import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { isContainedPath } from "../shared/core/paths";

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 40 * 1024 * 1024;
export const MAX_PACKAGE_FILES = 2000;

export interface ScannedFile {
  path: string;
  size: number;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function atomicWriteFile(
  path: string,
  content: string | Buffer,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Lists regular files below `root`. Symlinks are rejected, not followed, and
 * the package limits stop a hostile repository from exhausting the daemon.
 */
export async function scanFiles(
  root: string,
  options: { maxFiles?: number; maxBytes?: number; maxFileBytes?: number } = {},
): Promise<ScannedFile[]> {
  const maxFiles = options.maxFiles ?? MAX_PACKAGE_FILES;
  const maxBytes = options.maxBytes ?? MAX_PACKAGE_BYTES;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const files: ScannedFile[] = [];
  let total = 0;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`symlink is not allowed: ${relative(root, absolute)}`);
      }
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(absolute);
      if (info.size > maxFileBytes) {
        throw new Error(
          `file exceeds ${maxFileBytes} bytes: ${relative(root, absolute)}`,
        );
      }
      total += info.size;
      if (total > maxBytes)
        throw new Error(`package exceeds ${maxBytes} bytes`);
      files.push({
        path: relative(root, absolute).split("\\").join("/"),
        size: info.size,
      });
      if (files.length > maxFiles)
        throw new Error(`package exceeds ${maxFiles} files`);
    }
  }

  await walk(root);
  return files;
}

export async function directoryDigest(
  root: string,
): Promise<{ digest: string; files: ScannedFile[] }> {
  const files = await scanFiles(root);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.path}\0${file.size}\0`);
    hash.update(await readFile(join(root, file.path)));
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), files };
}

/** Copies a directory after validating that every entry is a regular file. */
export async function copyDirectorySafe(
  source: string,
  target: string,
): Promise<void> {
  const files = await scanFiles(source);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporary, { recursive: true, force: true });
  for (const file of files) {
    const destination = join(temporary, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(join(source, file.path)));
  }
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await rename(temporary, target);
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * Resolves `target` and refuses anything that leaves `root` once symlinks are
 * expanded. Missing targets resolve through their nearest existing parent.
 */
export async function resolveInside(
  root: string,
  target: string,
): Promise<string> {
  const canonicalRoot = await realpath(root);
  let candidate = target;
  for (;;) {
    try {
      const resolved = await realpath(candidate);
      if (!isContainedPath(canonicalRoot, resolved)) {
        throw new Error(`path escapes the workspace: ${target}`);
      }
      return resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  throw new Error(`cannot resolve path: ${target}`);
}

export async function readFileLimited(
  path: string,
  limit = MAX_FILE_BYTES,
): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`not a regular file: ${path}`);
  if (info.size > limit)
    throw new Error(`file exceeds ${limit} bytes: ${path}`);
  return readFile(path);
}
