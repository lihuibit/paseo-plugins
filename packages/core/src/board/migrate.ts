import type {
  BoardActivity,
  BoardExecution,
  BoardStatus,
  BoardTask,
  BoardTaskDocument,
  Trigger,
} from "./types";
import {
  BOARD_STATUSES,
  BlockReasonSchema,
  BoardAssignmentSchema,
  BoardDeclarationSchema,
  PendingPermissionSchema,
  BoardPrioritySchema,
  BoardProgressSchema,
  ExecutionArchiveSchema,
  TriggerSchema,
} from "./types";

interface LegacyRecord {
  [key: string]: unknown;
}

export interface LegacyMigrationOptions {
  now: string;
  includeFinished: boolean;
  existingTaskIds: ReadonlySet<string>;
  existingDisplayIds: ReadonlySet<string>;
  nextNumber: number;
  createId: (legacyId: string, index: number) => string;
  agentExists: (agentId: string) => boolean;
}

export interface LegacyMigrationEntry {
  legacyId: string;
  taskId: string;
  displayId: string;
  status: BoardStatus;
}

export interface LegacyMigrationReport {
  mapped: LegacyMigrationEntry[];
  skipped: Array<{ legacyId: string; reason: string }>;
  conflicts: Array<{ legacyId: string; kind: string; message: string }>;
}

function record(value: unknown): LegacyRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as LegacyRecord;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return list.length > 0 ? list : undefined;
}

function legacyTasks(document: unknown): LegacyRecord[] {
  const records = (values: unknown[]): LegacyRecord[] =>
    values.flatMap((value) => {
      const item = record(value);
      return item ? [item] : [];
    });
  if (Array.isArray(document)) return records(document);
  const root = record(document);
  if (!root) return [];
  if (Array.isArray(root.tasks)) return records(root.tasks);
  return [];
}

