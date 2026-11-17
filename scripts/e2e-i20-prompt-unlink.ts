#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  readBaselines,
  scopeIdFor,
  writeBaselines,
} from "../plugins/shared-assets/server/baseline";
import {
  pluginDataDir,
  repoDir,
} from "../plugins/shared-assets/server/plugin-data";
import { unlinkRelationship } from "../plugins/shared-assets/server/relationships";
import { readConfig } from "../plugins/shared-assets/server/registry";

const run = promisify(execFile);

const PROJECT_ID = "prj_f5c7ce14e36de271";
const PROJECT_ROOT = "/home/ubuntu/lihui/code/sonic/tcsgw-td5/sonic-buildimage";
const REPO_URL =
  "https://git.woa.com/NFV_Group/HGW_Group/agentstorm-tcsgw-assets";
const STALE_PROMPT_DIGEST =
  "300643b2ae10a72453a76a8c10049782c1ca693f96a8c901e0b420a4cd0f8b81";

async function main(): Promise<void> {
  const home = process.env.I20_HOME;
  if (!home) throw new Error("I20_HOME is required");
  process.env.PASEO_HOME = home;

  const checkout = repoDir(PROJECT_ID);
  if (!existsSync(checkout)) {
    await mkdir(repoDir(PROJECT_ID), { recursive: true });
    await run("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      "main",
      REPO_URL,
      checkout,
    ]);
  }
  const head = (
    await run("git", ["-C", checkout, "rev-parse", "--short", "HEAD"])
  ).stdout.trim();

  await mkdir(pluginDataDir(), { recursive: true });
  await writeFile(
    join(pluginDataDir(), "config.json"),
    `${JSON.stringify(
      {
        version: 1,
        bindings: {
          [PROJECT_ID]: {
            projectId: PROJECT_ID,
            projectRoot: PROJECT_ROOT,
            libraryId: "team-assets",
            displayName: "team-assets",
            repoUrl: REPO_URL,
            branch: "main",
            syncMode: "manual",
            configuredAt: new Date().toISOString(),
            revision: 1,
            state: {
              localRevision: head,
              remoteRevision: head,
              lastFetchedAt: null,
              lastSyncedAt: null,
              operation: "idle",
              dirty: false,
              ahead: 0,
              behind: 0,
              lastError: null,
            },
          },
        },
        skills: {},
        instructions: {},
        settings: { monitorIntervalMs: 60000 },
      },
      null,
      2,
    )}\n`,
  );

  const baselines = await readBaselines(PROJECT_ROOT);
  baselines.entries["prompt\u0000\u0000AGENTS.md"] = {
    assetId: "prompt",
    kind: "prompt",
    path: "AGENTS.md",
    provider: null,
    digest: STALE_PROMPT_DIGEST,
    content: null,
    updatedAt: "2026-11-17T02:14:39.053Z",
  };
  await writeBaselines(PROJECT_ROOT, baselines);

  const rootLink = join(PROJECT_ROOT, "AGENTS.md");
  if (!existsSync(rootLink)) throw new Error(`missing ${rootLink}`);

  const result = await unlinkRelationship({
    projectId: PROJECT_ID,
    workspaceDirectory: PROJECT_ROOT,
    kind: "prompt",
    provider: "codex",
    assetId: "prompt",
    deleteLocal: false,
  });

  const config = await readConfig();
  const remaining = await readBaselines(PROJECT_ROOT);
  const promptBaselines = Object.values(remaining.entries).filter(
    (entry) => entry.assetId === "prompt",
  );
  const promptDigest = (
    await run("sha256sum", [join(PROJECT_ROOT, ".paseo", "AGENTS.md")])
  ).stdout.split(/\s+/)[0];
  const link = (await run("readlink", [rootLink])).stdout.trim();

  console.log(
    JSON.stringify(
      {
        home,
        scopeId: await scopeIdFor(PROJECT_ROOT),
        repositoryHead: head,
        instructionsAfterUnlink: config.instructions[PROJECT_ID] ?? null,
        promptBaselinesAfterUnlink: promptBaselines.length,
        unlink: result,
        rootAgentsSymlink: link,
        canonicalDigest: promptDigest,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        error:
          error && typeof error === "object" && "code" in error
            ? {
                code: (error as { code?: string }).code,
                message: String(error),
              }
            : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
