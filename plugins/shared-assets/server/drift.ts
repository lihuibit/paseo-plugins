import { readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type {
  AssetKind,
  AssetSummary,
  DriftFileStatus,
  DriftItem,
  DriftStatus,
  ProviderId,
} from "../shared/core/types";
import {
  parseDocAssetId,
  parseKnowledgeAssetId,
  parseSkillAssetId,
  PROJECT_DIR,
} from "../shared/core/paths";
import { SKILL_ROOTS } from "../shared/core/providers";
import { readBaselines, type ScopeBaselines } from "./baseline";
import { fileExists, scanFiles, sha256 } from "./fs-utils";
import {
  isDriftIgnored,
  isFileIgnored,
  isRuleIgnored,
  readDriftIgnores,
  readSharedIgnoreRules,
} from "./ignore";
import type { IgnoreRule } from "../shared/core/ignore";
import { readConfig } from "./registry";
import { repoDir } from "./plugin-data";
import { scanAllAssets } from "./repo";

const STATUS_ORDER: DriftStatus[] = [
  "diverged",
  "remote-deleted",
  "local-update",
  "remote-update",
  "unpublished-local",
  "missing",
  "synced",
];

/**
 * Drift the user still has to act on.
 *
 * The legacy shared-assets `isDriftedSyncStatus` is the reference: a `synced`
 * copy needs no reminder, and a `missing` one is not an actionable difference
 * either. Local assets the shared library has never seen are kept because
 * publishing them is the user's next step.
 */
const ATTENTION_STATUSES: ReadonlySet<DriftStatus> = new Set([
  "local-update",
  "remote-update",
  "diverged",
  "remote-deleted",
  "unpublished-local",
]);

export function needsAttention(status: DriftStatus): boolean {
  return ATTENTION_STATUSES.has(status);
}

async function fileDigest(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path));
  } catch {
    return null;
  }
}

async function relativeFiles(
  root: string,
  asset: { assetId: string; kind: AssetKind; path: string },
  rules: IgnoreRule[],
): Promise<string[]> {
  if (!(await fileExists(root))) return [];
  try {
    return (
      await scanFiles(root, {
        isIgnored: (entry) => isFileIgnored(asset, entry, rules),
      })
    ).map((file) => file.path);
  } catch {
    return [];
  }
}

function statusOf(
  base: string | null,
  local: string | null,
  remote: string | null,
): DriftStatus {
  if (base === null) {
    if (local === null) return remote === null ? "synced" : "missing";
    if (remote === null) return "unpublished-local";
    return local === remote ? "synced" : "local-update";
  }
  if (local === null && remote === null) return "missing";
  if (local === null) return remote === base ? "missing" : "remote-update";
  if (remote === null) return local === base ? "remote-deleted" : "diverged";
  if (local === base && remote === base) return "synced";
  if (local !== base && remote === base) return "local-update";
  if (local === base && remote !== base) return "remote-update";
  return local === remote ? "synced" : "diverged";
}

function aggregate(statuses: DriftStatus[]): DriftStatus {
  for (const status of STATUS_ORDER) {
    if (statuses.includes(status)) return status;
  }
  return "synced";
}

interface FileInput {
  relativePath: string;
  repositoryPath: string;
  localPath: string;
  remotePath: string;
}

async function buildFileStatuses(
  files: FileInput[],
  baselines: ScopeBaselines,
  assetId: string,
  provider: ProviderId | null,
): Promise<DriftFileStatus[]> {
  const statuses: DriftFileStatus[] = [];
  for (const file of files) {
    const base =
      baselines.entries[
        `${assetId}\u0000${provider ?? ""}\u0000${file.relativePath}`
      ];
    const [local, remote] = await Promise.all([
      fileDigest(file.localPath),
      fileDigest(file.remotePath),
    ]);
    statuses.push({
      path: file.relativePath,
      repositoryPath: file.repositoryPath,
      status: statusOf(base?.digest ?? null, local, remote),
      baseDigest: base?.digest ?? null,
      localDigest: local,
      remoteDigest: remote,
    });
  }
  return statuses;
}

function item(
  partial: Omit<DriftItem, "status" | "ignored" | "files">,
  files: DriftFileStatus[],
): Omit<DriftItem, "ignored"> {
  return {
    ...partial,
    status: aggregate(files.map((file) => file.status)),
    files,
  };
}

