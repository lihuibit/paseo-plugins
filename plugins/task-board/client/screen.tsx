import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import {
  BLOCK_REASON_LABELS,
  BOARD_PRIORITY_LABELS,
  BOARD_STATUSES,
  BOARD_STATUS_LABELS,
  type BoardStatus,
  type BoardTask,
} from "../shared/core/board/types";
import {
  healthRpc,
  listRpc,
  setStatusRpc,
  startRpc,
} from "../shared/contracts";
import { AssignTaskSheet } from "./assign-task-sheet";
import { CreateTaskSheet } from "./create-task-sheet";
import { SettingsSheet } from "./settings-sheet";
import { TaskDetail } from "./task-detail";
import {
  Alert,
  Button,
  Hint,
  OverlayMenuProvider,
  SearchField,
  SegmentedControl,
  StatusBadge,
  StatusDot,
  StatusMenuTrigger,
  SwitchControl,
  useOverlayMenu,
} from "./ui/components";
import { createTokens, type Tokens } from "./ui/tokens";

type ExecutionFilter = "all" | "unassigned" | "agent" | "pipeline";
type ViewMode = "board" | "list";

const EXECUTION_FILTERS: Array<{ value: ExecutionFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "unassigned", label: "未分配" },
  { value: "agent", label: "Agent" },
  { value: "pipeline", label: "流水线" },
];

const VIEW_MODES: Array<{ value: ViewMode; label: string; icon: string }> = [
  { value: "board", label: "看板", icon: "Columns3" },
  { value: "list", label: "列表", icon: "List" },
];

function executionKind(task: BoardTask): "agent" | "pipeline" | "unassigned" {
  return task.execution?.kind ?? task.assignment?.mode ?? "unassigned";
}

function matchesQuery(task: BoardTask, query: string): boolean {
  const value = query.trim().toLowerCase();
  if (!value) return true;
  return `${task.displayId} ${task.title} ${task.description ?? ""} ${task.labels.join(" ")}`
    .toLowerCase()
    .includes(value);
}

