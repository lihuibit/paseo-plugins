#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = join(root, ".e2e");
const origin = join(runtime, "team-origin");
const bare = join(runtime, "team.git");
const project = join(runtime, "demo-project");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function main() {
  await rm(runtime, { recursive: true, force: true });
  await mkdir(join(origin, "skills/project/code-review"), { recursive: true });
  await mkdir(join(origin, "skills/global/writing"), { recursive: true });
  await mkdir(join(origin, "knowledge"), { recursive: true });
  await mkdir(join(origin, "docs/design/assets"), { recursive: true });

  await writeFile(
    join(origin, "team-assets.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        libraryId: "team-assets",
        displayName: "Team Assets",
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(origin, "AGENTS.md"),
    "# Team instructions\n\n- Always run the tests before reporting done.\n- Prefer small, reviewable commits.\n",
  );
  await writeFile(
    join(origin, "skills/project/code-review/SKILL.md"),
    "---\nname: code-review\ndescription: Review a change for correctness and regressions.\n---\n\n# Code review\n\nCheck tests, error paths and data loss risks.\n",
  );
  await writeFile(
    join(origin, "skills/global/writing/SKILL.md"),
    "---\nname: writing\ndescription: Write concise technical prose.\n---\n\n# Writing\n\nLead with the result.\n",
  );
  await writeFile(
    join(origin, "knowledge/deploy.md"),
    "# Deploy\n\n1. Run the test suite.\n2. Build the release artifact.\n3. Announce the rollout.\n",
  );
  await writeFile(
    join(origin, "docs/design/README.md"),
    "# Design package\n\nThis directory is one document package.\n\n![flow](assets/flow.png)\n",
  );
  await writeFile(join(origin, "docs/design/assets/flow.png"), PNG);
  await writeFile(
    join(origin, "docs/design/assets/notes.txt"),
    "Binary-safe attachment fixture.\n",
  );

  git(origin, "init", "--quiet");
  git(origin, "config", "user.name", "Shared Assets E2E");
  git(origin, "config", "user.email", "shared-assets@example.invalid");
  git(origin, "add", ".");
  git(origin, "commit", "--quiet", "-m", "seed team assets");
  execFileSync("git", ["clone", "--quiet", "--bare", origin, bare], {
    encoding: "utf8",
  });

  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, "README.md"),
    "# Demo project\n\nProjection target fixture.\n",
  );
  git(project, "init", "--quiet");
  git(project, "config", "user.name", "Shared Assets E2E");
  git(project, "config", "user.email", "shared-assets@example.invalid");
  git(project, "add", ".");
  git(project, "commit", "--quiet", "-m", "seed demo project");

  console.log(JSON.stringify({ origin, bare, project }, null, 2));
}

await main();