async function promptItem(
  workspaceDirectory: string,
  checkout: string,
  baselines: ScopeBaselines,
  rules: IgnoreRule[],
): Promise<Omit<DriftItem, "ignored"> | null> {
  const localPath = join(workspaceDirectory, PROJECT_DIR, "AGENTS.md");
  const hasBaseline = Object.values(baselines.entries).some(
    (entry) => entry.assetId === "prompt",
  );
  if (!hasBaseline && !(await fileExists(localPath))) return null;
  if (
    isFileIgnored(
      { assetId: "prompt", kind: "prompt", path: "AGENTS.md" },
      "AGENTS.md",
      rules,
    )
  ) {
    return null;
  }
  const files = await buildFileStatuses(
    [
      {
        relativePath: "AGENTS.md",
        repositoryPath: "AGENTS.md",
        localPath,
        remotePath: join(checkout, "AGENTS.md"),
      },
    ],
    baselines,
    "prompt",
    null,
  );
  return item(
    {
      assetId: "prompt",
      kind: "prompt",
      name: "AGENTS.md",
      scope: null,
      provider: null,
      targetPath: localPath,
    },
    files,
  );
}

function remoteAssetMap(assets: AssetSummary[]): Map<string, AssetSummary> {
  return new Map(assets.map((asset) => [asset.assetId, asset]));
}

async function knowledgeItems(
  checkout: string,
  workspaceDirectory: string,
  baselines: ScopeBaselines,
  assets: AssetSummary[],
  rules: IgnoreRule[],
): Promise<Array<Omit<DriftItem, "ignored">>> {
  const names = new Set<string>();
  for (const asset of assets) {
    if (asset.kind !== "knowledge") continue;
    const name = parseKnowledgeAssetId(asset.assetId);
    if (name) names.add(name);
  }
  const localRoot = join(workspaceDirectory, PROJECT_DIR, "knowledge");
  try {
    for (const entry of await readdir(localRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        names.add(entry.name.slice(0, -3));
      }
    }
  } catch {
    // No local copies yet.
  }
  for (const entry of Object.values(baselines.entries)) {
    if (entry.kind !== "knowledge") continue;
    const name = parseKnowledgeAssetId(entry.assetId);
    if (name) names.add(name);
  }

  const items: Array<Omit<DriftItem, "ignored">> = [];
  for (const name of [...names].sort()) {
    const assetId = `knowledge/${name}.md`;
    if (
      isFileIgnored(
        { assetId, kind: "knowledge", path: assetId },
        `${name}.md`,
        rules,
      )
    ) {
      continue;
    }
    const files = await buildFileStatuses(
      [
        {
          relativePath: `${name}.md`,
          repositoryPath: `knowledge/${name}.md`,
          localPath: join(localRoot, `${name}.md`),
          remotePath: join(checkout, "knowledge", `${name}.md`),
        },
      ],
      baselines,
      assetId,
      null,
    );
    items.push(
      item(
        {
          assetId,
          kind: "knowledge",
          name,
          scope: null,
          provider: null,
          targetPath: join(localRoot, `${name}.md`),
        },
        files,
      ),
    );
  }
  return items;
}

async function docItems(
  checkout: string,
  workspaceDirectory: string,
  baselines: ScopeBaselines,
  assets: AssetSummary[],
  rules: IgnoreRule[],
): Promise<Array<Omit<DriftItem, "ignored">>> {
  const names = new Set<string>();
  for (const asset of assets) {
    if (asset.kind !== "doc") continue;
    const name = parseDocAssetId(asset.assetId);
    if (name) names.add(name);
  }
  const localRoot = join(workspaceDirectory, PROJECT_DIR, "docs");
  try {
    for (const entry of await readdir(localRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name);
    }
  } catch {
    // No local copies yet.
  }
  for (const entry of Object.values(baselines.entries)) {
    if (entry.kind !== "doc") continue;
    const name = parseDocAssetId(entry.assetId);
    if (name) names.add(name);
  }

  const items: Array<Omit<DriftItem, "ignored">> = [];
  for (const name of [...names].sort()) {
    const remoteRoot = join(checkout, "docs", name);
    const localDocRoot = join(localRoot, name);
    const assetPath = `docs/${name}`;
    const relatives = [
      ...new Set([
        ...(await relativeFiles(
          remoteRoot,
          { assetId: `doc/${name}`, kind: "doc", path: assetPath },
          rules,
        )),
        ...(await relativeFiles(
          localDocRoot,
          { assetId: `doc/${name}`, kind: "doc", path: assetPath },
          rules,
        )),
      ]),
    ].sort();
    const files = await buildFileStatuses(
      relatives.map((entry) => ({
        relativePath: entry,
        repositoryPath: `${assetPath}/${entry}`,
        localPath: join(localDocRoot, entry),
        remotePath: join(remoteRoot, entry),
      })),
      baselines,
      `doc/${name}`,
      null,
    );
    items.push(
      item(
        {
          assetId: `doc/${name}`,
          kind: "doc",
          name,
          scope: null,
          provider: null,
          targetPath: localDocRoot,
        },
        files,
      ),
    );
  }
  return items;
}

