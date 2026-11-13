import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { envelope } from "./core/board/errors";
import {
  BoardAssignmentAgentSchema,
  BoardPrioritySchema,
  BoardStatusSchema,
  BoardTaskSchema,
  TriggerSchema,
} from "./core/board/types";
import { BoardSettingsPatchSchema, BoardSettingsSchema } from "./settings";

const IdSchema = z.string().min(1);
const RevisionSchema = z.number().int().nonnegative();

export const CandidateWorkspaceSchema = z
  .object({
    workspaceId: IdSchema,
    name: z.string().min(1),
    directory: z.string().min(1),
    kind: z.string().min(1),
    background: z.boolean(),
  })
  .strict();

export const CandidateAgentSchema = z
  .object({
    agentId: IdSchema,
    title: z.string().nullable(),
    provider: z.string().min(1),
    status: z.string().min(1),
  })
  .strict();

export const CandidateProjectSchema = z
  .object({
    projectId: IdSchema,
    name: z.string().min(1),
    rootPath: z.string().min(1),
    workspaces: z.array(CandidateWorkspaceSchema),
    agents: z.array(CandidateAgentSchema),
  })
  .strict();

export const CandidatesResultSchema = z
  .object({
    projects: z.array(CandidateProjectSchema),
    providers: z.array(
      z
        .object({
          provider: z.string().min(1),
          label: z.string().min(1),
          available: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type CandidatesResult = z.infer<typeof CandidatesResultSchema>;

export const HealthResultSchema = z
  .object({
    dataDir: z.string().min(1),
    taskCount: z.number().int().nonnegative(),
    boundAgentCount: z.number().int().nonnegative(),
    toolInjectionEnabled: z.boolean(),
    paseoHome: z.string().nullable(),
    scheduledCount: z.number().int().nonnegative(),
    pendingPermissionCount: z.number().int().nonnegative(),
    wecomEnabled: z.boolean(),
    wecomConfigured: z.boolean(),
    scheduler: z
      .object({
        instanceId: z.string().min(1),
        lockHeld: z.boolean(),
        lockOwner: z.string().nullable(),
        lastTickAt: z.string().nullable(),
        lastReconcileAt: z.string().nullable(),
        lastError: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type HealthResult = z.infer<typeof HealthResultSchema>;

export const emptyInput = z.object({}).strict();

export const listRpc = defineRpc({
  name: "task-board.list",
  input: z
    .object({
      status: BoardStatusSchema.optional(),
      projectId: IdSchema.optional(),
      label: z.string().min(1).optional(),
      query: z.string().optional(),
      includeFinished: z.boolean().default(true),
    })
    .strict(),
  output: envelope(
    z
      .object({
        tasks: z.array(BoardTaskSchema),
        counts: z.record(z.string(), z.number()),
      })
      .strict(),
  ),
});

export const getRpc = defineRpc({
  name: "task-board.get",
  input: z.object({ taskId: IdSchema }).strict(),
  output: envelope(z.object({ task: BoardTaskSchema }).strict()),
});

export const scheduleRpc = defineRpc({
  name: "task-board.schedule",
  input: z
    .object({
      taskId: IdSchema,
      expectedRevision: RevisionSchema,
      trigger: TriggerSchema.nullable(),
    })
    .strict(),
  output: envelope(z.object({ task: BoardTaskSchema }).strict()),
});

export const setHierarchyRpc = defineRpc({
  name: "task-board.set-hierarchy",
  input: z
    .object({
      taskId: IdSchema,
      expectedRevision: RevisionSchema,
      parentId: IdSchema.nullable(),
    })
    .strict(),
  output: envelope(z.object({ task: BoardTaskSchema }).strict()),
});

export const HierarchySummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    inReview: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    todo: z.number().int().nonnegative(),
    planning: z.number().int().nonnegative(),
    percent: z.number().int().min(0).max(100),
  })
  .strict();

export const HierarchyResultSchema = z
  .object({
    task: BoardTaskSchema,
    parent: BoardTaskSchema.nullable(),
    children: z.array(BoardTaskSchema),
    summary: HierarchySummarySchema,
  })
  .strict();
export type HierarchyResult = z.infer<typeof HierarchyResultSchema>;

export const hierarchyRpc = defineRpc({
  name: "task-board.hierarchy",
  input: z.object({ taskId: IdSchema }).strict(),
  output: envelope(HierarchyResultSchema),
});

export const createRpc = defineRpc({
  name: "task-board.create",
  input: z
    .object({
      title: z.string().trim().min(1).max(200),
      description: z.string().optional(),
      acceptanceCriteria: z.array(z.string().trim().min(1)).optional(),
      priority: BoardPrioritySchema.optional(),
      labels: z.array(z.string().trim().min(1)).optional(),
      projectId: IdSchema.nullable().optional(),
      trigger: TriggerSchema.optional(),
      hierarchyParentId: IdSchema.nullable().optional(),
      clientRequestId: z.string().min(1).optional(),
    })
    .strict(),
  output: envelope(z.object({ task: BoardTaskSchema }).strict()),
});

export const updateRpc = defineRpc({
  name: "task-board.update",
  input: z
    .object({
      taskId: IdSchema,
      expectedRevision: RevisionSchema,
      patch: z
        .object({
          title: z.string().trim().min(1).max(200).optional(),
          description: z.string().nullable().optional(),
          acceptanceCriteria: z
            .array(z.string().trim().min(1))
            .nullable()
            .optional(),
          priority: BoardPrioritySchema.optional(),
          labels: z.array(z.string().trim().min(1)).optional(),
          projectId: IdSchema.nullable().optional(),
          hierarchyParentId: IdSchema.nullable().optional(),
        })
        .strict(),
    })
    .strict(),
  output: envelope(z.object({ task: BoardTaskSchema }).strict()),
});

export const setStatusRpc = defineRpc({
  name: "task-board.set-status",
  input: z
    .object({
      taskId: IdSchema,
      expectedRevision: RevisionSchema,
      status: BoardStatusSchema,
    })
    .strict(),
  output: envelope(z.object({ task: BoardTaskSchema }).strict()),
});

export const assignRpc = defineRpc({
  name: "task-board.assign",
  input: z
    .object({
      taskId: IdSchema,
      expectedRevision: RevisionSchema,
      projectId: IdSchema,
      workspaceId: IdSchema,
      agent: BoardAssignmentAgentSchema,
      message: z.string().trim().min(1).optional(),
      start: z.boolean().default(false),
    })
    .strict(),
  output: envelope(z.object({ task: BoardTaskSchema }).strict()),
});

export const startRpc = defineRpc({
  name: "task-board.start",
  input: z
    .object({
      taskId: IdSchema,
      message: z.string().trim().min(1).optional(),
    })
    .strict(),
  output: envelope(z.object({ task: BoardTaskSchema }).strict()),
});

export const stopRpc = defineRpc({
  name: "task-board.stop",
  input: z.object({ taskId: IdSchema }).strict(),
  output: envelope(z.object({ task: BoardTaskSchema }).strict()),
});

export const unassignRpc = defineRpc({
  name: "task-board.unassign",
  input: z
    .object({ taskId: IdSchema, expectedRevision: RevisionSchema })
    .strict(),
  output: envelope(z.object({ task: BoardTaskSchema }).strict()),
});

export const deleteRpc = defineRpc({
  name: "task-board.delete",
  input: z
    .object({ taskId: IdSchema, expectedRevision: RevisionSchema })
    .strict(),
  output: envelope(
    z.object({ deleted: z.boolean(), displayId: z.string().min(1) }).strict(),
  ),
});

export const cancelRpc = defineRpc({
  name: "task-board.cancel",
  input: z
    .object({ taskId: IdSchema, expectedRevision: RevisionSchema })
    .strict(),
  output: envelope(z.object({ task: BoardTaskSchema }).strict()),
});

export const declareRpc = defineRpc({
  name: "task-board.declare",
  input: z
    .object({
      taskId: IdSchema,
      agentId: IdSchema,
      kind: z.enum(["review", "blocked", "waiting", "progress", "clear"]),
      summary: z.string().trim().min(1).optional(),
      stage: z.string().trim().min(1).optional(),
      blockReason: z
        .enum(["human_required", "permission", "question", "manual"])
        .optional(),
      humanRequest: z
        .object({
          title: z.string().trim().min(1),
          instructions: z.string().trim().min(1),
          action: z
            .discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("open_url"),
                  url: z.string().trim().min(1),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("open_terminal"),
                  command: z.string().trim().min(1),
                })
                .strict(),
              z.object({ kind: z.literal("manual") }).strict(),
            ])
            .optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  output: envelope(
    z
      .object({
        task: BoardTaskSchema,
        accepted: z.boolean(),
      })
      .strict(),
  ),
});

export const progressRpc = defineRpc({
  name: "task-board.progress",
  input: z
    .object({
      taskId: IdSchema,
      agentId: IdSchema,
      summary: z.string().trim().min(1),
      stage: z.string().trim().min(1).optional(),
    })
    .strict(),
  output: envelope(
    z.object({ task: BoardTaskSchema, recorded: z.boolean() }).strict(),
  ),
});

export const candidatesRpc = defineRpc({
  name: "task-board.candidates",
  input: z.object({ projectId: IdSchema.optional() }).strict(),
  output: envelope(CandidatesResultSchema),
});

export const settingsGetRpc = defineRpc({
  name: "task-board.settings.get",
  input: emptyInput,
  output: envelope(z.object({ settings: BoardSettingsSchema }).strict()),
});

export const settingsUpdateRpc = defineRpc({
  name: "task-board.settings.update",
  input: z.object({ patch: BoardSettingsPatchSchema }).strict(),
  output: envelope(z.object({ settings: BoardSettingsSchema }).strict()),
});

export const NotificationAttemptSchema = z
  .object({
    at: z.string().min(1),
    ok: z.boolean(),
    status: z.number().int().optional(),
    error: z.string().optional(),
  })
  .strict();

export const notificationsTestRpc = defineRpc({
  name: "task-board.notifications.test",
  input: z.object({ webhookUrl: z.string().trim().min(1).optional() }).strict(),
  output: envelope(
    z
      .object({
        ok: z.boolean(),
        attempts: z.array(NotificationAttemptSchema),
        error: z.string().optional(),
      })
      .strict(),
  ),
});

export const MigrateLegacyInputSchema = z
  .object({
    dryRun: z.boolean().default(true),
    sourcePath: z.string().trim().min(1).optional(),
    includeFinished: z.boolean().default(true),
  })
  .strict();

export const MigrateLegacyReportSchema = z
  .object({
    dryRun: z.boolean(),
    noop: z.boolean(),
    sourcePath: z.string().min(1),
    sourceDigest: z.string().min(1),
    appliedAt: z.string().min(1),
    mapped: z.array(
      z
        .object({
          legacyId: z.string().min(1),
          taskId: z.string().min(1),
          displayId: z.string().min(1),
          status: BoardStatusSchema,
        })
        .strict(),
    ),
    skipped: z.array(
      z
        .object({
          legacyId: z.string().min(1),
          reason: z.string().min(1),
        })
        .strict(),
    ),
    conflicts: z.array(
      z
        .object({
          legacyId: z.string().min(1),
          kind: z.string().min(1),
          message: z.string().min(1),
        })
        .strict(),
    ),
    nextNumber: z.number().int().positive().optional(),
  })
  .strict();

export const migrateLegacyRpc = defineRpc({
  name: "task-board.migrate-legacy",
  input: MigrateLegacyInputSchema,
  output: envelope(MigrateLegacyReportSchema),
});

export const healthRpc = defineRpc({
  name: "task-board.health",
  input: emptyInput,
  output: envelope(HealthResultSchema),
});
