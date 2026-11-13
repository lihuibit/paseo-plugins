export type BoardStatus =
  | "planning"
  | "todo"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "done"
  | "cancelled";

export type LogFilter = "all" | "text" | "tools" | "errors" | "permissions";

export interface AgentSummary {
  agentId: string;
  title: string | null;
  lifecycle: string;
  provider: string;
  model: string | null;
  modeId: string | null;
  workspaceId: string | null;
  pendingPermissions: Array<{
    requestId: string;
    kind: string;
    title: string;
    description?: string;
  }>;
  activeTurn: { turnId: string; startedAt: string | null } | null;
  lastError: string | null;
  lastUsage: unknown;
  archivedAt: string | null;
  background: boolean;
}

export interface TaskExecution {
  kind: "agent";
  agentId: string;
  agentTitle: string | null;
  provider: string;
  model: string | null;
  agentCreated: boolean;
  startedAt: string;
  lastLifecycle?: string;
  project: {
    projectId: string;
    projectName: string;
    projectRoot: string;
  };
  workspace: {
    workspaceId: string;
    workspaceName: string;
    workspaceDirectory: string;
    created: boolean;
  };
}

export interface BoardTask {
  id: string;
  displayId: string;
  title: string;
  kind: "task" | "task-planning";
  description?: string;
  acceptanceCriteria?: string[];
  status: BoardStatus;
  priority: string;
  labels: string[];
  projectId: string | null;
  hierarchyParentId: string | null;
  parentTaskId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  execution: TaskExecution | null;
  assignment?: {
    mode: "agent";
    projectId: string;
    projectName: string;
    workspaceId: string;
    workspaceName: string;
    agent: {
      kind: "existing" | "create";
      agentId?: string;
      provider?: string;
      model?: string;
      modeId?: string;
      thinkingOptionId?: string;
      title?: string;
    };
  };
  trigger?: unknown;
  nextRunAt?: string | null;
  blockReason?: string;
  blockDetail?: string;
  pendingPermission?: {
    requestId: string;
    kind: string;
    title: string;
    detail?: string;
    at: string;
  };
  declaration?: {
    kind: string;
    summary?: string;
    blockReason?: string;
    agentId: string;
    declaredAt: string;
  };
  progress?: {
    summary: string;
    stage?: string;
    at: string;
  };
  activity?: Array<{
    at: string;
    kind: string;
    detail?: Record<string, unknown>;
  }>;
}

export interface TaskSummary {
  id: string;
  displayId: string;
  title: string;
  kind: "task" | "task-planning";
  status: BoardStatus;
  priority: string;
  labels: string[];
  projectId: string | null;
  hierarchyParentId: string | null;
  parentTaskId: string | null;
  revision: number;
  updatedAt: string;
  blockReason: string | null;
  blockDetail: string | null;
  progress: {
    summary: string;
    stage?: string;
    at: string;
  } | null;
  declaration: {
    kind: string;
    summary?: string;
    blockReason?: string;
    agentId: string;
    declaredAt: string;
  } | null;
  execution: {
    agentId: string;
    agentTitle: string | null;
    provider: string;
    model: string | null;
    lastLifecycle: string | null;
    startedAt: string;
  } | null;
  agent: AgentSummary | null;
}

export interface StatusResult {
  task: TaskSummary;
  agent: AgentSummary | null;
  recentActivity: string[];
}

export interface LogEntry {
  at: string;
  kind: "assistant" | "user" | "tool" | "error" | "permission";
  text?: string;
  name?: string;
  status?: string;
  error?: string;
  requestId?: string;
}

export interface LogsResult {
  taskId: string;
  agentId: string;
  filter: LogFilter;
  entries: LogEntry[];
  hasOlder: boolean;
  error: string | null;
}

export interface BoardEvent {
  at: string;
  kind: string;
  taskId?: string;
  detail?: Record<string, unknown>;
}

export interface Profile {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  notes?: string;
}

export interface Candidates {
  projects: Array<{
    projectId: string;
    name: string;
    rootPath: string;
    workspaces: Array<{
      workspaceId: string;
      name: string;
      directory: string;
      kind: string;
      background: boolean;
    }>;
    agents: Array<{
      agentId: string;
      title: string | null;
      provider: string;
      status: string;
    }>;
  }>;
  profiles: Profile[];
  providers: Array<{
    provider: string;
    label: string;
    available: boolean;
  }>;
}

export interface ProviderOptions {
  provider: string;
  cwd: string | null;
  models: Array<{
    id: string;
    label: string;
    description?: string;
    isDefault: boolean;
    defaultThinkingOptionId?: string;
    thinkingOptions: Array<{
      id: string;
      label: string;
      description?: string;
      isDefault: boolean;
    }>;
  }>;
  modes: Array<{ id: string; label: string; description?: string }>;
  error: string | null;
}
