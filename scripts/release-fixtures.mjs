#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = join(root, ".e2e/release");
const origin = join(runtime, "team-origin");
const bare = join(runtime, "team.git");
const project = join(runtime, "demo-project");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

await rm(runtime, { recursive: true, force: true });
await mkdir(join(origin, "skills/project/code-review"), { recursive: true });
await mkdir(join(origin, "skills/global/writing"), { recursive: true });
await mkdir(join(origin, "knowledge"), { recursive: true });
await mkdir(project, { recursive: true });

await writeFile(
  join(origin, "team-assets.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      libraryId: "release-team-assets",
      displayName: "Release Team Assets",
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  join(origin, "AGENTS.md"),
  "# Release fixture instructions\n\n- Keep the release smoke deterministic.\n",
);
await writeFile(
  join(origin, "skills/project/code-review/SKILL.md"),
  "---\nname: code-review\ndescription: Review a change for correctness and regressions.\n---\n\n# Code review\n\nCheck tests and error paths.\n",
);
await writeFile(
  join(origin, "skills/global/writing/SKILL.md"),
  "---\nname: writing\ndescription: Write concise technical prose.\n---\n\n# Writing\n\nLead with the result.\n",
);
await writeFile(
  join(origin, "knowledge/release.md"),
  "# Release\n\nThis file proves shared assets survive plugin upgrade, restart and removal.\n",
);

git(origin, "init", "--quiet");
git(origin, "config", "user.name", "Release Fixture");
git(origin, "config", "user.email", "release-fixture@example.invalid");
git(origin, "add", ".");
git(origin, "commit", "--quiet", "-m", "seed release fixtures");
execFileSync("git", ["clone", "--quiet", "--bare", origin, bare]);

await writeFile(join(project, "README.md"), "# Release demo project\n");
await mkdir(join(project, "notes"), { recursive: true });
await writeFile(join(project, "notes/user-file.txt"), "user data must survive plugin removal\n");
git(project, "init", "--quiet");
git(project, "config", "user.name", "Release Fixture");
git(project, "config", "user.email", "release-fixture@example.invalid");
git(project, "add", ".");
git(project, "commit", "--quiet", "-m", "seed demo project");

console.log(
  JSON.stringify({ runtime, teamRepo: bare, projectDir: project }, null, 2),
);
