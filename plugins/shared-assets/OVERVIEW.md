# Shared Assets

Shared Assets connects a Paseo project to a team Git repository and keeps project-scoped skills,
`AGENTS.md` prompts, knowledge and docs in sync with it. The plugin shows every registered project,
its binding state and the assets that are synced, changed, unpublished or in conflict.

## How it works

A bound repository contains `team-assets.json` and one or more of `skills/project/<name>/`,
`knowledge/`, `docs/` and `AGENTS.md`. The plugin clones the repository into its plugin data
directory and scans those directories. A shared or published Skill has one entity at
`.paseo/skills/<name>`. Provider directories such as `.codex/skills/<name>`,
`.claude/skills/<name>` and `.pi/skills/<name>` are relative symlinks to that entity. A local,
not-yet-published Skill stays in the provider directory where it was created. If the platform
cannot create symlinks, the plugin falls back to a copy and reports that projection as a copy.
Editing `.paseo/skills/<name>` changes every provider linked to it.

The plugin keeps a baseline per asset, so the detail view can show whether the shared copy, the
local copy or both changed.

The project detail view groups assets by skills, prompt, knowledge and docs, and by provider. From
there you can add a shared asset to the project, link an existing local copy, sync changes in either
direction, compare and merge, publish selected local assets, or remove a link. Batch actions and
ignore rules are available for larger repositories. Publishing a local Skill moves it to
`.paseo/skills/<name>` and links its providers. Publishing creates a commit in the local checkout
and reports the push hint; it does not push automatically.

## Setup

- Paseo 0.15.4 through 0.16.x with plugins enabled.
- Git available on the daemon host, with access to the configured repository.
- A registered Paseo project with at least one workspace.
- A team repository with a valid `team-assets.json`, and explicit trust confirmation when binding
  the project to that repository.
- No external runtime or package installation is needed.

## Capabilities and limits

- Read and write the configured repository checkout under the plugin data directory, and read the
  project workspace when scanning local assets or materializing skills.
- Maintain one entity per shared Skill under `.paseo/skills/` and create relative provider links
  under `.codex/skills/`, `.claude/skills/` and `.pi/skills/`. When symlinks are unavailable, it
  writes a copy and marks that projection as a copy. Files not created by the plugin are left
  alone.
- Credential files such as `.env`, `.npmrc`, private keys and certificate files are excluded from
  scanning, diffs, publish previews and commits.
- Network access is limited to the configured Git remote. No telemetry is sent.
- Published commits remain local until someone pushes the repository; the plugin never forces a
  push. Merge conflicts must be resolved in the plugin or manually in the checkout.
- Shared assets are project-scoped. Global skills are not supported.
- Provider support covers directory conventions. Codex, CodeBuddy (`.codebuddy/skills`) and
  DeepSeek Harness (`deepseek-harness-native`, `.dsh/skills`) loading has been verified, including
  symlinks. CodeBuddy uses `.codebuddy/CODEBUDDY.md` for instructions; DeepSeek Harness reads the
  project root `AGENTS.md` and reuses the Codex entry instead of projecting a separate file.
  Claude, Pi, Copilot, OpenCode, Antigravity and Muse remain unverified or only follow directory
  conventions.
