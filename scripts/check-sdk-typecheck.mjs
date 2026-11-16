#!/usr/bin/env node
// Typechecks the workspace against a Paseo SDK version without touching the
// repository's node_modules. Usage: node scripts/check-sdk-typecheck.mjs 0.15.4
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const versions = process.argv.slice(2);
if (versions.length === 0) versions.push("0.15.4", "0.16.0-beta.2");

const sdkPackages = ["plugin", "client", "protocol", "relay"];
const ignored = new Set(["node_modules", ".git", ".e2e", ".tmp"]);

async function ensureSdk(version) {
  const prefix = join(tmpdir(), `paseo-sdk-${version}`);
  const installed = await readFile(
    join(prefix, "node_modules/@getpaseo/plugin/package.json"),
    "utf8",
  ).catch(() => null);
  if (installed && JSON.parse(installed).version === version) return prefix;
  await rm(prefix, { recursive: true, force: true });
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      `@getpaseo/plugin@${version}`,
      `@getpaseo/client@${version}`,
      "--no-audit",
      "--no-fund",
    ],
    { stdio: "inherit" },
  );
  return prefix;
}

async function check(version) {
  const sdkPrefix = await ensureSdk(version);
  const work = await mkdtemp(join(tmpdir(), "paseo-plugins-compat-"));
  try {
    await cp(root, work, {
      recursive: true,
      filter: (source) => !ignored.has(source.split("/").at(-1)),
    });
    await rm(join(work, "node_modules"), { recursive: true, force: true });
    const sourceNodeModules = join(root, "node_modules");
    const targetNodeModules = join(work, "node_modules");
    await mkdir(targetNodeModules, { recursive: true });
    for (const entry of await readdir(sourceNodeModules)) {
      if (entry === "@getpaseo") continue;
      await symlink(
        join(sourceNodeModules, entry),
        join(targetNodeModules, entry),
        "dir",
      );
    }
    const scope = join(targetNodeModules, "@getpaseo");
    await mkdir(scope, { recursive: true });
    const sdkRoot = join(sdkPrefix, "node_modules/@getpaseo");
    for (const name of sdkPackages) {
      await symlink(join(sdkRoot, name), join(scope, name), "dir");
    }
    for (const entry of await readdir(join(sourceNodeModules, "@getpaseo"))) {
      if (sdkPackages.includes(entry)) continue;
      await symlink(
        join(sourceNodeModules, "@getpaseo", entry),
        join(scope, entry),
        "dir",
      );
    }
    console.log(`\n=== typecheck with @getpaseo/plugin ${version} ===`);
    execFileSync("npm", ["run", "typecheck"], {
      cwd: work,
      stdio: "inherit",
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  for (const version of versions) await check(version);
}

await main();
