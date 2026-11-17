import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AssetKind,
  DriftIgnoreEntry,
  IgnoreRulesResult,
} from "../shared/core/types";
import {
  formatIgnoreRules,
  matchesFileIgnoreRules,
  matchesIgnoreRules,
  parseIgnoreRules,
  type IgnoreRule,
} from "../shared/core/ignore";
import { atomicWriteFile, readJson } from "./fs-utils";
import { assertGitIdentity, headRevision, runGit } from "./git";
import { repoDir } from "./plugin-data";

export const IGNORE_RULES_FILE = "ignore-rules";
export const DRIFT_IGNORES_FILE = "shared-library-ignores.json";

export async function readSharedIgnoreRules(
  projectId: string,
): Promise<IgnoreRulesResult> {
  let raw = "";
  try {
    raw = await readFile(join(repoDir(projectId), IGNORE_RULES_FILE), "utf8");
  } catch {
    raw = "";
  }
  const parsed = parseIgnoreRules(raw);
  return { raw, rules: parsed.rules, errors: parsed.errors };
}

export async function writeSharedIgnoreRules(
  projectId: string,
  raw: string,
  message?: string,
): Promise<IgnoreRulesResult & { commit: string | null }> {
  const parsed = parseIgnoreRules(raw);
  if (parsed.errors.length > 0) {
    return {
      raw,
      rules: parsed.rules,
      errors: parsed.errors,
      commit: null,
    };
  }
  const checkout = repoDir(projectId);
  const path = join(checkout, IGNORE_RULES_FILE);
  await atomicWriteFile(path, formatIgnoreRules(parsed.rules));
  let commit: string | null = null;
  const status = await runGit(checkout, [
    "status",
    "--porcelain",
    "--",
    IGNORE_RULES_FILE,
  ]);
  if (status.stdout.trim()) {
    await assertGitIdentity(checkout);
    await runGit(checkout, ["add", "--", IGNORE_RULES_FILE]);
    const result = await runGit(
      checkout,
      [
        "commit",
        "--quiet",
        "-m",
        message ?? "chore(shared-assets): update ignore rules",
        "--",
        IGNORE_RULES_FILE,
      ],
      { allowFailure: true },
    );
    if (result.code !== 0) {
      await runGit(checkout, ["reset", "--quiet", "--", IGNORE_RULES_FILE], {
        allowFailure: true,
      });
      throw new Error(`git commit failed: ${result.stderr}`);
    }
    commit = await headRevision(checkout);
  }
  return {
    raw: formatIgnoreRules(parsed.rules),
    rules: parsed.rules,
    errors: [],
    commit,
  };
}

export async function readDriftIgnores(
  workspaceDirectory: string,
): Promise<DriftIgnoreEntry[]> {
  const stored = await readJson<{ entries?: DriftIgnoreEntry[] }>(
    join(workspaceDirectory, DRIFT_IGNORES_FILE),
  ).catch(() => null);
  return Array.isArray(stored?.entries) ? stored.entries : [];
}

export async function writeDriftIgnores(
  workspaceDirectory: string,
  entries: DriftIgnoreEntry[],
): Promise<void> {
  await atomicWriteFile(
    join(workspaceDirectory, DRIFT_IGNORES_FILE),
    `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
  );
}

export function isDriftIgnored(
  assetId: string,
  path: string,
  entries: DriftIgnoreEntry[],
): boolean {
  return entries.some(
    (entry) =>
      entry.assetId === assetId && (entry.path === null || entry.path === path),
  );
}

export function isRuleIgnored(
  asset: { assetId: string; kind: AssetKind; path: string },
  rules: IgnoreRule[],
): boolean {
  return matchesIgnoreRules(asset, rules);
}

/**
 * Whether one file inside an asset is hidden by the shared ignore rules.
 *
 * The file is matched both relative to its asset root (the anchor users see in
 * the UI) and by its repository path, so existing rules such as `path:*.pyc`
 * keep working without a migration.
 */
export function isFileIgnored(
  asset: { assetId: string; kind: AssetKind; path: string },
  relativePath: string,
  rules: IgnoreRule[],
): boolean {
  const relative = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!relative) return false;
  const assetPath = asset.path.replace(/\\/g, "/").replace(/^\/+/, "");
  const candidates = [relative];
  if (
    assetPath &&
    relative !== assetPath &&
    !relative.startsWith(`${assetPath}/`)
  ) {
    candidates.push(`${assetPath}/${relative}`);
  }
  return matchesFileIgnoreRules(candidates, rules);
}