function timeAgo(iso: string): string {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function priorityStyle(priority: BoardTask["priority"], tokens: Tokens) {
  if (priority === "urgent") return { color: tokens.colors.destructive };
  if (priority === "high") return { color: tokens.colors.foreground };
  return { color: tokens.colors.foregroundMuted };
}

function cardEdge(status: BoardStatus, tokens: Tokens) {
  switch (status) {
    case "in_progress":
      return {
        borderLeftWidth: 3,
        borderLeftColor: tokens.colors.statusDotRunning,
        paddingLeft: tokens.spacing[2],
      };
    case "in_review":
      return {
        borderLeftWidth: 3,
        borderLeftColor: tokens.colors.statusDotWarning,
        paddingLeft: tokens.spacing[2],
      };
    case "blocked":
      return {
        borderLeftWidth: 3,
        borderLeftColor: tokens.colors.statusDotDanger,
        paddingLeft: tokens.spacing[2],
        backgroundColor: tokens.colors.surface1,
      };
    case "cancelled":
      return { opacity: 0.5 };
    default:
      return undefined;
  }
}

function childrenOf(tasks: BoardTask[], taskId: string): BoardTask[] {
  return tasks.filter((task) => task.hierarchyParentId === taskId);
}

function TaskBoardContent({
  theme,
  host,
  navigation,
  params,
}: Pick<PluginScreenProps, "theme" | "host" | "navigation" | "params">) {
  const { width: windowWidth } = useWindowDimensions();
  const compact = windowWidth < 760;
  const tokens = useMemo(() => createTokens(theme), [theme]);
  const list = useRpc(listRpc);
  const health = useRpc(healthRpc);
  const setStatus = useRpc(setStatusRpc);
  const start = useRpc(startRpc);
  const { openMenu } = useOverlayMenu();

  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toolInjectionEnabled, setToolInjectionEnabled] = useState(true);
  const [query, setQuery] = useState("");
  const [executionFilter, setExecutionFilter] =
    useState<ExecutionFilter>("all");
  const [topLevelOnly, setTopLevelOnly] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("board");
  const [collapsed, setCollapsed] = useState<Set<BoardStatus>>(
    () => new Set<BoardStatus>(["done", "cancelled"]),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [assignState, setAssignState] = useState<{
    task: BoardTask;
    intent: "assign" | "reassign";
  } | null>(null);
  const [createOpen, setCreateOpen] = useState(params.new === "1");
  const [createStatus, setCreateStatus] = useState<BoardStatus>("planning");
  const [createParentId, setCreateParentId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refresh = useCallback(async () => {
    const envelope = await list({ includeFinished: true });
    if (!envelope.ok) {
      setError(`${envelope.error.code}: ${envelope.error.message}`);
      return;
    }
    setTasks(envelope.value.tasks);
    setLoading(false);
  }, [list]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let active = true;
    void health({}).then((envelope) => {
      if (active && envelope.ok) {
        setToolInjectionEnabled(envelope.value.toolInjectionEnabled);
      }
    });
    return () => {
      active = false;
    };
  }, [health]);

  const visibleRows = useMemo(() => {
    const filtered = tasks.filter((task) => {
      if (!matchesQuery(task, query)) return false;
      if (
        executionFilter !== "all" &&
        executionKind(task) !== executionFilter
      ) {
        return false;
      }
      if (topLevelOnly && task.hierarchyParentId) return false;
      return true;
    });
    return filtered.sort((left, right) => {
      const byStatus =
        BOARD_STATUSES.indexOf(left.status) -
        BOARD_STATUSES.indexOf(right.status);
      if (byStatus !== 0) return byStatus;
      return right.updatedAt.localeCompare(left.updatedAt);
    });
  }, [executionFilter, query, tasks, topLevelOnly]);

  const selected = selectedId
    ? (tasks.find((task) => task.id === selectedId) ?? null)
    : null;

  const upsertTask = useCallback((task: BoardTask) => {
    setTasks((current) => {
      const found = current.some((entry) => entry.id === task.id);
      return found
        ? current.map((entry) => (entry.id === task.id ? task : entry))
        : [task, ...current];
    });
  }, []);

  const handleChanged = useCallback(
    (task: BoardTask | null) => {
      if (!task) {
        setSelectedId(null);
        void refresh();
        return;
      }
      upsertTask(task);
      void refresh();
    },
    [refresh, upsertTask],
  );

  const changeStatus = useCallback(
    async (task: BoardTask, status: BoardStatus) => {
      setError(null);
      const envelope = await setStatus({
        taskId: task.id,
        expectedRevision: task.revision,
        status,
      });
      if (!envelope.ok) {
        setError(
          envelope.error.code === "E_REVISION_CONFLICT"
            ? "409 revision 冲突：卡片已被其他操作更新，请刷新后重试。"
            : `${envelope.error.code}: ${envelope.error.message}`,
        );
        return;
      }
      upsertTask(envelope.value.task);
      setNotice(`状态已改为「${BOARD_STATUS_LABELS[status]}」`);
      void refresh();
    },
    [refresh, setStatus, upsertTask],
  );

  const openStatusMenu = useCallback(
    (task: BoardTask) => {
      openMenu({
        title: `切换 ${task.displayId} 状态`,
        options: BOARD_STATUSES.map((status) => ({
          value: status,
          label: BOARD_STATUS_LABELS[status],
        })),
        selected: task.status,
        onSelect: (value) => void changeStatus(task, value as BoardStatus),
      });
    },
    [changeStatus, openMenu],
  );

  const runTask = useCallback(
    async (task: BoardTask) => {
      setError(null);
      const envelope = await start({ taskId: task.id });
      if (!envelope.ok) {
        setError(`${envelope.error.code}: ${envelope.error.message}`);
        return;
      }
      upsertTask(envelope.value.task);
      void refresh();
    },
    [refresh, start, upsertTask],
  );

  const openCreate = useCallback(
    (status: BoardStatus, parentId: string | null = null) => {
      setCreateStatus(status);
      setCreateParentId(parentId);
      setCreateOpen(true);
    },
    [],
  );

  const openTask = useCallback((taskId: string) => setSelectedId(taskId), []);

  const openExecution = useCallback(
    (task: BoardTask) => {
      if (task.execution?.agentId) {
        navigation?.openAgent?.({ agentId: task.execution.agentId });
      }
    },
    [navigation],
  );

  return (
    <View style={{ flex: 1, backgroundColor: tokens.colors.surfaceWorkspace }}>
      <View
        style={{
          flex: 1,
          gap: tokens.spacing[4],
          padding: tokens.spacing[4],
          minHeight: 0,
        }}
      >
        {selected ? (
          <TaskDetail
            task={selected}
            tasks={tasks}
            tokens={tokens}
            compact={compact}
            navigation={navigation}
            onBack={() => setSelectedId(null)}
            onRefresh={async () => {
              await refresh();
            }}
            onChanged={handleChanged}
            onAssign={(task) =>
              setAssignState({
                task,
                intent: task.execution ? "assign" : "reassign",
              })
            }
            onCreateChild={(parentId) => openCreate("planning", parentId)}
            onOpenTask={openTask}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : (
          <>
            <View
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: tokens.spacing[3],
              }}
            >
              <View
                style={{
                  flexGrow: 1,
                  flexShrink: 1,
                  flexBasis: 280,
                  gap: tokens.spacing[1],
                }}
              >
                <Text
                  style={{
                    color: tokens.colors.foreground,
                    fontSize: tokens.fontSize.base,
                    fontWeight: "500",
                  }}
                >
                  任务看板
                </Text>
                <Text
                  style={{
                    color: tokens.colors.foregroundMuted,
                    fontSize: tokens.fontSize.sm,
                  }}
                >
                  跨工作区的任务；分配后由独立 Agent
                  或流水线执行，跑完进入待验收。
                </Text>
              </View>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: tokens.spacing[2],
                }}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  icon="Settings"
                  onPress={() => setSettingsOpen(true)}
                  tokens={tokens}
                  accessibilityLabel="通知与设置"
                  testID="task-board-settings-open"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  icon="Plus"
                  onPress={() => openCreate("planning")}
                  tokens={tokens}
                  testID="task-board-create-open"
                >
                  新建任务
                </Button>
              </View>
            </View>

            <View
              style={{
                flexDirection: compact ? "column" : "row",
                alignItems: compact ? "stretch" : "center",
                flexWrap: "wrap",
                gap: tokens.spacing[3],
              }}
            >
              <View
                style={{
                  flexGrow: 1,
                  flexShrink: 1,
                  flexBasis: compact ? "auto" : 240,
                  maxWidth: compact ? "100%" : 420,
                }}
              >
                <SearchField
                  value={query}
                  onChangeText={setQuery}
                  placeholder="搜索标题、编号或标签"
                  tokens={tokens}
                  testID="tasks-search"
                />
              </View>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: tokens.spacing[2],
                }}
              >
                <SegmentedControl
                  options={EXECUTION_FILTERS.map((entry) => ({
                    ...entry,
                    testID: `tasks-filter-${entry.value}`,
                  }))}
                  value={executionFilter}
                  onValueChange={setExecutionFilter}
                  tokens={tokens}
                  size={compact ? "xs" : "sm"}
                />
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: tokens.spacing[2],
                  }}
                >
                  <Text
                    style={{
                      color: tokens.colors.foregroundMuted,
                      fontSize: tokens.fontSize.sm,
                    }}
                  >
                    只看顶层
                  </Text>
                  <SwitchControl
                    value={topLevelOnly}
                    onValueChange={setTopLevelOnly}
                    tokens={tokens}
                    testID="tasks-filter-top-level"
                  />
                </View>
                <View style={{ flexGrow: 1 }} />
                <SegmentedControl
                  options={VIEW_MODES}
                  value={viewMode}
                  onValueChange={setViewMode}
                  tokens={tokens}
                  size={compact ? "xs" : "sm"}
                  hideLabels
                />
              </View>
            </View>

            {!toolInjectionEnabled ? (
              <Alert
                variant="error"
                title="board_declare 未注入"
                description="宿主 daemon.mcp.injectIntoAgents=false。Agent 只能依赖 hooks 推断状态；请在宿主配置开启后重启 daemon。"
                tokens={tokens}
              />
            ) : null}
            {notice ? (
              <Alert variant="success" title={notice} tokens={tokens} />
            ) : null}
            {error ? (
              <Alert
                variant="error"
                title="操作失败"
                description={error}
                tokens={tokens}
              />
            ) : null}

            {viewMode === "list" ? (
              <TaskList
                tasks={visibleRows}
                allTasks={tasks}
                loading={loading}
                tokens={tokens}
                compact={compact}
                collapsed={collapsed}
                onToggleCollapsed={(status) =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(status)) next.delete(status);
                    else next.add(status);
                    return next;
                  })
                }
                onOpenTask={openTask}
                onAssign={(task) => setAssignState({ task, intent: "assign" })}
                onStatus={openStatusMenu}
                onRun={(task) => void runTask(task)}
                onOpenExecution={openExecution}
                onCreate={openCreate}
              />
            ) : (
              <TaskBoard
                tasks={visibleRows}
                allTasks={tasks}
                loading={loading}
                compact={compact}
                tokens={tokens}
                onCreate={openCreate}
                onOpenTask={openTask}
                onAssign={(task) => setAssignState({ task, intent: "assign" })}
                onStatus={openStatusMenu}
                onRun={(task) => void runTask(task)}
                onOpenExecution={openExecution}
              />
            )}
          </>
        )}
      </View>

      <CreateTaskSheet
        visible={createOpen}
        initialStatus={createStatus}
        initialParentId={createParentId}
        tasks={tasks}
        tokens={tokens}
        compact={compact}
        onClose={() => setCreateOpen(false)}
        onCreated={(task) => {
          setCreateOpen(false);
          upsertTask(task);
          void refresh();
        }}
      />
      <AssignTaskSheet
        visible={assignState !== null}
        task={assignState?.task ?? null}
        intent={assignState?.intent ?? "assign"}
        tokens={tokens}
        compact={compact}
        hostLabel={host.label}
        onClose={() => setAssignState(null)}
        onAssigned={(task) => {
          setAssignState(null);
          upsertTask(task);
          void refresh();
        }}
      />
      <SettingsSheet
        visible={settingsOpen}
        tokens={tokens}
        compact={compact}
        onClose={() => setSettingsOpen(false)}
      />
    </View>
  );
}

