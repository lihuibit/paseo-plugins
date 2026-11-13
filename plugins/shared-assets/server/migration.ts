import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { PluginError } from "../shared/core/errors";
import { unifiedDiff } from "../shared/core/diff";
import { PROVIDERS } from "../shared/core/providers";
import type {
  MigrationFilePlan,
  MigrationReport,
  MigrationSummary,
} from "../shared/core/types";
import { atomicWriteFile, readJson, sha256 } from "./fs-utils";
import { headRevision, runGit } from "./git";
import { pluginDataDir, repoDir } from "./plugin-data";

interface SourceFile {
  absolute: string;
  relative: string;
  size: number;
}

interface MigrationRecord {
  projectId: string;
  workspaceId: string;
  sourceDigest: string;
  appliedAt: string;
  skipped: Array<{ path: string; reason: string }>;
  conflicts: Array<{ path: string; reason: string; diff: string }>;
}

async function walk(
  root: string,
  skipped: Array<{ path: string; reason: string }>,
): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split("\\").join("/");
      if (entry.isSymbolicLink()) {
        skipped.push({ path, reason: "symlink is not migrated" });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await lstat(absolute);
      files.push({ absolute, relative: path, size: info.size });
    }
  }
  await visit(root);
  return files;
}

function targetFor(path: string): string | null {
  if (path === "AGENTS.md") return "AGENTS.md";
  if (/^knowledge\/[^/]+\.md$/.test(path)) return path;
  if (path.startsWith("docs/") && path.split("/").length >= 3) return path;
  return null;
}

async function summary(
  files: Array<{ path: string; size: number; buffer: Buffer }>,
): Promise<MigrationSummary> {
  const hash = sha256(
    files
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => `${file.path}\0${file.size}\0`)
      .join(""),
  );
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    digest: files.reduce(
      (digest, file) => sha256(digest + sha256(file.buffer)),
      hash,
    ),
  };
}

async function targetSummary(
  checkout: string,
  extra: Array<{ path: string; size: number; buffer: Buffer }> = [],
): Promise<MigrationSummary> {
  const entries = new Map<
    string,
    { path: string; size: number; buffer: Buffer }
  >();
  for (const path of ["AGENTS.md"]) {
    try {
      const buffer = await readFile(join(checkout, path));
      entries.set(path, { path, size: buffer.length, buffer });
    } catch {
      // Missing.
    }
  }
  for (const directory of ["knowledge", "docs"]) {
    const files = await walk(join(checkout, directory), []).catch(() => []);
    for (const file of files) {
      const buffer = await readFile(file.absolute);
      entries.set(`${directory}/${file.relative}`, {
        path: `${directory}/${file.relative}`,
        size: file.size,
        buffer,
      });
    }
  }
  for (const entry of extra) entries.set(entry.path, entry);
  return summary([...entries.values()]);
}

async function skillCandidates(workspaceDirectory: string): Promise<string[]> {
  const names = new Set<string>();
  for (const provider of PROVIDERS) {
    if (!provider.skillRoot) continue;
    const root = join(workspaceDirectory, provider.skillRoot);
    const entries = await readdir(root, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (entry.isDirectory()) names.add(entry.name);
    }
  }
  return [...names].sort();
}

function recordPath(projectId: string): string {
  return join(pluginDataDir(), "migrations", `${projectId}.json`);
}

async function readRecord(projectId: string): Promise<MigrationRecord | null> {
  return await readJson<MigrationRecord>(recordPath(projectId)).catch(
    () => null,
  );
}

