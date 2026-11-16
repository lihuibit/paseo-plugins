import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PluginError } from "../shared/core/errors";
import {
  parseDocAssetId,
  parseKnowledgeAssetId,
  PROJECT_DIR,
} from "../shared/core/paths";
import { parseSkillFrontmatter } from "../shared/core/skill-markdown";
import { SKILL_ROOTS } from "../shared/core/providers";
import type {
  AssetKind,
  AssetRelationship,
  AssetRelationshipRow,
  AssetReadResult,
  AssetSummary,
  DriftItem,
  LocalAssetSummary,
  ProviderId,
  RelationshipListResult,
  SkillProjection,
  UnlinkResult,
} from "../shared/core/types";
import {
  baselineKey,
  readBaselines,
  recordBaselineFromFile,
  removeBaselinesFor,
} from "./baseline";
import {
  atomicWriteFile,
  copyDirectorySafe,
  directoryDigest,
  fileExists,
  resolveInside,
  scanFiles,
} from "./fs-utils";
import {
  removeInstructionProjections,
  adoptInstructions,
} from "./instructions";
import { readDriftIgnores } from "./ignore";
import { repoDir } from "./plugin-data";
import { readConfig, requireBinding, writeConfig } from "./registry";
import {
  readFileAsAsset,
  scanAllAssets,
  scanDocs,
  scanKnowledge,
  scanPrompt,
} from "./repo";
import { listDrift } from "./drift";

async function localFileSummary(
  assetId: string,
  kind: AssetKind,
  name: string,
  provider: ProviderId | null,
  path: string,
  description: string | null,
): Promise<LocalAssetSummary> {
  const file =
    kind === "skill" || kind === "doc"
      ? await directoryDigest(path).then((result) => result.files)
      : [{ path: name, size: (await lstat(path)).size }];
  return {
    assetId,
    kind,
    name,
    provider,
    path,
    description,
    fileCount: file.length,
    totalBytes: file.reduce((sum, entry) => sum + entry.size, 0),
    warnings: [],
  };
}

async function localSkills(
  workspaceDirectory: string,
  provider: ProviderId,
): Promise<LocalAssetSummary[]> {
  const root = SKILL_ROOTS[provider];
  if (!root) return [];
  const directory = join(workspaceDirectory, root);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: LocalAssetSummary[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    const skillFile = join(path, "SKILL.md");
    if (!(await fileExists(skillFile))) continue;
    const markdown = await readFile(skillFile, "utf8").catch(() => "");
    const frontmatter = parseSkillFrontmatter(markdown);
    skills.push(
      await localFileSummary(
        `local-skill:${provider}/${entry.name}`,
        "skill",
        entry.name,
        provider,
        path,
        frontmatter.description,
      ),
    );
  }
  return skills;
}

async function localPrompt(
  workspaceDirectory: string,
): Promise<LocalAssetSummary | null> {
  const path = join(workspaceDirectory, PROJECT_DIR, "AGENTS.md");
  if (!(await fileExists(path))) return null;
  return await localFileSummary(
    "local:prompt",
    "prompt",
    "AGENTS.md",
    null,
    path,
    null,
  );
}

async function localKnowledge(
  workspaceDirectory: string,
): Promise<LocalAssetSummary[]> {
  const directory = join(workspaceDirectory, PROJECT_DIR, "knowledge");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const assets: LocalAssetSummary[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const name = entry.name.slice(0, -3);
    assets.push(
      await localFileSummary(
        `local:knowledge/${name}`,
        "knowledge",
        name,
        null,
        join(directory, entry.name),
        null,
      ),
    );
  }
  return assets;
}

async function localDocs(
  workspaceDirectory: string,
): Promise<LocalAssetSummary[]> {
  const directory = join(workspaceDirectory, PROJECT_DIR, "docs");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const assets: LocalAssetSummary[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    assets.push(
      await localFileSummary(
        `local:doc/${entry.name}`,
        "doc",
        entry.name,
        null,
        path,
        null,
      ),
    );
  }
  return assets;
}