async function skillItems(
  projectId: string,
  workspaceDirectory: string,
  checkout: string,
  baselines: ScopeBaselines,
  assets: AssetSummary[],
  rules: IgnoreRule[],
): Promise<Array<Omit<DriftItem, "ignored">>> {
  const config = await readConfig();
  const records = (config.skills[projectId] ?? []).filter((record) =>
    record.targetPath.startsWith(workspaceDirectory),
  );
  const groups = new Map<
    string,
    { assetId: string; provider: ProviderId; targetPath: string }
  >();
  for (const record of records) {
    groups.set(`${record.assetId}\u0000${record.provider}`, {
      assetId: record.assetId,
      provider: record.provider,
      targetPath: record.targetPath,
    });
  }
  for (const entry of Object.values(baselines.entries)) {
    if (entry.kind !== "skill" || !entry.provider) continue;
    const key = `${entry.assetId}\u0000${entry.provider}`;
    if (groups.has(key)) continue;
    const parsed = parseSkillAssetId(entry.assetId);
    if (!parsed) continue;
    const skillRoot = SKILL_ROOTS[entry.provider];
    if (!skillRoot) continue;
    groups.set(key, {
      assetId: entry.assetId,
      provider: entry.provider,
      targetPath: join(workspaceDirectory, skillRoot, parsed.name),
    });
  }

  const assetsById = remoteAssetMap(assets);
  const items: Array<Omit<DriftItem, "ignored">> = [];
  for (const group of [...groups.values()].sort((a, b) =>
    `${a.assetId}/${a.provider}`.localeCompare(`${b.assetId}/${b.provider}`),
  )) {
    const parsed = parseSkillAssetId(group.assetId);
    if (!parsed) continue;
    const asset = assetsById.get(group.assetId);
    const assetPath = `skills/${parsed.scope}/${parsed.name}`;
    const repositoryRoot = join(checkout, "skills", parsed.scope, parsed.name);
    const localRoot = group.targetPath;
    const assetRef = {
      assetId: group.assetId,
      kind: "skill" as const,
      path: assetPath,
    };
    const relatives = [
      ...new Set([
        ...(await relativeFiles(repositoryRoot, assetRef, rules)),
        ...(await relativeFiles(localRoot, assetRef, rules)),
      ]),
    ].sort();
    const files = await buildFileStatuses(
      relatives.map((entry) => ({
        relativePath: entry,
        repositoryPath: `${assetPath}/${entry}`,
        localPath: join(localRoot, entry),
        remotePath: join(repositoryRoot, entry),
      })),
      baselines,
      group.assetId,
      group.provider,
    );
    items.push(
      item(
        {
          assetId: group.assetId,
          kind: "skill",
          name: parsed.name,
          scope: parsed.scope,
          provider: group.provider,
          targetPath: group.targetPath,
        },
        files,
      ),
    );
    // A missing remote asset is kept so the user can see remote-deleted drift.
    void asset;
  }
  return items;
}

export async function listDrift(
  projectId: string,
  workspaceDirectory: string,
  includeIgnored = true,
): Promise<DriftItem[]> {
  const checkout = repoDir(projectId);
  const resolved = await realpath(workspaceDirectory).catch(
    () => workspaceDirectory,
  );
  const baselines = await readBaselines(workspaceDirectory);
  const assets = await scanAllAssets(checkout).catch(() => []);
  const rules = (await readSharedIgnoreRules(projectId)).rules;
  const ignores = await readDriftIgnores(workspaceDirectory);
  const assetPathById = new Map(
    assets.map((asset) => [asset.assetId, asset.path]),
  );

  const partials = (
    await Promise.all([
      promptItem(resolved, checkout, baselines, rules),
      knowledgeItems(checkout, resolved, baselines, assets, rules),
      docItems(checkout, resolved, baselines, assets, rules),
      skillItems(projectId, resolved, checkout, baselines, assets, rules),
    ])
  ).flat();

  const items: DriftItem[] = [];
  for (const partial of partials) {
    if (!partial) continue;
    if (!needsAttention(partial.status)) continue;
    const repositoryPath =
      partial.kind === "prompt"
        ? "AGENTS.md"
        : (assetPathById.get(partial.assetId) ??
          (partial.kind === "knowledge"
            ? `knowledge/${partial.name}.md`
            : partial.kind === "doc"
              ? `docs/${partial.name}`
              : partial.assetId.replace(
                  /^skill:project\//,
                  "skills/project/",
                )));
    const ignored =
      isRuleIgnored(
        { assetId: partial.assetId, kind: partial.kind, path: repositoryPath },
        rules,
      ) || isDriftIgnored(partial.assetId, partial.targetPath, ignores);
    if (!includeIgnored && ignored) continue;
    items.push({ ...partial, ignored });
  }

  return items.sort((a, b) => {
    const kindOrder: AssetKind[] = ["prompt", "skill", "knowledge", "doc"];
    const kind = kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind);
    if (kind !== 0) return kind;
    return `${a.assetId}/${a.provider ?? ""}`.localeCompare(
      `${b.assetId}/${b.provider ?? ""}`,
    );
  });
}