async function writeRecord(record: MigrationRecord): Promise<void> {
  await atomicWriteFile(
    recordPath(record.projectId),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

export async function migrateLegacy(input: {
  projectId: string;
  workspaceId: string;
  workspaceDirectory: string;
  dryRun: boolean;
}): Promise<MigrationReport> {
  const sourceRoot = join(input.workspaceDirectory, ".agentstorm");
  const skipped: Array<{ path: string; reason: string }> = [];
  const sourceFiles = await walk(sourceRoot, skipped);
  if (sourceFiles.length === 0 && skipped.length === 0) {
    throw new PluginError(
      "E_ASSET_NOT_FOUND",
      `No .agentstorm files to migrate in ${input.workspaceDirectory}`,
    );
  }
  const sourceEntries = await Promise.all(
    sourceFiles.map(async (file) => {
      const buffer = await readFile(file.absolute);
      return { path: file.relative, size: file.size, buffer };
    }),
  );
  const before = await summary(sourceEntries);
  const record = await readRecord(input.projectId);
  if (
    record &&
    record.workspaceId === input.workspaceId &&
    record.sourceDigest === before.digest
  ) {
    const current = await targetSummary(repoDir(input.projectId));
    return {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      dryRun: input.dryRun,
      sourceDigest: before.digest,
      appliedAt: record.appliedAt,
      reused: true,
      applied: false,
      files: [],
      skipped: record.skipped,
      conflicts: record.conflicts,
      candidates: { skills: await skillCandidates(input.workspaceDirectory) },
      before,
      after: current,
      commit: null,
    };
  }

  const checkout = repoDir(input.projectId);
  const plans: MigrationFilePlan[] = [];
  const conflicts: Array<{ path: string; reason: string; diff: string }> = [];
  const imports: SourceFile[] = [];
  for (const file of sourceFiles) {
    if (file.relative.startsWith("workflows/")) {
      skipped.push({
        path: file.relative,
        reason: "workflows are not migrated",
      });
      continue;
    }
    const repositoryPath = targetFor(file.relative);
    if (!repositoryPath) {
      skipped.push({
        path: file.relative,
        reason: "not part of the shared asset set",
      });
      continue;
    }
    const buffer = await readFile(file.absolute);
    const destination = join(checkout, repositoryPath);
    const existing = await readFile(destination).catch(() => null);
    if (existing === null) {
      plans.push({
        sourcePath: file.relative,
        repositoryPath,
        action: "import",
        reason: null,
        diff: "",
      });
      imports.push(file);
      continue;
    }
    if (sha256(existing) === sha256(buffer)) {
      plans.push({
        sourcePath: file.relative,
        repositoryPath,
        action: "skip",
        reason: "identical content already exists",
        diff: "",
      });
      skipped.push({
        path: file.relative,
        reason: "identical content already exists",
      });
      continue;
    }
    const diff = unifiedDiff(
      repositoryPath,
      existing.toString("utf8"),
      buffer.toString("utf8"),
    );
    plans.push({
      sourcePath: file.relative,
      repositoryPath,
      action: "conflict",
      reason: "destination exists with different content",
      diff,
    });
    conflicts.push({
      path: repositoryPath,
      reason: "destination exists with different content",
      diff,
    });
  }

  let commit: string | null = null;
  if (!input.dryRun && imports.length > 0) {
    const written: string[] = [];
    try {
      for (const file of imports) {
        const repositoryPath = targetFor(file.relative) as string;
        await atomicWriteFile(
          join(checkout, repositoryPath),
          await readFile(file.absolute),
        );
        written.push(repositoryPath);
      }
      await runGit(checkout, ["add", "--", ...written]);
      const result = await runGit(
        checkout,
        [
          "commit",
          "--quiet",
          "-m",
          "chore(shared-assets): import legacy .agentstorm assets",
          "--",
          ...written,
        ],
        { allowFailure: true },
      );
      if (result.code !== 0) {
        throw new PluginError("E_INTERNAL", "Git commit failed", {
          output: result.stderr,
        });
      }
      commit = await headRevision(checkout);
    } catch (error) {
      await runGit(checkout, ["reset", "--quiet", "--", ...written], {
        allowFailure: true,
      });
      for (const repositoryPath of written) {
        await runGit(checkout, ["checkout", "--", repositoryPath], {
          allowFailure: true,
        });
        await runGit(checkout, ["clean", "--force", "--", repositoryPath], {
          allowFailure: true,
        });
      }
      throw error;
    }
  }

  const after = await targetSummary(
    checkout,
    input.dryRun
      ? imports.map((file) => ({
          path: targetFor(file.relative) as string,
          size: file.size,
          buffer: sourceEntries.find((entry) => entry.path === file.relative)
            ?.buffer as Buffer,
        }))
      : [],
  );
  const report: MigrationReport = {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    dryRun: input.dryRun,
    sourceDigest: before.digest,
    appliedAt: null,
    reused: false,
    applied: !input.dryRun && imports.length > 0,
    files: plans,
    skipped,
    conflicts,
    candidates: { skills: await skillCandidates(input.workspaceDirectory) },
    before,
    after,
    commit,
  };
  if (report.applied) {
    report.appliedAt = new Date().toISOString();
    await writeRecord({
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      sourceDigest: before.digest,
      appliedAt: report.appliedAt,
      skipped,
      conflicts,
    });
  }
  return report;
}