function sharedForKind(
  assets: AssetSummary[],
  kind: AssetKind,
): AssetSummary[] {
  return assets.filter((asset) => asset.kind === kind);
}

function tombstoneAsset(input: {
  assetId: string;
  kind: AssetKind;
  name: string;
  path: string;
  description: string | null;
}): AssetSummary {
  return {
    assetId: input.assetId,
    kind: input.kind,
    name: input.name,
    scope: "project",
    description: input.description,
    path: input.path,
    fileCount: 0,
    totalBytes: 0,
    files: [],
    warnings: [],
  };
}

function driftKey(assetId: string, provider: ProviderId | null): string {
  return `${assetId}\u0000${provider ?? ""}`;
}

function driftIndex(items: DriftItem[]): Map<string, DriftItem> {
  return new Map(
    items.map((item) => [driftKey(item.assetId, item.provider), item]),
  );
}

function relationship(
  shared: AssetSummary | null,
  local: LocalAssetSummary | null,
  linked: boolean,
): AssetRelationship {
  if (linked) return "linked";
  if (shared && local) return "candidate";
  if (shared) return "shared-only";
  return "private";
}

function rowFor(input: {
  shared: AssetSummary | null;
  local: LocalAssetSummary | null;
  linked: boolean;
  drift: DriftItem | null;
  conflict?: boolean;
}): AssetRelationshipRow {
  const assetId = input.shared?.assetId ?? input.local?.assetId ?? "unknown";
  return {
    id: `${assetId}\u0000${input.local?.assetId ?? ""}`,
    relationship: input.conflict
      ? "conflict"
      : relationship(input.shared, input.local, input.linked),
    shared: input.shared,
    local: input.local,
    syncStatus: input.drift?.status ?? null,
    driftFiles: input.drift
      ? input.drift.files.filter((file) => file.status !== "synced").length
      : 0,
  };
}

