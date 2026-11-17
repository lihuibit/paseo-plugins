# Shared Assets

Shared Assets connects a Paseo project to a team Git repository and keeps project-scoped skills,
`AGENTS.md` prompts, knowledge and docs in sync with it. The plugin shows every registered project,
its binding state and the assets that are synced, changed, unpublished or in conflict.

## How it works

A bound repository contains `team-assets.json` and one or more of `skills/project/<name>/`,
`knowledge/`, `docs/` and `AGENTS.md`. The plugin clones the repository into its plugin data
directory, scans those directories, and materializes managed copies into the project's provider
directories. It keeps a baseline per asset, so the detail view can show whether the shared copy,
the local copy or both changed.

The project detail view groups assets by skills, prompt, knowledge and docs, and by provider. From
there you can add a shared asset to the project, link an existing local copy, sync changes in either
direction, compare and merge, publish selected local assets, or remove a link. Batch actions and
ignore rules are available for larger repositories. Publishing creates a commit in the local
checkout and reports the push hint; it does not push automatically.

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
- Write managed copies into the project's provider directories, such as `.paseo/`, `.codex/skills/`
  and `.claude/skills/`. Files that were not created by the plugin are left alone.
- Credential files such as `.env`, `.npmrc`, private keys and certificate files are excluded from
  scanning, diffs, publish previews and commits.
- Network access is limited to the configured Git remote. No telemetry is sent.
- Published commits remain local until someone pushes the repository; the plugin never forces a
  push. Merge conflicts must be resolved in the plugin or manually in the checkout.
- Shared assets are project-scoped. Global skills are not supported.
- Provider support covers directory conventions. Codex loading has been verified; Claude directory
  conventions are supported but real model loading has not been verified.