function TaskBoard({
  tasks,
  allTasks,
  loading,
  compact,
  tokens,
  onCreate,
  onOpenTask,
  onAssign,
  onStatus,
  onRun,
  onOpenExecution,
}: {
  tasks: BoardTask[];
  allTasks: BoardTask[];
  loading: boolean;
  compact: boolean;
  tokens: Tokens;
  onCreate: (status: BoardStatus, parentId?: string | null) => void;
  onOpenTask: (taskId: string) => void;
  onAssign: (task: BoardTask) => void;
  onStatus: (task: BoardTask) => void;
  onRun: (task: BoardTask) => void;
  onOpenExecution: (task: BoardTask) => void;
}) {
  const { width: windowWidth } = useWindowDimensions();
  const [boardHeight, setBoardHeight] = useState(0);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setBoardHeight(event.nativeEvent.layout.height);
  }, []);

  if (loading && tasks.length === 0) {
    return <Hint tokens={tokens}>正在读取任务…</Hint>;
  }
  if (tasks.length === 0) {
    return (
      <View
        style={{
          alignItems: "center",
          justifyContent: "center",
          gap: tokens.spacing[2],
          paddingVertical: tokens.spacing[8],
        }}
      >
        <Icon name="CheckSquare" size={28} color={tokens.colors.accent} />
        <Text
          style={{
            color: tokens.colors.foreground,
            fontSize: tokens.fontSize.base,
            fontWeight: "500",
          }}
        >
          还没有任务
        </Text>
        <Text
          style={{
            color: tokens.colors.foregroundMuted,
            fontSize: tokens.fontSize.sm,
            textAlign: "center",
          }}
        >
          新建一个任务，它会先进入待办；分配后才开始执行。
        </Text>
        <Button
          variant="secondary"
          size="sm"
          onPress={() => onCreate("planning")}
          tokens={tokens}
        >
          新建任务
        </Button>
      </View>
    );
  }

  const columnWidth = compact ? Math.round(windowWidth * 0.79) : 280;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={!compact}
      style={
        compact
          ? undefined
          : { flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0 }
      }
      contentContainerStyle={[
        {
          flexDirection: "row",
          alignItems: "stretch",
          gap: compact ? tokens.spacing[2] : tokens.spacing[4],
          minWidth: compact ? undefined : 960,
        },
        !compact && boardHeight > 0 ? { height: boardHeight } : null,
      ]}
      onLayout={compact ? undefined : handleLayout}
    >
      {BOARD_STATUSES.map((status) => (
        <TaskColumn
          key={status}
          status={status}
          rows={tasks.filter((task) => task.status === status)}
          allTasks={allTasks}
          compact={compact}
          width={columnWidth}
          tokens={tokens}
          onCreate={onCreate}
          onOpenTask={onOpenTask}
          onAssign={onAssign}
          onStatus={onStatus}
          onRun={onRun}
          onOpenExecution={onOpenExecution}
        />
      ))}
    </ScrollView>
  );
}