export async function listRelationships(input: {
  projectId: string;
  workspaceDirectory: string;
  kind: AssetKind;
  provider: ProviderId | null;
}): Promise<RelationshipListResult> {
  await requireBinding(input.projectId);
  const checkout = repoDir(input.projectId);
  const [assets, drift, config, ignored] = await Promise.all([
    scanAllAssets(checkout),
    listDrift(input.projectId, input.workspaceDirectory, true),
    readConfig(),
    readDriftIgnores(input.workspaceDirectory),
  ]);
  const driftItems = driftIndex(drift);
  const rows: AssetRelationshipRow[] = [];
  const warnings: string[] = [];

  if (input.kind === "skill") {
    const provider = input.provider ?? "codex";
    const sharedSkills = sharedForKind(assets, "skill");
    const locals = await localSkills(input.workspaceDirectory, provider);
    const records = (config.skills[input.projectId] ?? []).filter(
      (record) => record.provider === provider,
    );
    const tombstones = records
      .filter(
        (record) =>
          !sharedSkills.some((asset) => asset.assetId === record.assetId),
      )
      .map((record) => {
        const local = locals.find((asset) => asset.name === record.name);
        return tombstoneAsset({
          assetId: record.assetId,
          kind: "skill",
          name: record.name,
          path: `skills/project/${record.name}`,
          description: local?.description ?? null,
        });
      });
    const pool = [...sharedSkills, ...tombstones];
    const names = [
      ...new Set([
        ...pool.map((asset) => asset.name),
        ...locals.map((asset) => asset.name),
      ]),
    ].sort();
    for (const name of names) {
      const shared = pool.find((asset) => asset.name === name) ?? null;
      const local = locals.find((asset) => asset.name === name) ?? null;
      const record = shared
        ? records.find(
            (entry) =>
              entry.assetId === shared.assetId &&
              entry.provider === provider &&
              entry.targetPath.startsWith(input.workspaceDirectory),
          )
        : undefined;
      const occupied =
        shared && local
          ? records.find(
              (entry) =>
                entry.provider === provider &&
                entry.targetPath === local.path &&
                entry.assetId !== shared.assetId,
            )
          : undefined;
      rows.push(
        rowFor({
          shared,
          local,
          linked: record !== undefined,
          conflict: occupied !== undefined,
          drift: shared
            ? (driftItems.get(driftKey(shared.assetId, provider)) ?? null)
            : null,
        }),
      );
    }
  } else if (input.kind === "prompt") {
    const shared = await scanPrompt(checkout);
    const localPromptAsset = await localPrompt(input.workspaceDirectory);
    const local = localPromptAsset
      ? { ...localPromptAsset, provider: input.provider }
      : null;
    const stored = config.instructions[input.projectId];
    const baselines = await readBaselines(input.workspaceDirectory);
    const hasBaseline = Object.values(baselines.entries).some(
      (entry) => entry.assetId === "prompt",
    );
    const linked =
      (stored?.canonical !== null && stored?.canonical !== undefined) ||
      hasBaseline;
    const sharedAsset =
      shared ??
      (linked
        ? tombstoneAsset({
            assetId: "prompt",
            kind: "prompt",
            name: "AGENTS.md",
            path: "AGENTS.md",
            description: null,
          })
        : null);
    rows.push(
      rowFor({
        shared: sharedAsset,
        local,
        linked,
        drift: driftItems.get(driftKey("prompt", null)) ?? null,
      }),
    );
  } else if (input.kind === "knowledge") {
    const sharedAssets = sharedForKind(
      await scanKnowledge(checkout),
      "knowledge",
    );
    const locals = await localKnowledge(input.workspaceDirectory);
    const baselines = await readBaselines(input.workspaceDirectory);
    const tombstones = [
      ...new Map(
        Object.values(baselines.entries)
          .filter(
            (entry) =>
              entry.kind === "knowledge" &&
              !sharedAssets.some((asset) => asset.assetId === entry.assetId) &&
              parseKnowledgeAssetId(entry.assetId) !== null,
          )
          .map((entry) => {
            const name = parseKnowledgeAssetId(entry.assetId)!;
            return [
              entry.assetId,
              tombstoneAsset({
                assetId: entry.assetId,
                kind: "knowledge",
                name,
                path: `knowledge/${name}.md`,
                description: null,
              }),
            ] as const;
          }),
      ).values(),
    ];
    const pool = [...sharedAssets, ...tombstones];
    const names = [
      ...new Set([
        ...pool.map((asset) => asset.name),
        ...locals.map((asset) => asset.name),
      ]),
    ].sort();
    for (const name of names) {
      const shared = pool.find((asset) => asset.name === name) ?? null;
      const local = locals.find((asset) => asset.name === name) ?? null;
      const assetId = shared?.assetId ?? `knowledge/${name}.md`;
      const linked =
        baselines.entries[baselineKey(assetId, null, `${name}.md`)] !==
        undefined;
      rows.push(
        rowFor({
          shared,
          local,
          linked,
          drift: driftItems.get(driftKey(assetId, null)) ?? null,
        }),
      );
    }
  } else {
    const sharedAssets = sharedForKind(await scanDocs(checkout), "doc");
    const locals = await localDocs(input.workspaceDirectory);
    const baselines = await readBaselines(input.workspaceDirectory);
    const tombstones = [
      ...new Map(
        Object.values(baselines.entries)
          .filter(
            (entry) =>
              entry.kind === "doc" &&
              !sharedAssets.some((asset) => asset.assetId === entry.assetId) &&
              parseDocAssetId(entry.assetId) !== null,
          )
          .map((entry) => {
            const name = parseDocAssetId(entry.assetId)!;
            return [
              entry.assetId,
              tombstoneAsset({
                assetId: entry.assetId,
                kind: "doc",
                name,
                path: `docs/${name}`,
                description: null,
              }),
            ] as const;
          }),
      ).values(),
    ];
    const pool = [...sharedAssets, ...tombstones];
    const names = [
      ...new Set([
        ...pool.map((asset) => asset.name),
        ...locals.map((asset) => asset.name),
      ]),
    ].sort();
    for (const name of names) {
      const shared = pool.find((asset) => asset.name === name) ?? null;
      const local = locals.find((asset) => asset.name === name) ?? null;
      const assetId = `doc/${name}`;
      const linked = Object.values(baselines.entries).some(
        (entry) =>
          entry.assetId === assetId &&
          entry.provider === null &&
          entry.path.length > 0,
      );
      rows.push(
        rowFor({
          shared,
          local,
          linked,
          drift: driftItems.get(driftKey(assetId, null)) ?? null,
        }),
      );
    }
  }

  return {
    kind: input.kind,
    provider: input.provider,
    rows,
    ignored,
    warnings,
  };
}