function legacyNextNumber(document: unknown): number | null {
  const root = record(document);
  const value = root?.nextNumber;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function mapStatus(value: unknown): BoardStatus {
  return typeof value === "string" &&
    (BOARD_STATUSES as readonly string[]).includes(value)
    ? (value as BoardStatus)
    : "planning";
}

function mapExecution(
  value: unknown,
  agentExists: (agentId: string) => boolean,
  report: LegacyMigrationReport,
  legacyId: string,
): BoardExecution | null {
  const execution = record(value);
  if (!execution) return null;
  if (execution.kind !== "agent") {
    report.conflicts.push({
      legacyId,
      kind: "execution",
      message: `Unsupported execution kind: ${String(execution.kind)}`,
    });
    return null;
  }
  const agentId = text(execution.agentId);
  if (!agentId) return null;
  if (!agentExists(agentId)) {
    report.conflicts.push({
      legacyId,
      kind: "agent",
      message: `Agent ${agentId} no longer exists; execution dropped`,
    });
    return null;
  }
  const project = record(execution.project);
  const workspace = record(execution.workspace);
  const startedAt = text(execution.startedAt);
  if (!project || !workspace || !startedAt) return null;
  return {
    kind: "agent",
    project: {
      projectId: text(project.projectId) ?? "",
      projectName: text(project.projectName) ?? "",
      projectRoot: text(project.projectRoot) ?? "",
    },
    workspace: {
      workspaceId: text(workspace.workspaceId) ?? "",
      workspaceName: text(workspace.workspaceName) ?? "",
      workspaceDirectory: text(workspace.workspaceDirectory) ?? "",
      created: workspace.created === true,
    },
    agentId,
    agentTitle: text(execution.agentTitle),
    provider: text(execution.provider) ?? "unknown",
    model: text(execution.model),
    agentCreated: execution.agentCreated === true,
    startedAt,
    lastActivityAt: text(execution.lastActivityAt) ?? undefined,
    finishedAt: text(execution.finishedAt) ?? undefined,
    turnEndedAt: text(execution.turnEndedAt) ?? undefined,
    lastLifecycle: text(execution.lastLifecycle) ?? undefined,
    lastTurnId: text(execution.lastTurnId) ?? undefined,
  };
}

function mapActivity(value: unknown): BoardActivity[] {
  if (!Array.isArray(value)) return [];
  const kinds = new Set<string>([
    "created",
    "updated",
    "assigned",
    "unassigned",
    "status_changed",
    "execution_synced",
    "parent_changed",
    "scheduled",
    "permission_requested",
    "permission_resolved",
    "migrated",
    "note",
    "progress",
  ]);
  const activity: BoardActivity[] = [];
  for (const entry of value) {
    const item = record(entry);
    const at = text(item?.at);
    const kind = text(item?.kind);
    if (!at || !kind || !kinds.has(kind)) continue;
    const detail = record(item?.detail);
    activity.push({
      at,
      kind: kind as BoardActivity["kind"],
      detail: detail ?? undefined,
    });
  }
  return activity;
}

export function mapLegacyDocument(
  document: unknown,
  options: LegacyMigrationOptions,
): { tasks: BoardTask[]; report: LegacyMigrationReport; nextNumber: number } {
  const report: LegacyMigrationReport = {
    mapped: [],
    skipped: [],
    conflicts: [],
  };
  const entries = legacyTasks(document);
  let nextNumber =
    Math.max(options.nextNumber, legacyNextNumber(document) ?? 1) || 1;
  const usedIds = new Set(options.existingTaskIds);
  const usedDisplayIds = new Set(options.existingDisplayIds);
  const idMap = new Map<string, string>();

  interface Prepared {
    legacyId: string;
    taskId: string;
    displayId: string;
    source: LegacyRecord;
  }
  const prepared: Prepared[] = [];

  entries.forEach((source, index) => {
    const legacyId =
      text(source.id) ?? `legacy-${String(index + 1).padStart(4, "0")}`;
    const title = text(source.title);
    if (!title) {
      report.skipped.push({ legacyId, reason: "missing title" });
      return;
    }
    const status = mapStatus(source.status);
    if (
      !options.includeFinished &&
      (status === "done" || status === "cancelled")
    ) {
      report.skipped.push({ legacyId, reason: "finished task excluded" });
      return;
    }

    let taskId = legacyId;
    if (!taskId.startsWith("btask_") || usedIds.has(taskId)) {
      taskId = options.createId(legacyId, index);
      while (usedIds.has(taskId)) taskId = options.createId(legacyId, index);
      report.conflicts.push({
        legacyId,
        kind: "id",
        message: `Task id ${legacyId} was remapped to ${taskId}`,
      });
    }
    usedIds.add(taskId);
    idMap.set(legacyId, taskId);

    let displayId = text(source.displayId) ?? `TASK-${nextNumber}`;
    if (usedDisplayIds.has(displayId)) {
      const replacement = `TASK-${nextNumber}`;
      report.conflicts.push({
        legacyId,
        kind: "displayId",
        message: `Display id ${displayId} was remapped to ${replacement}`,
      });
      displayId = replacement;
    }
    while (usedDisplayIds.has(displayId)) {
      nextNumber += 1;
      displayId = `TASK-${nextNumber}`;
    }
    usedDisplayIds.add(displayId);
    nextNumber = Math.max(nextNumber, Number(displayId.slice(5)) + 1 || 1);

    prepared.push({ legacyId, taskId, displayId, source });
  });

  const tasks: BoardTask[] = [];
  for (const entry of prepared) {
    const { source, legacyId, taskId, displayId } = entry;
    const status = mapStatus(source.status);
    if (
      typeof source.status === "string" &&
      !(BOARD_STATUSES as readonly string[]).includes(source.status)
    ) {
      report.conflicts.push({
        legacyId,
        kind: "status",
        message: `Unknown status ${source.status}; fell back to planning`,
      });
    }
    const priority = BoardPrioritySchema.safeParse(source.priority);
    const trigger = TriggerSchema.safeParse(source.trigger);
    const archive = ExecutionArchiveSchema.safeParse(source.executionArchive);
    const execution = mapExecution(
      source.execution,
      options.agentExists,
      report,
      legacyId,
    );
    const assignment = BoardAssignmentSchema.safeParse(source.assignment);
    const blockReason = BlockReasonSchema.safeParse(source.blockReason);
    const declaration = BoardDeclarationSchema.safeParse(source.declaration);
    const progress = BoardProgressSchema.safeParse(source.progress);
    const pendingPermission = PendingPermissionSchema.safeParse(
      source.pendingPermission,
    );
    const hierarchyParent = text(source.hierarchyParentId);
    const parentTaskId = text(source.parentTaskId);
    const mappedHierarchyParent =
      hierarchyParent &&
      (idMap.has(hierarchyParent) ||
        options.existingTaskIds.has(hierarchyParent))
        ? (idMap.get(hierarchyParent) ?? hierarchyParent)
        : null;
    if (hierarchyParent && !mappedHierarchyParent) {
      report.conflicts.push({
        legacyId,
        kind: "hierarchy",
        message: `Parent ${hierarchyParent} was not migrated; task moved to top level`,
      });
    }
    const createdAt = text(source.createdAt) ?? options.now;
    const updatedAt = text(source.updatedAt) ?? createdAt;

    tasks.push({
      id: taskId,
      displayId,
      title: text(source.title) ?? legacyId,
      kind: "task",
      description: text(source.description) ?? undefined,
      acceptanceCriteria: stringList(source.acceptanceCriteria),
      status,
      priority: priority.success ? priority.data : "none",
      labels: stringList(source.labels) ?? [],
      projectId: text(source.projectId),
      execution,
      assignment: assignment.success ? assignment.data : undefined,
      trigger: trigger.success ? (trigger.data as Trigger) : undefined,
      nextRunAt: text(source.nextRunAt),
      derivedCount: integer(source.derivedCount) ?? 0,
      parentTaskId: parentTaskId
        ? (idMap.get(parentTaskId) ?? parentTaskId)
        : undefined,
      hierarchyParentId: mappedHierarchyParent,
      executionArchive: archive.success ? archive.data : "none",
      blockReason: blockReason.success ? blockReason.data : undefined,
      blockDetail: text(source.blockDetail) ?? undefined,
      pendingPermission: pendingPermission.success
        ? pendingPermission.data
        : undefined,
      declaration: declaration.success ? declaration.data : undefined,
      progress: progress.success ? progress.data : undefined,
      runCount: integer(source.runCount) ?? 0,
      pendingStopAt: text(source.pendingStopAt) ?? undefined,
      manualStatusAt: text(source.manualStatusAt) ?? undefined,
      revision: integer(source.revision) ?? 0,
      createdAt,
      updatedAt,
      activity: mapActivity(source.activity),
    });
    report.mapped.push({ legacyId, taskId, displayId, status });
  }

  return { tasks, report, nextNumber };
}

export function mergeLegacyTasks(
  current: BoardTaskDocument,
  tasks: readonly BoardTask[],
  nextNumber: number,
): BoardTaskDocument {
  return {
    version: 1,
    nextNumber: Math.max(current.nextNumber, nextNumber),
    tasks: [...current.tasks, ...tasks],
  };
}
