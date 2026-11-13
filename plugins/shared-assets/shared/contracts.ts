import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const RpcErrorCodeSchema = z.enum([
  "E_NOT_CONFIGURED",
  "E_ALREADY_CONFIGURED",
  "E_REPO_AUTH",
  "E_REPO_NOT_FOUND",
  "E_BRANCH_NOT_FOUND",
  "E_MANIFEST_INVALID",
  "E_LOCAL_CHANGES",
  "E_REVISION_CONFLICT",
  "E_LOCKED",
  "E_PATH_UNSAFE",
  "E_PROVIDER_UNSUPPORTED",
  "E_ASSET_NOT_FOUND",
  "E_VALIDATION_FAILED",
  "E_GIT_IDENTITY_MISSING",
  "E_PUSH_REJECTED",
  "E_MIGRATION_CONFLICT",
  "E_CONFLICT_UNRESOLVED",
  "E_INTERNAL",
]);

export const RpcErrorSchema = z.object({
  code: RpcErrorCodeSchema,
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
  retryable: z.boolean(),
});

export function envelope<T extends z.ZodType>(value: T) {
  return z.union([
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), error: RpcErrorSchema }),
  ]);
}

export const BindingStateSchema = z.object({
  localRevision: z.string().nullable(),
  remoteRevision: z.string().nullable(),
  lastFetchedAt: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  operation: z.enum(["idle", "fetching", "syncing", "publishing"]),
  dirty: z.boolean(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  lastError: RpcErrorSchema.nullable(),
});

export const BindingSchema = z.object({
  projectId: z.string().min(1),
  projectRoot: z.string().min(1),
  libraryId: z.string().min(1),
  displayName: z.string().min(1),
  repoUrl: z.string().min(1),
  branch: z.string().min(1).nullable(),
  syncMode: z.enum(["auto", "manual"]),
  configuredAt: z.string().min(1),
  revision: z.number().int().nonnegative(),
  state: BindingStateSchema,
});

export const ProjectSummarySchema = z.object({
  projectId: z.string().min(1),
  displayName: z.string().min(1),
  rootPath: z.string().min(1),
  bound: z.boolean(),
  libraryId: z.string().nullable(),
  syncMode: z.enum(["auto", "manual"]).nullable(),
  workspaces: z.array(
    z.object({
      workspaceId: z.string().min(1),
      name: z.string().min(1),
      directory: z.string().min(1),
      kind: z.string().min(1),
      background: z.boolean(),
    }),
  ),
});

export const AssetFileSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
});