async function copySharedToLocal(
  shared: AssetSummary,
  checkout: string,
  local: LocalAssetSummary,
): Promise<void> {
  const source = join(checkout, shared.path);
  if (shared.kind === "skill" || shared.kind === "doc") {
    await copyDirectorySafe(source, local.path);
    return;
  }
  const content = await readFile(source);
  await rm(local.path, { force: true });
  await atomicWriteFile(local.path, content);
}

async function recordSharedBaseline(input: {
  workspaceDirectory: string;
  assetId: string;
  kind: AssetKind;
  provider: ProviderId | null;
  relativePath: string;
  sharedPath: string;
}): Promise<void> {
  await recordBaselineFromFile({
    workspaceDirectory: input.workspaceDirectory,
    assetId: input.assetId,
    kind: input.kind,
    provider: input.provider,
    relativePath: input.relativePath,
    sourcePath: input.sharedPath,
  });
}

export async function readLocalAsset(input: {
  workspaceDirectory: string;
  kind: AssetKind;
  provider: ProviderId | null;
  localAssetId: string;
  path?: string;
}): Promise<AssetReadResult> {
  const workspace = input.workspaceDirectory;
  let localRoot: string;
  let relativePath: string;

  if (input.kind === "prompt") {
    localRoot = join(workspace, PROJECT_DIR);
    relativePath = "AGENTS.md";
  } else if (input.kind === "knowledge") {
    const name = /^local:knowledge\/([^/]+)$/.exec(input.localAssetId)?.[1];
    if (!name) {
      throw new PluginError(
        "E_ASSET_NOT_FOUND",
        `Unknown local knowledge asset: ${input.localAssetId}`,
      );
    }
    localRoot = join(workspace, PROJECT_DIR, "knowledge");
    relativePath = `${name}.md`;
  } else if (input.kind === "doc") {
    const name = parseDocAssetId(input.localAssetId.replace(/^local:/, ""));
    if (!name) {
      throw new PluginError(
        "E_ASSET_NOT_FOUND",
        `Unknown local document asset: ${input.localAssetId}`,
      );
    }
    localRoot = join(workspace, PROJECT_DIR, "docs", name);
    relativePath = input.path ?? (await firstFile(localRoot));
  } else {
    const match = /^local-skill:([^/]+)\/([^/]+)$/.exec(input.localAssetId);
    const provider = (input.provider ?? match?.[1] ?? "codex") as ProviderId;
    const name = match?.[2];
    const skillRoot = SKILL_ROOTS[provider];
    if (!name || !skillRoot) {
      throw new PluginError(
        "E_ASSET_NOT_FOUND",
        `Unknown local Skill asset: ${input.localAssetId}`,
      );
    }
    localRoot = join(workspace, skillRoot, name);
    relativePath = input.path ?? (await firstFile(localRoot));
  }

  const absolute = await resolveInside(
    workspace,
    join(localRoot, relativePath),
  );
  return await readFileAsAsset(input.localAssetId, relativePath, absolute);
}

async function firstFile(root: string): Promise<string> {
  const files = await scanFiles(root).catch(() => []);
  if (files.length === 0) {
    throw new PluginError(
      "E_ASSET_NOT_FOUND",
      `No files found in local asset: ${root}`,
    );
  }
  return files.find((file) => file.path === "SKILL.md")?.path ?? files[0]!.path;
}

