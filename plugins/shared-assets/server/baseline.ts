import { readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AssetKind, ProviderId } from "../shared/core/types";
import { atomicWriteFile, readJson, sha256 } from "./fs-utils";
import { pluginDataDir } from "./plugin-data";

export interface BaselineEntry {
  assetId: string;
  kind: AssetKind;
  path: string;
  provider: ProviderId | null;
  digest: string;
  content: string | null;
  updatedAt: string;
}

export interface ScopeBaselines {
  version: 1;
  scopeId: string;
  workspaceDirectory: string;
  entries: Record<string, BaselineEntry>;
}

export function baselineKey(
  assetId: string,
  provider: ProviderId | null,
  path: string,
): string {
  return `${assetId}\u0000${provider ?? ""}\u0000${path}`;
}

export async function scopeIdFor(directory: string): Promise<string> {
  const resolved = await realpath(directory).catch(() => directory);
  return sha256(resolved);
}

function baselinesPath(scopeId: string): string {
  return join(pluginDataDir(), "projections", scopeId, "baselines.json");
}

export async function readBaselines(
  workspaceDirectory: string,
): Promise<ScopeBaselines> {
  const scopeId = await scopeIdFor(workspaceDirectory);
  const stored = await readJson<ScopeBaselines>(baselinesPath(scopeId));
  return {
    version: 1,
    scopeId,
    workspaceDirectory,
    entries: stored?.entries ?? {},
  };
}

export async function writeBaselines(
  workspaceDirectory: string,
  baselines: ScopeBaselines,
): Promise<void> {
  await atomicWriteFile(
    baselinesPath(baselines.scopeId),
    `${JSON.stringify(baselines, null, 2)}\n`,
  );
}

/** Drops every recorded baseline for one workspace (rebind or unbind). */
export async function clearBaselines(
  workspaceDirectory: string,
): Promise<void> {
  const scopeId = await scopeIdFor(workspaceDirectory);
  await rm(join(pluginDataDir(), "projections", scopeId), {
    recursive: true,
    force: true,
  });
}

export function findBaseline(
  baselines: ScopeBaselines,
  assetId: string,
  provider: ProviderId | null,
  path: string,
): BaselineEntry | null {
  return baselines.entries[baselineKey(assetId, provider, path)] ?? null;
}

/** Reads a text file and returns null for missing, oversized or binary files. */
export async function readTextFile(
  path: string,
  limit = 1024 * 1024,
): Promise<string | null> {
  try {
    const buffer = await readFile(path);
    if (buffer.length > limit || buffer.subarray(0, 8192).includes(0)) {
      return null;
    }
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

export function textDigest(content: string | null): string | null {
  return content === null ? null : sha256(content);
}

export async function recordBaselineFromFile(input: {
  workspaceDirectory: string;
  assetId: string;
  kind: AssetKind;
  provider: ProviderId | null;
  relativePath: string;
  sourcePath: string;
}): Promise<void> {
  const buffer = await readFile(input.sourcePath);
  const text =
    buffer.length <= 1024 * 1024 && !buffer.subarray(0, 8192).includes(0)
      ? buffer.toString("utf8")
      : null;
  const baselines = await readBaselines(input.workspaceDirectory);
  baselines.entries[
    baselineKey(input.assetId, input.provider, input.relativePath)
  ] = {
    assetId: input.assetId,
    kind: input.kind,
    path: input.relativePath,
    provider: input.provider,
    digest: sha256(buffer),
    content: text,
    updatedAt: new Date().toISOString(),
  };
  await writeBaselines(input.workspaceDirectory, baselines);
}

export async function removeBaselinesFor(input: {
  workspaceDirectory: string;
  assetId: string;
  provider: ProviderId | null;
}): Promise<void> {
  const baselines = await readBaselines(input.workspaceDirectory);
  for (const [key, entry] of Object.entries(baselines.entries)) {
    if (entry.assetId === input.assetId && entry.provider === input.provider) {
      delete baselines.entries[key];
    }
  }
  await writeBaselines(input.workspaceDirectory, baselines);
}