function TaskColumn({
  status,
  rows,
  allTasks,
  compact,
  width,
  tokens,
  onCreate,
  onOpenTask,
  onAssign,
  onStatus,
  onRun,
  onOpenExecution,
}: {
  status: BoardStatus;
  rows: BoardTask[];
  allTasks: BoardTask[];
  compact: boolean;
  width: number;
  tokens: Tokens;
  onCreate: (status: BoardStatus, parentId?: string | null) => void;
  onOpenTask: (taskId: string) => void;
  onAssign: (task: BoardTask) => void;
  onStatus: (task: BoardTask) => void;
  onRun: (task: BoardTask) => void;
  onOpenExecution: (task: BoardTask) => void;
}) {
  const items = rows.map((task) => (
    <TaskCard
      key={task.id}
      task={task}
      allTasks={allTasks}
      tokens={tokens}
      onOpenTask={onOpenTask}
      onAssign={onAssign}
      onStatus={onStatus}
      onRun={onRun}
      onOpenExecution={onOpenExecution}
    />
  ));
  return (
    <View
      style={{
        width,
        borderRadius: tokens.radius.xl,
        borderWidth: 1,
        borderColor: tokens.colors.border,
        backgroundColor: tokens.colors.surface1,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: tokens.spacing[2],
          paddingHorizontal: tokens.spacing[3],
          paddingVertical: tokens.spacing[2],
          borderBottomWidth: 1,
          borderBottomColor: tokens.colors.border,
        }}
      >
        <StatusDot status={status} tokens={tokens} />
        <Text
          style={{
            color: tokens.colors.foreground,
            fontSize: tokens.fontSize.sm,
            fontWeight: "500",
          }}
        >
          {BOARD_STATUS_LABELS[status]}
        </Text>
        <Text
          style={{
            color: tokens.colors.foregroundMuted,
            fontSize: tokens.fontSize.sm,
          }}
        >
          {rows.length}
        </Text>
        <View style={{ flex: 1 }} />
        <Button
          variant="ghost"
          size="xs"
          icon="Plus"
          onPress={() => onCreate(status)}
          tokens={tokens}
          accessibilityLabel={`在${BOARD_STATUS_LABELS[status]}中新建任务`}
        />
      </View>
      {compact ? (
        <View style={{ gap: tokens.spacing[2], padding: tokens.spacing[2] }}>
          {items}
          {rows.length === 0 ? <EmptyColumn tokens={tokens} /> : null}
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{
            gap: tokens.spacing[2],
            padding: tokens.spacing[2],
          }}
          nestedScrollEnabled
        >
          {items}
          {rows.length === 0 ? <EmptyColumn tokens={tokens} /> : null}
        </ScrollView>
      )}
    </View>
  );
}