export async function adoptRelationship(input: {
  projectId: string;
  workspaceDirectory: string;
  kind: AssetKind;
  provider: ProviderId | null;
  assetId: string;
  localAssetId: string;
  mode: "preserve-local" | "use-remote";
}): Promise<{ assetId: string; mode: "preserve-local" | "use-remote" }> {
  const listing = await listRelationships({
    projectId: input.projectId,
    workspaceDirectory: input.workspaceDirectory,
    kind: input.kind,
    provider: input.provider,
  });
  const row = listing.rows.find(
    (entry) =>
      entry.shared?.assetId === input.assetId &&
      entry.local?.assetId === input.localAssetId,
  );
  if (!row?.shared || !row.local) {
    throw new PluginError(
      "E_ASSET_NOT_FOUND",
      "The local and shared assets must both exist before they can be associated",
    );
  }
  if (row.relationship === "linked") {
    return { assetId: input.assetId, mode: input.mode };
  }
  if (row.relationship === "conflict") {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      "This local asset is already associated with a different shared asset",
    );
  }
  if (row.shared.name !== row.local.name) {
    throw new PluginError(
      "E_VALIDATION_FAILED",
      "Only identically named local and shared assets can be associated",
    );
  }

  const checkout = repoDir(input.projectId);
  const sharedPath = join(checkout, row.shared.path);

  if (input.kind === "skill") {
    const provider = input.provider ?? "codex";
    if (input.mode === "use-remote") {
      await copySharedToLocal(row.shared, checkout, row.local);
    }
    const digest = (await directoryDigest(sharedPath)).digest;
    const config = await readConfig();
    const records = (config.skills[input.projectId] ??= []);
    const conflicting = records.find(
      (entry) =>
        (entry.assetId === input.assetId && entry.provider === provider) ||
        (entry.targetPath === row.local!.path && entry.provider === provider),
    );
    if (conflicting) {
      throw new PluginError(
        "E_VALIDATION_FAILED",
        "This local or shared Skill is already associated",
      );
    }
    const projection: SkillProjection = {
      assetId: input.assetId,
      name: row.shared.name,
      provider,
      targetPath: row.local.path,
      baselineDigest: digest,
      updatedAt: new Date().toISOString(),
    };
    records.push(projection);
    await writeConfig(config);
    const files = await scanFiles(sharedPath);
    for (const file of files) {
      await recordSharedBaseline({
        workspaceDirectory: input.workspaceDirectory,
        assetId: input.assetId,
        kind: "skill",
        provider,
        relativePath: file.path,
        sharedPath: join(sharedPath, file.path),
      });
    }
  } else if (input.kind === "prompt") {
    await adoptInstructions({
      projectId: input.projectId,
      workspaceDirectory: input.workspaceDirectory,
      provider: input.provider ?? "both",
      mode: input.mode,
    });
  } else if (input.kind === "knowledge") {
    if (input.mode === "use-remote") {
      await copySharedToLocal(row.shared, checkout, row.local);
    }
    await recordSharedBaseline({
      workspaceDirectory: input.workspaceDirectory,
      assetId: input.assetId,
      kind: "knowledge",
      provider: null,
      relativePath: `${row.shared.name}.md`,
      sharedPath,
    });
  } else {
    if (input.mode === "use-remote") {
      await copySharedToLocal(row.shared, checkout, row.local);
    }
    const files = await scanFiles(sharedPath);
    for (const file of files) {
      await recordSharedBaseline({
        workspaceDirectory: input.workspaceDirectory,
        assetId: input.assetId,
        kind: "doc",
        provider: null,
        relativePath: file.path,
        sharedPath: join(sharedPath, file.path),
      });
    }
  }
  return { assetId: input.assetId, mode: input.mode };
}

async function removeLocalPath(
  workspaceDirectory: string,
  target: string,
): Promise<void> {
  await resolveInside(workspaceDirectory, target);
  await rm(target, { recursive: true, force: true });
}

async function removeBaselines(input: {
  workspaceDirectory: string;
  assetId: string;
  provider: ProviderId | null;
}): Promise<void> {
  await removeBaselinesFor({
    workspaceDirectory: input.workspaceDirectory,
    assetId: input.assetId,
    provider: input.provider,
  });
}

