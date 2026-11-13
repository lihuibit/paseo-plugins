import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { envelope } from "./core/board/errors";
import {
  BoardAssignmentAgentSchema,
  BoardDeclarationSchema,
  BoardPrioritySchema,
  BoardProgressSchema,
  BoardStatusSchema,
  BoardTaskSchema,
  BoardTaskKindSchema,
  TriggerSchema,
} from "./core/board/types";
import { BoardSettingsPatchSchema, BoardSettingsSchema } from "./settings";

const IdSchema = z.string().min(1);
const RevisionSchema = z.number().int().nonnegative();

export const PaseoAgentProfileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    modeId: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
  })
  .strict();
export type PaseoAgentProfile = z.infer<typeof PaseoAgentProfileSchema>;

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
    profiles: z.array(PaseoAgentProfileSchema),
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

export const ProviderModelSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    isDefault: z.boolean(),
    defaultThinkingOptionId: z.string().min(1).optional(),
    thinkingOptions: z.array(
      z
        .object({
          id: z.string().min(1),
          label: z.string().min(1),
          description: z.string().optional(),
          isDefault: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export const ProviderModeSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();

export const ProviderOptionsResultSchema = z
  .object({
    provider: z.string().min(1),
    cwd: z.string().min(1).nullable(),
    models: z.array(ProviderModelSchema),
    modes: z.array(ProviderModeSchema),
    error: z.string().nullable(),
  })
  .strict();
export type ProviderOptionsResult = z.infer<typeof ProviderOptionsResultSchema>;

export const ProfilesResultSchema = z
  .object({ profiles: z.array(PaseoAgentProfileSchema) })
  .strict();
export type ProfilesResult = z.infer<typeof ProfilesResultSchema>;

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

export const AgentSummarySchema = z
  .object({
    agentId: z.string().min(1),
    title: z.string().nullable(),
    lifecycle: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().nullable(),
    modeId: z.string().nullable(),
    workspaceId: z.string().nullable(),
    pendingPermissions: z.array(
      z
        .object({
          requestId: z.string().min(1),
          kind: z.string().min(1),
          title: z.string().min(1),
          description: z.string().optional(),
        })
        .strict(),
    ),
    activeTurn: z
      .object({
        turnId: z.string().min(1),
        startedAt: z.string().nullable(),
      })
      .strict()
      .nullable(),
    lastError: z.string().nullable(),
    lastUsage: z.unknown(),
    archivedAt: z.string().nullable(),
    background: z.boolean(),
  })
  .strict();
export type AgentSummaryResult = z.infer<typeof AgentSummarySchema>;

export const TaskSummarySchema = z
  .object({
    id: z.string().min(1),
    displayId: z.string().min(1),
    title: z.string().min(1),
    kind: BoardTaskKindSchema,
    status: BoardStatusSchema,
    priority: BoardPrioritySchema,
    labels: z.array(z.string().min(1)),
    projectId: z.string().nullable(),
    hierarchyParentId: z.string().nullable(),
    parentTaskId: z.string().nullable(),
    revision: RevisionSchema,
    updatedAt: z.string().min(1),
    blockReason: z.string().nullable(),
    blockDetail: z.string().nullable(),
    progress: BoardProgressSchema.nullable(),
    declaration: BoardDeclarationSchema.nullable(),
    execution: z
      .object({
        agentId: z.string().min(1),
        agentTitle: z.string().nullable(),
        provider: z.string().min(1),
        model: z.string().nullable(),
        lastLifecycle: z.string().nullable(),
        startedAt: z.string().min(1),
      })
      .strict()
      .nullable(),
    agent: AgentSummarySchema.nullable(),
  })
  .strict();
export type TaskSummaryResult = z.infer<typeof TaskSummarySchema>;

export const LogEntrySchema = z
  .object({
    at: z.string().min(1),
    kind: z.enum(["assistant", "user", "tool", "error", "permission"]),
    text: z.string().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
    error: z.string().optional(),
    requestId: z.string().optional(),
  })
  .strict();

export const logFilterSchema = z
  .enum(["all", "text", "tools", "errors", "permissions"])
  .default("all");

export const listSummaryRpc = defineRpc({
  name: "task-board.list-summary",
  input: z
    .object({
      status: BoardStatusSchema.optional(),
      projectId: IdSchema.optional(),
      label: z.string().min(1).optional(),
      query: z.string().optional(),
      hierarchyParentId: IdSchema.nullable().optional(),
      includeFinished: z.boolean().default(true),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  output: envelope(
    z
      .object({
        tasks: z.array(TaskSummarySchema),
        total: z.number().int().nonnegative(),
        counts: z.record(z.string(), z.number()),
      })
      .strict(),
  ),
});

export const listRpc = defineRpc({
  name: "task-board.list",
  input: z
    .object({
      status: BoardStatusSchema.optional(),
      projectId: IdSchema.optional(),
      label: z.string().min(1).optional(),
      query: z.string().optional(),
      hierarchyParentId: IdSchema.nullable().optional(),
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
      status: BoardStatusSchema.optional(),
      kind: BoardTaskKindSchema.optional(),
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

export const profilesListRpc = defineRpc({
  name: "task-board.profiles.list",
  input: emptyInput,
  output: envelope(ProfilesResultSchema),
});

export const providerOptionsRpc = defineRpc({
  name: "task-board.provider-options",
  input: z
    .object({
      provider: z.string().trim().min(1),
      cwd: z.string().trim().min(1).optional(),
    })
    .strict(),
  output: envelope(ProviderOptionsResultSchema),
});

export const providersRpc = defineRpc({
  name: "task-board.providers",
  input: z
    .object({
      provider: z.string().trim().min(1).optional(),
      cwd: z.string().trim().min(1).optional(),
    })
    .strict(),
  output: envelope(
    z
      .object({
        providers: z.array(
          z
            .object({
              provider: z.string().min(1),
              available: z.boolean(),
            })
            .strict(),
        ),
        catalog: ProviderOptionsResultSchema.optional(),
      })
      .strict(),
  ),
});

export const statusRpc = defineRpc({
  name: "task-board.status",
  input: z
    .object({
      taskId: IdSchema,
      tail: z.number().int().min(1).max(20).default(5),
    })
    .strict(),
  output: envelope(
    z
      .object({
        task: TaskSummarySchema,
        agent: AgentSummarySchema.nullable(),
        recentActivity: z.array(z.string()),
      })
      .strict(),
  ),
});

export const logsRpc = defineRpc({
  name: "task-board.logs",
  input: z
    .object({
      taskId: IdSchema,
      limit: z.number().int().min(1).max(200).default(20),
      filter: logFilterSchema,
    })
    .strict(),
  output: envelope(
    z
      .object({
        taskId: z.string().min(1),
        agentId: z.string().min(1),
        filter: z.enum(["all", "text", "tools", "errors", "permissions"]),
        entries: z.array(LogEntrySchema),
        hasOlder: z.boolean(),
        error: z.string().nullable(),
      })
      .strict(),
  ),
});

export const eventsRpc = defineRpc({
  name: "task-board.events",
  input: z
    .object({
      taskId: IdSchema.optional(),
      kind: z.string().trim().min(1).optional(),
      limit: z.number().int().min(1).max(500).default(50),
    })
    .strict(),
  output: envelope(
    z
      .object({
        events: z.array(
          z
            .object({
              at: z.string().min(1),
              kind: z.string().min(1),
              taskId: z.string().min(1).optional(),
              detail: z.record(z.string(), z.unknown()).optional(),
            })
            .strict(),
        ),
      })
      .strict(),
  ),
});

export const WaitForFinishResultSchema = z
  .object({
    status: z.enum(["idle", "error", "permission", "timeout"]),
    final: z.unknown().nullable(),
    error: z.string().nullable(),
    lastMessage: z.string().nullable(),
  })
  .strict();

export const sendRpc = defineRpc({
  name: "task-board.send",
  input: z
    .object({
      taskId: IdSchema,
      message: z.string().trim().min(1),
      waitSeconds: z.number().int().min(0).max(300).default(0),
    })
    .strict(),
  output: envelope(
    z
      .object({
        task: TaskSummarySchema,
        wait: WaitForFinishResultSchema.nullable(),
      })
      .strict(),
  ),
});

export const waitRpc = defineRpc({
  name: "task-board.wait",
  input: z
    .object({
      taskId: IdSchema,
      until: z
        .array(z.enum(["review", "blocked", "idle"]))
        .min(1)
        .default(["review", "blocked"]),
      timeoutMs: z.number().int().min(1_000).max(120_000).default(60_000),
    })
    .strict(),
  output: envelope(
    z
      .object({
        reached: z.enum(["review", "blocked", "idle"]).nullable(),
        task: BoardTaskSchema,
        agent: AgentSummarySchema.nullable(),
      })
      .strict(),
  ),
});

export const doneRpc = defineRpc({
  name: "task-board.done",
  input: z
    .object({
      taskId: IdSchema,
      expectedRevision: RevisionSchema.optional(),
    })
    .strict(),
  output: envelope(z.object({ task: TaskSummarySchema }).strict()),
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