function EmptyColumn({ tokens }: { tokens: Tokens }) {
  return (
    <Text
      style={{
        color: tokens.colors.foregroundMuted,
        fontSize: tokens.fontSize.sm,
        paddingVertical: tokens.spacing[2],
      }}
    >
      暂无任务
    </Text>
  );
}

function TaskCard({
  task,
  allTasks,
  tokens,
  onOpenTask,
  onAssign,
  onStatus,
  onRun,
  onOpenExecution,
}: {
  task: BoardTask;
  allTasks: BoardTask[];
  tokens: Tokens;
  onOpenTask: (taskId: string) => void;
  onAssign: (task: BoardTask) => void;
  onStatus: (task: BoardTask) => void;
  onRun: (task: BoardTask) => void;
  onOpenExecution: (task: BoardTask) => void;
}) {
  const parent = task.hierarchyParentId
    ? (allTasks.find((entry) => entry.id === task.hierarchyParentId) ?? null)
    : null;
  const children = childrenOf(allTasks, task.id);
  const doneChildren = children.filter(
    (child) => child.status === "done",
  ).length;
  const blockedChildren = children.filter(
    (child) => child.status === "blocked",
  ).length;
  const blockLabel = task.blockReason
    ? BLOCK_REASON_LABELS[task.blockReason]
    : null;
  const canAssign = !task.execution && !task.assignment;
  const canStart =
    !task.execution && !!task.assignment && task.status === "todo";
  const runner = task.execution
    ? [task.execution.provider, task.execution.model]
        .filter(Boolean)
        .join(" · ")
    : task.assignment
      ? task.assignment.agent.kind === "create"
        ? `待执行 · ${task.assignment.agent.provider}`
        : "已分配 · 待执行"
      : null;
  const bodyStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      { gap: tokens.spacing[1], borderRadius: tokens.radius.md },
      pressed ? { opacity: 0.5 } : null,
    ],
    [tokens],
  );
  const openParent = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      if (parent) onOpenTask(parent.id);
    },
    [onOpenTask, parent],
  );
  return (
    <View
      style={[
        {
          gap: tokens.spacing[1.5],
          borderRadius: tokens.radius.lg,
          borderWidth: 1,
          borderColor: tokens.colors.border,
          backgroundColor: tokens.colors.surfaceWorkspace,
          paddingVertical: tokens.spacing[2],
          paddingLeft: tokens.spacing[3],
          paddingRight: tokens.spacing[3],
        },
        cardEdge(task.status, tokens),
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`打开 ${task.displayId} 详情`}
        onPress={() => onOpenTask(task.id)}
        style={bodyStyle}
        testID={`task-open-${task.displayId}`}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: tokens.spacing[1],
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              color: tokens.colors.foregroundExtraMuted,
              fontSize: tokens.fontSize.sm,
            }}
          >
            {task.displayId}
          </Text>
          <View style={{ flex: 1 }} />
          {task.kind === "task-planning" ? (
            <Text
              style={{
                color: tokens.colors.foreground,
                borderWidth: 1,
                borderColor: tokens.colors.border,
                borderRadius: tokens.radius.sm,
                paddingHorizontal: tokens.spacing[1],
                fontSize: tokens.fontSize.sm,
                fontWeight: "500",
              }}
            >
              规划任务
            </Text>
          ) : null}
          {task.priority !== "none" ? (
            <Text
              numberOfLines={1}
              style={[
                { fontSize: tokens.fontSize.sm },
                priorityStyle(task.priority, tokens),
              ]}
            >
              {BOARD_PRIORITY_LABELS[task.priority]}
            </Text>
          ) : null}
          <StatusDot status={task.status} tokens={tokens} />
        </View>
        <Text
          numberOfLines={2}
          style={{
            color: tokens.colors.foreground,
            fontSize: tokens.fontSize.base,
            fontWeight: "500",
            lineHeight: Math.round(tokens.fontSize.base * 1.4),
          }}
        >
          {task.title}
        </Text>
        {blockLabel ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: tokens.spacing[1],
            }}
          >
            <StatusBadge label={blockLabel} tokens={tokens} />
            {task.blockDetail ? (
              <Text
                numberOfLines={1}
                style={{
                  flexShrink: 1,
                  color: tokens.colors.foregroundMuted,
                  fontSize: tokens.fontSize.sm,
                }}
              >
                {task.blockDetail}
              </Text>
            ) : null}
          </View>
        ) : null}
        {task.labels.length > 0 ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: tokens.spacing[1],
            }}
          >
            {task.labels.map((label) => (
              <Text
                key={label}
                style={{
                  color: tokens.colors.foregroundMuted,
                  fontSize: tokens.fontSize.sm,
                  borderRadius: tokens.radius.sm,
                  backgroundColor: tokens.colors.surface2,
                  paddingHorizontal: tokens.spacing[1],
                  paddingVertical: 1,
                }}
              >
                #{label}
              </Text>
            ))}
          </View>
        ) : null}
        {parent || children.length > 0 ? (
          <View style={{ gap: tokens.spacing[1] }}>
            {parent ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`打开父任务 ${parent.displayId}`}
                onPress={openParent}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: tokens.spacing[1],
                  minWidth: 0,
                }}
              >
                <Icon
                  name="CornerDownRight"
                  size={11}
                  color={tokens.colors.foregroundMuted}
                />
                <Text
                  numberOfLines={1}
                  style={{
                    flexShrink: 1,
                    color: tokens.colors.foregroundMuted,
                    fontSize: tokens.fontSize.sm,
                  }}
                >
                  父 {parent.displayId} · {parent.title}
                </Text>
              </Pressable>
            ) : null}
            {children.length > 0 ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: tokens.spacing[1],
                }}
              >
                <Icon
                  name="ListTree"
                  size={11}
                  color={tokens.colors.foregroundMuted}
                />
                <Text
                  style={{
                    color:
                      blockedChildren > 0
                        ? tokens.colors.destructive
                        : tokens.colors.foregroundMuted,
                    fontSize: tokens.fontSize.sm,
                  }}
                >
                  子任务 {doneChildren}/{children.length}
                  {blockedChildren > 0 ? ` · 阻塞 ${blockedChildren}` : ""}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </Pressable>
      {runner ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`打开 ${task.displayId} 的执行会话`}
          onPress={() => onOpenExecution(task)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: tokens.spacing[1],
            maxWidth: "100%",
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              flexShrink: 1,
              color: tokens.colors.foregroundMuted,
              fontSize: tokens.fontSize.sm,
            }}
          >
            {runner}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              flexShrink: 1,
              color: tokens.colors.foregroundExtraMuted,
              fontSize: tokens.fontSize.sm,
            }}
          >
            {timeAgo(task.updatedAt)}
          </Text>
        </Pressable>
      ) : null}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
          flexWrap: "wrap",
          gap: tokens.spacing[1.5],
          marginTop: tokens.spacing[1],
        }}
      >
        {canAssign ? (
          <Button
            variant="outline"
            size="xs"
            onPress={() => onAssign(task)}
            tokens={tokens}
            testID={`task-assign-${task.displayId}`}
          >
            分配
          </Button>
        ) : null}
        {canStart ? (
          <Button
            variant="outline"
            size="xs"
            icon="Play"
            onPress={() => onRun(task)}
            tokens={tokens}
            testID={`task-run-${task.displayId}`}
          >
            执行
          </Button>
        ) : null}
        {task.execution ? (
          <Button
            variant="outline"
            size="xs"
            icon="MessageSquare"
            onPress={() => onOpenExecution(task)}
            tokens={tokens}
            testID={`task-chat-${task.displayId}`}
          >
            对话
          </Button>
        ) : null}
        <StatusMenuTrigger
          status={task.status}
          onPress={() => onStatus(task)}
          tokens={tokens}
          testID={`task-status-${task.displayId}`}
        />
      </View>
    </View>
  );
}

