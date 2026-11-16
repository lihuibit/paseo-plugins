import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloneRepository, runGit } from "../server/git";

let root: string;
let originalSystemConfig: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "shared-assets-git-"));
  originalSystemConfig = process.env.GIT_CONFIG_SYSTEM;
});

afterEach(async () => {
  if (originalSystemConfig === undefined) delete process.env.GIT_CONFIG_SYSTEM;
  else process.env.GIT_CONFIG_SYSTEM = originalSystemConfig;
  await rm(root, { recursive: true, force: true });
});

async function seedRepository(): Promise<string> {
  const repo = join(root, "origin");
  await mkdir(repo, { recursive: true });
  await runGit(repo, ["init", "--quiet"]);
  await runGit(repo, ["config", "user.name", "Test"]);
  await runGit(repo, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(repo, "README.md"), "team assets\n");
  await runGit(repo, ["add", "."]);
  await runGit(repo, ["commit", "--quiet", "-m", "seed"]);
  return repo;
}

describe("system git config", () => {
  it("inherits url.*.insteadOf rewriting from the system config", async () => {
    const repo = await seedRepository();
    const systemConfig = join(root, "system.gitconfig");
    await writeFile(
      systemConfig,
      `[url "file://${repo}"]\n\tinsteadOf = https://git.example.invalid/team-assets\n`,
    );
    process.env.GIT_CONFIG_SYSTEM = systemConfig;

    const inherited = await runGit(null, [
      "config",
      "--get-regexp",
      "url\\..*\\.insteadof",
    ]);
    expect(inherited.stdout).toContain(
      "https://git.example.invalid/team-assets",
    );

    const clone = join(root, "clone");
    await cloneRepository(
      "https://git.example.invalid/team-assets",
      clone,
      null,
    );
    expect(await readFile(join(clone, "README.md"), "utf8")).toBe(
      "team assets\n",
    );
  });
});