export const AssetSummarySchema = z.object({
  assetId: z.string().min(1),
  kind: z.enum(["skill", "prompt", "knowledge", "doc"]),
  name: z.string().min(1),
  scope: z.enum(["project", "global"]).nullable(),
  description: z.string().nullable(),
  path: z.string(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  files: z.array(AssetFileSchema),
  warnings: z.array(z.string()),
});

export const SkillProjectionStatusSchema = z.object({
  assetId: z.string().min(1),
  provider: z.string().min(1),
  targetPath: z.string().min(1),
  state: z.enum(["managed", "missing", "modified"]),
});

export const SkillListResultSchema = z.object({
  skills: z.array(AssetSummarySchema),
  projections: z.array(SkillProjectionStatusSchema),
  warnings: z.array(z.string()),
});

export const InstructionTargetStatusSchema = z.object({
  provider: z.string().min(1),
  targetPath: z.string().min(1),
  state: z.enum(["absent", "managed", "conflict"]),
  owned: z.boolean(),
});

export const InstructionStatusResultSchema = z.object({
  sharedExists: z.boolean(),
  sharedDigest: z.string().nullable(),
  canonical: z.object({
    targetPath: z.string().min(1),
    exists: z.boolean(),
    managed: z.boolean(),
    matchesShared: z.boolean(),
  }),
  targets: z.array(InstructionTargetStatusSchema),
});

export const AssetReadResultSchema = z.object({
  assetId: z.string().min(1),
  path: z.string().min(1),
  kind: z.enum(["text", "image", "binary"]),
  mimeType: z.string().nullable(),
  content: z.string().nullable(),
  dataUri: z.string().nullable(),
  size: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const PublishPreviewSchema = z.object({
  expectedRevision: z.string().min(1),
  item: z.object({
    assetId: z.string().min(1),
    targetPath: z.string().min(1),
    diff: z.string(),
  }),
  warnings: z.array(z.string()),
});

export const PublishCommitResultSchema = z.object({
  commit: z.string().min(1),
  targetPath: z.string().min(1),
  pushed: z.literal(false),
  pushHint: z.string().min(1),
});

export const emptyInput = z.object({}).strict();

export const projectsListRpc = defineRpc({
  name: "shared-assets.projects.list",
  input: emptyInput,
  output: envelope(z.array(ProjectSummarySchema)),
});

export const configureRpc = defineRpc({
  name: "shared-assets.configure",
  input: z
    .object({
      projectId: z.string().min(1),
      repoUrl: z.string().min(1),
      branch: z.string().trim().min(1).nullable().default(null),
      syncMode: z.enum(["auto", "manual"]).default("manual"),
      trustConfirmed: z.literal(true),
    })
    .strict(),
  output: envelope(z.object({ binding: BindingSchema })),
});

export const statusRpc = defineRpc({
  name: "shared-assets.status",
  input: z.object({ projectId: z.string().min(1) }).strict(),
  output: envelope(
    z.object({
      binding: BindingSchema,
      sharedExists: z.boolean(),
      assetCounts: z.object({
        skills: z.number().int().nonnegative(),
        knowledge: z.number().int().nonnegative(),
        docs: z.number().int().nonnegative(),
      }),
    }),
  ),
});

export const syncRpc = defineRpc({
  name: "shared-assets.sync",
  input: z.object({ projectId: z.string().min(1) }).strict(),
  output: envelope(z.object({ binding: BindingSchema, changed: z.boolean() })),
});

export const unbindRpc = defineRpc({
  name: "shared-assets.unbind",
  input: z
    .object({
      projectId: z.string().min(1),
      force: z.boolean().default(false),
    })
    .strict(),
  output: envelope(
    z.object({
      configured: z.boolean(),
      removedProjections: z.array(z.string()),
      preserved: z.array(z.string()),
    }),
  ),
});

export const assetsListRpc = defineRpc({
  name: "shared-assets.assets.list",
  input: z.object({ projectId: z.string().min(1) }).strict(),
  output: envelope(z.array(AssetSummarySchema)),
});

export const skillsListRpc = defineRpc({
  name: "shared-assets.skills.list",
  input: z
    .object({
      projectId: z.string().min(1),
      workspaceId: z.string().min(1).optional(),
    })
    .strict(),
  output: envelope(SkillListResultSchema),
});

export const skillsSetEnabledRpc = defineRpc({
  name: "shared-assets.skills.set-enabled",
  input: z
    .object({
      projectId: z.string().min(1),
      workspaceId: z.string().min(1),
      assetId: z.string().min(1),
      provider: z.string().min(1).default("both"),
      enabled: z.boolean(),
    })
    .strict(),
  output: envelope(
    z.object({
      enabled: z.boolean(),
      projections: z.array(SkillProjectionStatusSchema),
      kept: z.array(z.object({ targetPath: z.string(), reason: z.string() })),
      errors: z.array(
        z.object({
          provider: z.string(),
          code: z.string(),
          message: z.string(),
        }),
      ),
    }),
  ),
});

export const instructionsStatusRpc = defineRpc({
  name: "shared-assets.instructions.status",
  input: z
    .object({ projectId: z.string().min(1), workspaceId: z.string().min(1) })
    .strict(),
  output: envelope(InstructionStatusResultSchema),
});

export const instructionsSetEnabledRpc = defineRpc({
  name: "shared-assets.instructions.set-enabled",
  input: z
    .object({
      projectId: z.string().min(1),
      workspaceId: z.string().min(1),
      provider: z.string().min(1).default("both"),
      enabled: z.boolean(),
    })
    .strict(),
  output: envelope(
    z.object({
      canonical: z.string().min(1),
      targets: z.array(InstructionTargetStatusSchema),
      kept: z.array(z.object({ targetPath: z.string(), reason: z.string() })),
    }),
  ),
});

export const assetReadRpc = defineRpc({
  name: "shared-assets.assets.read",
  input: z
    .object({
      projectId: z.string().min(1),
      assetId: z.string().min(1),
      path: z.string().min(1).optional(),
    })
    .strict(),
  output: envelope(AssetReadResultSchema),
});

export const publishPreviewRpc = defineRpc({
  name: "shared-assets.publish.preview",
  input: z
    .object({
      projectId: z.string().min(1),
      assetId: z.string().min(1),
      path: z.string().min(1).optional(),
      content: z.string(),
      message: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  output: envelope(PublishPreviewSchema),
});

export const publishCommitRpc = defineRpc({
  name: "shared-assets.publish.commit",
  input: z
    .object({
      projectId: z.string().min(1),
      assetId: z.string().min(1),
      path: z.string().min(1).optional(),
      content: z.string(),
      expectedRevision: z.string().min(1),
      message: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  output: envelope(PublishCommitResultSchema),
});

export const ProviderStatusSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  binary: z.string().nullable(),
  installed: z.boolean(),
  skillRoot: z.string().nullable(),
  userSkillRoot: z.string().nullable(),
  instructionEntrypoint: z.string().nullable(),
  skillVerified: z.boolean(),
  instructionVerified: z.boolean(),
  note: z.string(),
});

export const providersListRpc = defineRpc({
  name: "shared-assets.providers.list",
  input: emptyInput,
  output: envelope(z.array(ProviderStatusSchema)),
});

const DriftStatusSchema = z.enum([
  "synced",
  "local-update",
  "remote-update",
  "diverged",
  "remote-deleted",
  "unpublished-local",
  "missing",
]);

export const DriftFileStatusSchema = z.object({
  path: z.string(),
  repositoryPath: z.string(),
  status: DriftStatusSchema,
  baseDigest: z.string().nullable(),
  localDigest: z.string().nullable(),
  remoteDigest: z.string().nullable(),
});

export const DriftItemSchema = z.object({
  assetId: z.string().min(1),
  kind: z.enum(["skill", "prompt", "knowledge", "doc"]),
  name: z.string().min(1),
  scope: z.enum(["project", "global"]).nullable(),
  provider: z.string().nullable(),
  targetPath: z.string().min(1),
  status: DriftStatusSchema,
  files: z.array(DriftFileStatusSchema),
  ignored: z.boolean(),
});

export const driftListRpc = defineRpc({
  name: "shared-assets.drift.list",
  input: z
    .object({
      projectId: z.string().min(1),
      workspaceId: z.string().min(1),
      includeIgnored: z.boolean().default(true),
    })
    .strict(),
  output: envelope(z.array(DriftItemSchema)),
});

export const AssetDiffResultSchema = z.object({
  assetId: z.string().min(1),
  path: z.string().nullable(),
  kind: z.enum(["text", "binary"]),
  base: z.string().nullable(),
  local: z.string().nullable(),
  remote: z.string().nullable(),
  localDiff: z.string(),
  remoteDiff: z.string(),
  netDiff: z.string(),
});

export const diffRpc = defineRpc({
  name: "shared-assets.diff",
  input: z
    .object({
      projectId: z.string().min(1),
      workspaceId: z.string().min(1),
      assetId: z.string().min(1),
      path: z.string().optional(),
      provider: z.string().optional(),
    })
    .strict(),
  output: envelope(AssetDiffResultSchema),
});

export const MergeConflictViewSchema = z.object({
  id: z.string().min(1),
  base: z.string(),
  local: z.string(),
  remote: z.string(),
  localDiff: z.string(),
  remoteDiff: z.string(),
});

export const MergePreviewResultSchema = z.object({
  assetId: z.string().min(1),
  repositoryPath: z.string().min(1),
  localPath: z.string().min(1),
  merged: z.string(),
  conflicts: z.array(MergeConflictViewSchema),
  hasConflicts: z.boolean(),
  expectedLocalDigest: z.string().nullable(),
  expectedRemoteDigest: z.string().nullable(),
});

export const mergePreviewRpc = defineRpc({
  name: "shared-assets.merge.preview",
  input: z
    .object({
      projectId: z.string().min(1),
      workspaceId: z.string().min(1),
      assetId: z.string().min(1),
      path: z.string().optional(),
      provider: z.string().optional(),
    })
    .strict(),
  output: envelope(MergePreviewResultSchema),
});

export const MergeResolutionSchema = z.object({
  conflictId: z.string().min(1),
  choice: z.enum(["local", "remote", "both", "custom"]),
  content: z.string().optional(),
});

export const MergeApplyResultSchema = z.object({
  assetId: z.string().min(1),
  repositoryPath: z.string().min(1),
  content: z.string(),
  conflictsRemaining: z.number().int().nonnegative(),
  baselineUpdatedTo: z.string().nullable(),
});

export const mergeApplyRpc = defineRpc({
  name: "shared-assets.merge.apply",
  input: z
    .object({
      projectId: z.string().min(1),
      workspaceId: z.string().min(1),
      assetId: z.string().min(1),
      path: z.string().optional(),
      provider: z.string().optional(),
      resolutions: z.array(MergeResolutionSchema),
      expectedLocalDigest: z.string().nullable(),
      expectedRemoteDigest: z.string().nullable(),
    })
    .strict(),
  output: envelope(MergeApplyResultSchema),
});

const BatchSelectionSchema = z.object({
  assetId: z.string().min(1),
  path: z.string().optional(),
  provider: z.string().optional(),
});

export const BatchPublishPreviewSchema = z.object({
  expectedRevision: z.string().min(1),
  items: z.array(
    z.object({
      assetId: z.string().min(1),
      kind: z.enum(["skill", "prompt", "knowledge", "doc"]),
      name: z.string().min(1),
      targetPath: z.string().min(1),
      state: z.enum(["eligible", "warning", "ineligible", "skipped"]),
      reasons: z.array(
        z.object({ code: z.string().min(1), message: z.string().min(1) }),
      ),
      files: z.array(
        z.object({
          path: z.string().min(1),
          repositoryPath: z.string().min(1),
          size: z.number().int().nonnegative(),
          diff: z.string(),
        }),
      ),
      diff: z.string(),
    }),
  ),
  skipped: z.array(
    z.object({ assetId: z.string().min(1), reason: z.string().min(1) }),
  ),
});

export const batchPublishPreviewRpc = defineRpc({
  name: "shared-assets.publish.batch.preview",
  input: z
    .object({
      projectId: z.string().min(1),
      workspaceId: z.string().min(1),
      items: z.array(BatchSelectionSchema).min(1).max(200),
    })
    .strict(),
  output: envelope(BatchPublishPreviewSchema),
});

export const BatchPublishResultSchema = z.object({
  commit: z.string().min(1).nullable(),
  pushed: z.literal(false),
  pushHint: z.string().min(1),
  published: z.array(
    z.object({
      assetId: z.string().min(1),
      state: z.enum(["published", "failed", "skipped"]),
      targetPath: z.string(),
      files: z.array(z.string()),
      reason: z.string().nullable(),
    }),
  ),
  failed: z.array(
    z.object({
      assetId: z.string().min(1),
      state: z.enum(["published", "failed", "skipped"]),
      targetPath: z.string(),
      files: z.array(z.string()),
      reason: z.string().nullable(),
    }),
  ),
  skipped: z.array(
    z.object({
      assetId: z.string().min(1),
      state: z.enum(["published", "failed", "skipped"]),
      targetPath: z.string(),
      files: z.array(z.string()),
      reason: z.string().nullable(),
    }),
  ),
  rolledBack: z.boolean(),
});

export const batchPublishCommitRpc = defineRpc({
  name: "shared-assets.publish.batch.commit",
  input: z
    .object({
      projectId: z.string().min(1),
      workspaceId: z.string().min(1),
      items: z.array(BatchSelectionSchema).min(1).max(200),
      expectedRevision: z.string().min(1),
      message: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  output: envelope(BatchPublishResultSchema),
});

export const IgnoreRulesResultSchema = z.object({
  raw: z.string(),
  rules: z.array(
    z.object({
      type: z.enum(["path", "kind", "asset"]),
      value: z.string(),
    }),
  ),
  errors: z.array(
    z.object({ line: z.number().int(), message: z.string().min(1) }),
  ),
});

export const ignoreRulesGetRpc = defineRpc({
  name: "shared-assets.ignore.rules.get",
  input: z.object({ projectId: z.string().min(1) }).strict(),
  output: envelope(IgnoreRulesResultSchema),
});

export const ignoreRulesSetRpc = defineRpc({
  name: "shared-assets.ignore.rules.set",
  input: z
    .object({
      projectId: z.string().min(1),
      raw: z.string(),
      message: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  output: envelope(
    IgnoreRulesResultSchema.extend({
      commit: z.string().nullable(),
    }),
  ),
});

export const driftIgnoreRpc = defineRpc({
  name: "shared-assets.drift.ignore",
  input: z
    .object({
      projectId: z.string().min(1),
      workspaceId: z.string().min(1),
      assetId: z.string().min(1),
      path: z.string().nullable().default(null),
      provider: z.string().optional(),
      reason: z.string().max(200).optional(),
    })
    .strict(),
  output: envelope(z.array(DriftItemSchema)),
});

export const driftUnignoreRpc = defineRpc({
  name: "shared-assets.drift.unignore",
  input: z
    .object({
      projectId: z.string().min(1),
      workspaceId: z.string().min(1),
      assetId: z.string().min(1),
      path: z.string().nullable().default(null),
      provider: z.string().optional(),
    })
    .strict(),
  output: envelope(z.array(DriftItemSchema)),
});

export const driftResolveRpc = defineRpc({
  name: "shared-assets.drift.resolve",
  input: z
    .object({
      projectId: z.string().min(1),
      workspaceId: z.string().min(1),
      assetId: z.string().min(1),
      path: z.string().nullable().default(null),
      provider: z.string().optional(),
      action: z.enum(["overwrite", "keep"]),
    })
    .strict(),
  output: envelope(
    z.object({
      action: z.enum(["overwrite", "keep"]),
      updatedFiles: z.array(z.string()),
      keptFiles: z.array(z.string()),
      items: z.array(DriftItemSchema),
    }),
  ),
});

export const workspacePullRpc = defineRpc({
  name: "shared-assets.workspace.pull",
  input: z
    .object({
      projectId: z.string().min(1),
      workspaceId: z.string().min(1),
    })
    .strict(),
  output: envelope(
    z.object({
      imported: z.array(z.string()),
      updated: z.array(z.string()),
      kept: z.array(z.string()),
      removed: z.array(z.string()),
    }),
  ),
});

export const MigrationReportSchema = z.object({
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
  dryRun: z.boolean(),
  sourceDigest: z.string(),
  appliedAt: z.string().nullable(),
  reused: z.boolean(),
  applied: z.boolean(),
  files: z.array(
    z.object({
      sourcePath: z.string().min(1),
      repositoryPath: z.string().min(1),
      action: z.enum(["import", "skip", "conflict"]),
      reason: z.string().nullable(),
      diff: z.string(),
    }),
  ),
  skipped: z.array(
    z.object({ path: z.string().min(1), reason: z.string().min(1) }),
  ),
  conflicts: z.array(
    z.object({
      path: z.string().min(1),
      reason: z.string().min(1),
      diff: z.string(),
    }),
  ),
  candidates: z.object({ skills: z.array(z.string()) }),
  before: z.object({
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    digest: z.string(),
  }),
  after: z.object({
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    digest: z.string(),
  }),
  commit: z.string().min(1).nullable(),
});

export const migrateLegacyRpc = defineRpc({
  name: "shared-assets.migrate",
  input: z
    .object({
      projectId: z.string().min(1),
      workspaceId: z.string().min(1),
      dryRun: z.boolean().default(true),
    })
    .strict(),
  output: envelope(MigrationReportSchema),
});