export async function unlinkRelationship(input: {
  projectId: string;
  workspaceDirectory: string;
  kind: AssetKind;
  provider: ProviderId | null;
  assetId: string;
  deleteLocal: boolean;
}): Promise<UnlinkResult> {
  const deleted: string[] = [];
  const kept: string[] = [];
  let hadLocalChanges = false;
  const config = await readConfig();

  if (input.kind === "skill") {
    const records = (config.skills[input.projectId] ?? []).filter(
      (entry) =>
        entry.assetId === input.assetId &&
        (input.provider === null || entry.provider === input.provider),
    );
    if (records.length === 0) {
      throw new PluginError(
        "E_NOT_CONFIGURED",
        "This Skill is not associated with the project",
      );
    }
    const remaining = (config.skills[input.projectId] ?? []).filter(
      (entry) => !records.includes(entry),
    );
    config.skills[input.projectId] = remaining;
    for (const record of records) {
      if (!(await fileExists(record.targetPath))) continue;
      const digest = await directoryDigest(record.targetPath).catch(() => null);
      if (digest && digest.digest !== record.baselineDigest) {
        hadLocalChanges = true;
      }
      if (input.deleteLocal) {
        await removeLocalPath(input.workspaceDirectory, record.targetPath);
        deleted.push(record.targetPath);
      } else {
        kept.push(record.targetPath);
      }
      await removeBaselines({
        workspaceDirectory: input.workspaceDirectory,
        assetId: input.assetId,
        provider: record.provider,
      });
    }
  } else if (input.kind === "prompt") {
    const stored = config.instructions[input.projectId];
    if (!stored) {
      throw new PluginError(
        "E_NOT_CONFIGURED",
        "Shared instructions are not associated with the project",
      );
    }
    const canonicalPath = stored.canonical?.targetPath ?? null;
    const result = await removeInstructionProjections(
      input.projectId,
      input.workspaceDirectory,
    );
    delete config.instructions[input.projectId];
    deleted.push(...result.removed);
    kept.push(...result.preserved);
    if (canonicalPath) {
      if (input.deleteLocal) {
        if (await fileExists(canonicalPath)) {
          await removeLocalPath(input.workspaceDirectory, canonicalPath);
          deleted.push(canonicalPath);
        }
      } else {
        kept.push(canonicalPath);
      }
    }
    await removeBaselines({
      workspaceDirectory: input.workspaceDirectory,
      assetId: "prompt",
      provider: null,
    });
  } else {
    const baselines = await readBaselines(input.workspaceDirectory);
    const entries = Object.values(baselines.entries).filter(
      (entry) => entry.assetId === input.assetId,
    );
    if (entries.length === 0) {
      throw new PluginError(
        "E_NOT_CONFIGURED",
        "This asset is not associated with the project",
      );
    }
    const localRoot =
      input.kind === "knowledge"
        ? join(input.workspaceDirectory, PROJECT_DIR, "knowledge")
        : join(
            input.workspaceDirectory,
            PROJECT_DIR,
            "docs",
            input.assetId.replace(/^doc\//, ""),
          );
    if (input.deleteLocal) {
      if (input.kind === "knowledge") {
        const name = input.assetId
          .replace(/^knowledge\//, "")
          .replace(/\.md$/, "");
        const target = join(localRoot, `${name}.md`);
        if (await fileExists(target)) {
          await removeLocalPath(input.workspaceDirectory, target);
          deleted.push(target);
        }
      } else if (await fileExists(localRoot)) {
        await removeLocalPath(input.workspaceDirectory, localRoot);
        deleted.push(localRoot);
      }
    } else {
      kept.push(localRoot);
    }
    for (const entry of entries) {
      await removeBaselines({
        workspaceDirectory: input.workspaceDirectory,
        assetId: entry.assetId,
        provider: entry.provider,
      });
    }
  }

  await writeConfig(config);
  return { assetId: input.assetId, deleted, kept, hadLocalChanges };
}