function TaskList({
  tasks,
  allTasks,
  loading,
  tokens,
  compact,
  collapsed,
  onToggleCollapsed,
  onOpenTask,
  onAssign,
  onStatus,
  onRun,
  onOpenExecution,
  onCreate,
}: {
  tasks: BoardTask[];
  allTasks: BoardTask[];
  loading: boolean;
  tokens: Tokens;
  compact: boolean;
  collapsed: Set<BoardStatus>;
  onToggleCollapsed: (status: BoardStatus) => void;
  onOpenTask: (taskId: string) => void;
  onAssign: (task: BoardTask) => void;
  onStatus: (task: BoardTask) => void;
  onRun: (task: BoardTask) => void;
  onOpenExecution: (task: BoardTask) => void;
  onCreate: (status: BoardStatus, parentId?: string | null) => void;
}) {
  if (loading && tasks.length === 0)
    return <Hint tokens={tokens}>正在读取任务…</Hint>;
  return (
    <ScrollView
      style={{ flex: 1, minHeight: 0 }}
      contentContainerStyle={{
        gap: tokens.spacing[4],
        paddingBottom: tokens.spacing[4],
      }}
    >
      {BOARD_STATUSES.map((status) => {
        const rows = tasks.filter((task) => task.status === status);
        const isCollapsed = collapsed.has(status);
        return (
          <View key={status} style={{ gap: tokens.spacing[2] }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: tokens.spacing[2],
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: !isCollapsed }}
                onPress={() => onToggleCollapsed(status)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: tokens.spacing[2],
                  flexGrow: 1,
                  flexShrink: 1,
                  minWidth: 0,
                  paddingVertical: tokens.spacing[1],
                }}
                testID={`task-group-toggle-${status}`}
              >
                <View
                  style={
                    isCollapsed
                      ? undefined
                      : { transform: [{ rotate: "90deg" }] }
                  }
                >
                  <Icon
                    name="ChevronRight"
                    size={14}
                    color={tokens.colors.foregroundMuted}
                  />
                </View>
                <StatusDot status={status} tokens={tokens} />
                <Text
                  style={{
                    color: tokens.colors.foreground,
                    fontSize: tokens.fontSize.sm,
                    fontWeight: "500",
                  }}
                >
                  {BOARD_STATUS_LABELS[status]}
                </Text>
                <Text
                  style={{
                    color: tokens.colors.foregroundMuted,
                    fontSize: tokens.fontSize.sm,
                  }}
                >
                  {rows.length}
                </Text>
              </Pressable>
              <Button
                variant="ghost"
                size="xs"
                icon="Plus"
                onPress={() => onCreate(status)}
                tokens={tokens}
                accessibilityLabel={`在${BOARD_STATUS_LABELS[status]}中新建任务`}
              />
            </View>
            {isCollapsed ? null : rows.length === 0 ? (
              <Text
                style={{
                  color: tokens.colors.foregroundMuted,
                  fontSize: tokens.fontSize.sm,
                  paddingHorizontal: tokens.spacing[2],
                  paddingVertical: tokens.spacing[2],
                }}
              >
                暂无任务
              </Text>
            ) : (
              <View style={{ gap: tokens.spacing[1.5] }}>
                {rows.map((task) => (
                  <TaskListRow
                    key={task.id}
                    task={task}
                    allTasks={allTasks}
                    tokens={tokens}
                    compact={compact}
                    onOpenTask={onOpenTask}
                    onAssign={onAssign}
                    onStatus={onStatus}
                    onRun={onRun}
                    onOpenExecution={onOpenExecution}
                  />
                ))}
              </View>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

function TaskListRow({
  task,
  allTasks,
  tokens,
  compact,
  onOpenTask,
  onAssign,
  onStatus,
  onRun,
  onOpenExecution,
}: {
  task: BoardTask;
  allTasks: BoardTask[];
  tokens: Tokens;
  compact: boolean;
  onOpenTask: (taskId: string) => void;
  onAssign: (task: BoardTask) => void;
  onStatus: (task: BoardTask) => void;
  onRun: (task: BoardTask) => void;
  onOpenExecution: (task: BoardTask) => void;
}) {
  const parent = task.hierarchyParentId
    ? (allTasks.find((entry) => entry.id === task.hierarchyParentId) ?? null)
    : null;
  const children = childrenOf(allTasks, task.id);
  const canAssign = !task.execution && !task.assignment;
  const canStart =
    !task.execution && !!task.assignment && task.status === "todo";
  const runner = task.execution
    ? [task.execution.provider, task.execution.model]
        .filter(Boolean)
        .join(" · ")
    : task.assignment
      ? "已分配 · 待执行"
      : null;
  const meta = [
    runner,
    parent ? `父 ${parent.displayId}` : null,
    children.length > 0
      ? `子任务 ${children.filter((child) => child.status === "done").length}/${children.length}`
      : null,
    timeAgo(task.updatedAt),
    task.blockReason ? BLOCK_REASON_LABELS[task.blockReason] : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View
      style={{
        flexDirection: compact ? "column" : "row",
        alignItems: compact ? "stretch" : "center",
        gap: tokens.spacing[2],
        paddingVertical: tokens.spacing[2],
        paddingHorizontal: tokens.spacing[3],
        borderRadius: tokens.radius.lg,
        borderWidth: 1,
        borderColor: tokens.colors.border,
        backgroundColor: tokens.colors.surfaceWorkspace,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`打开 ${task.displayId} 详情`}
        onPress={() => onOpenTask(task.id)}
        style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: tokens.spacing[2],
        }}
        testID={`task-row-${task.displayId}`}
      >
        <StatusDot status={task.status} tokens={tokens} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              flexWrap: "wrap",
              gap: tokens.spacing[2],
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                color: tokens.colors.foregroundExtraMuted,
                fontSize: tokens.fontSize.sm,
              }}
            >
              {task.displayId}
            </Text>
            <Text
              numberOfLines={1}
              style={{
                color: tokens.colors.foreground,
                fontSize: tokens.fontSize.base,
                fontWeight: "500",
              }}
            >
              {task.title}
            </Text>
            {task.kind === "task-planning" ? (
              <Text
                style={{
                  color: tokens.colors.foreground,
                  borderWidth: 1,
                  borderColor: tokens.colors.border,
                  borderRadius: tokens.radius.sm,
                  paddingHorizontal: tokens.spacing[1],
                  fontSize: tokens.fontSize.sm,
                }}
              >
                规划任务
              </Text>
            ) : null}
            {task.priority !== "none" ? (
              <Text
                style={[
                  { fontSize: tokens.fontSize.sm },
                  priorityStyle(task.priority, tokens),
                ]}
              >
                {BOARD_PRIORITY_LABELS[task.priority]}
              </Text>
            ) : null}
          </View>
          {meta ? (
            <Text
              numberOfLines={1}
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
              }}
            >
              {meta}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: tokens.spacing[1.5],
        }}
      >
        {canAssign ? (
          <Button
            variant="outline"
            size="xs"
            onPress={() => onAssign(task)}
            tokens={tokens}
          >
            分配
          </Button>
        ) : null}
        {canStart ? (
          <Button
            variant="outline"
            size="xs"
            icon="Play"
            onPress={() => onRun(task)}
            tokens={tokens}
          >
            执行
          </Button>
        ) : null}
        {task.execution ? (
          <Button
            variant="outline"
            size="xs"
            icon="MessageSquare"
            onPress={() => onOpenExecution(task)}
            tokens={tokens}
          >
            对话
          </Button>
        ) : null}
        <StatusMenuTrigger
          status={task.status}
          onPress={() => onStatus(task)}
          tokens={tokens}
        />
      </View>
    </View>
  );
}

export function TaskBoardScreen({
  theme,
  host,
  navigation,
  params,
}: PluginScreenProps) {
  const tokens = useMemo(() => createTokens(theme), [theme]);
  return (
    <OverlayMenuProvider tokens={tokens}>
      <TaskBoardContent
        theme={theme}
        host={host}
        navigation={navigation}
        params={params}
      />
    </OverlayMenuProvider>
  );
}
