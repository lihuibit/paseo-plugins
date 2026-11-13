import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import {
  BLOCK_REASON_LABELS,
  BOARD_PRIORITY_LABELS,
  BOARD_STATUS_LABELS,
  BOARD_STATUSES,
  type BoardPriority,
  type BoardStatus,
  type BoardTask,
} from "../shared/core/board/types";
import {
  deleteRpc,
  setHierarchyRpc,
  setStatusRpc,
  unassignRpc,
  updateRpc,
} from "../shared/contracts";
import {
  Alert,
  Button,
  Field,
  FormInput,
  Hint,
  SectionLabel,
  SelectField,
  StatusDot,
  useOverlayMenu,
} from "./ui/components";
import type { Tokens } from "./ui/tokens";

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function describeActivity(
  entry: BoardTask["activity"][number],
  tasks: Map<string, BoardTask>,
): string {
  const detail = entry.detail ?? {};
  const from = typeof detail.from === "string" ? detail.from : null;
  const to = typeof detail.to === "string" ? detail.to : null;
  const summary = typeof detail.summary === "string" ? detail.summary : null;
  const stage = typeof detail.stage === "string" ? detail.stage : null;
  const displayId = (id: string | null) =>
    id ? (tasks.get(id)?.displayId ?? id) : "顶层";
  switch (entry.kind) {
    case "created":
      return "创建任务";
    case "updated":
      return "更新任务";
    case "assigned":
      return "分配执行目标";
    case "unassigned":
      return "取消分配";
    case "status_changed":
      return from && to
        ? `状态 ${BOARD_STATUS_LABELS[from as BoardStatus] ?? from} → ${
            BOARD_STATUS_LABELS[to as BoardStatus] ?? to
          }`
        : `状态变更为 ${to ? (BOARD_STATUS_LABELS[to as BoardStatus] ?? to) : "未知"}`;
    case "parent_changed":
      return from && to
        ? `父任务 ${displayId(from)} → ${displayId(to)}`
        : to
          ? `关联到父任务 ${displayId(to)}`
          : "取消父任务";
    case "progress":
      return `进展：${stage ? `${stage} · ` : ""}${summary ?? ""}`;
    case "execution_synced":
      return "同步执行状态";
    case "scheduled":
      return "更新执行时机";
    case "permission_requested":
      return "等待权限或回答";
    case "permission_resolved":
      return "权限或回答已处理";
    case "migrated":
      return "迁移旧任务";
    default:
      return summary ? `声明：${summary}` : entry.kind;
  }
}

export function TaskDetail({
  task,
  tasks,
  tokens,
  compact,
  navigation,
  onBack,
  onRefresh,
  onChanged,
  onAssign,
  onCreateChild,
  onOpenTask,
  onOpenSettings,
}: {
  task: BoardTask;
  tasks: BoardTask[];
  tokens: Tokens;
  compact: boolean;
  navigation: { openAgent?: (input: { agentId: string }) => void } | undefined;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onChanged: (task: BoardTask | null) => void;
  onAssign: (task: BoardTask) => void;
  onCreateChild: (parentId: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenSettings: () => void;
}) {
  const update = useRpc(updateRpc);
  const setStatus = useRpc(setStatusRpc);
  const setHierarchy = useRpc(setHierarchyRpc);
  const unassign = useRpc(unassignRpc);
  const remove = useRpc(deleteRpc);
  const { openMenu } = useOverlayMenu();
  const [title, setTitle] = useState(task.title);
  const [titleFocused, setTitleFocused] = useState(false);
  const [description, setDescription] = useState(task.description ?? "");
  const [editingDescription, setEditingDescription] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!titleFocused) setTitle(task.title);
  }, [task.title, titleFocused]);
  useEffect(() => {
    if (!editingDescription) setDescription(task.description ?? "");
  }, [editingDescription, task.description]);

  const taskMap = useMemo(
    () => new Map(tasks.map((entry) => [entry.id, entry])),
    [tasks],
  );
  const parent = task.hierarchyParentId
    ? (taskMap.get(task.hierarchyParentId) ?? null)
    : null;
  const children = tasks.filter((entry) => entry.hierarchyParentId === task.id);
  const descendantIds = useMemo(() => {
    const ids = new Set<string>();
    let cursor: string[] = [task.id];
    while (cursor.length > 0) {
      const next: string[] = [];
      for (const entry of tasks) {
        if (
          entry.hierarchyParentId &&
          cursor.includes(entry.hierarchyParentId)
        ) {
          ids.add(entry.id);
          next.push(entry.id);
        }
      }
      cursor = next;
    }
    return ids;
  }, [task.id, tasks]);
  const parentOptions = useMemo(
    () => [
      { value: "", label: "无（顶层任务）" },
      ...tasks
        .filter((entry) => entry.id !== task.id && !descendantIds.has(entry.id))
        .map((entry) => ({
          value: entry.id,
          label: `${entry.displayId} · ${entry.title}`,
          description: BOARD_STATUS_LABELS[entry.status],
        })),
    ],
    [descendantIds, task.id, tasks],
  );

  const save = async (
    patch: Parameters<typeof update>[0]["patch"],
    message: string,
  ) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const envelope = await update({
        taskId: task.id,
        expectedRevision: task.revision,
        patch,
      });
      if (!envelope.ok) {
        if (envelope.error.code === "E_REVISION_CONFLICT") {
          setError("409 revision 冲突：卡片已被其他操作更新，请刷新后重试。");
          return;
        }
        throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
      }
      onChanged(envelope.value.task);
      setNotice(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (status: BoardStatus) => {
    setSaving(true);
    setError(null);
    try {
      const envelope = await setStatus({
        taskId: task.id,
        expectedRevision: task.revision,
        status,
      });
      if (!envelope.ok) {
        if (envelope.error.code === "E_REVISION_CONFLICT") {
          setError("409 revision 冲突：卡片已被其他操作更新，请刷新后重试。");
          return;
        }
        throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
      }
      onChanged(envelope.value.task);
      setNotice(`状态已改为「${BOARD_STATUS_LABELS[status]}」`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const changeParent = async (parentId: string | null) => {
    setSaving(true);
    setError(null);
    try {
      const envelope = await setHierarchy({
        taskId: task.id,
        expectedRevision: task.revision,
        parentId,
      });
      if (!envelope.ok)
        throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
      onChanged(envelope.value.task);
      setNotice(parentId ? "已关联父任务" : "已取消父任务");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const openMore = () => {
    openMenu({
      title: "更多",
      options: [
        ...(task.execution || task.assignment
          ? [{ value: "unassign", label: "取消分配" }]
          : []),
        { value: "settings", label: "通知与设置" },
        { value: "delete", label: "删除任务", destructive: true },
      ],
      onSelect: (value) => {
        if (value === "unassign") {
          void (async () => {
            const envelope = await unassign({
              taskId: task.id,
              expectedRevision: task.revision,
            });
            if (envelope.ok) onChanged(envelope.value.task);
            else setError(`${envelope.error.code}: ${envelope.error.message}`);
          })();
        } else if (value === "settings") {
          onOpenSettings();
        } else if (value === "delete") {
          openMenu({
            title: "删除任务",
            options: [
              { value: "cancel", label: "取消" },
              { value: "confirm", label: "确认删除", destructive: true },
            ],
            onSelect: (next) => {
              if (next !== "confirm") return;
              void (async () => {
                const envelope = await remove({
                  taskId: task.id,
                  expectedRevision: task.revision,
                });
                if (envelope.ok) onChanged(null);
                else
                  setError(`${envelope.error.code}: ${envelope.error.message}`);
              })();
            },
          });
        }
      },
    });
  };

  const longDescription =
    (task.description?.length ?? 0) > 520 ||
    (task.description?.split("\n").length ?? 0) > 9;

  const scheduleLine =
    task.trigger?.kind === "scheduled"
      ? `执行时机：定时 ${formatTime(task.trigger.runAt)}`
      : task.trigger?.kind === "recurring"
        ? `执行时机：循环 ${
            task.trigger.cadence.type === "every"
              ? `每 ${Math.round(task.trigger.cadence.everyMs / 60_000)} 分钟`
              : task.trigger.cadence.expression
          }`
        : task.trigger?.kind === "manual"
          ? "执行时机：仅分配"
          : null;

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        gap: tokens.spacing[4],
        padding: tokens.spacing[4],
        maxWidth: 900,
        width: "100%",
        alignSelf: "center",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Button
          variant="ghost"
          size="sm"
          icon="ArrowLeft"
          onPress={onBack}
          tokens={tokens}
          testID="task-detail-back"
        >
          返回任务
        </Button>
        <Text
          style={{
            color: tokens.colors.foregroundMuted,
            fontSize: tokens.fontSize.sm,
          }}
        >
          {task.displayId}
        </Text>
        <View style={{ flex: 1 }} />
        <Button
          variant="outline"
          size="sm"
          onPress={openMore}
          tokens={tokens}
          testID="task-detail-more"
        >
          更多
        </Button>
      </View>

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
      {error?.includes("409") ? (
        <Button
          variant="outline"
          size="sm"
          onPress={() => {
            setError(null);
            void onRefresh();
          }}
          tokens={tokens}
        >
          刷新卡片
        </Button>
      ) : null}

      <Field label="标题" tokens={tokens}>
        <FormInput
          value={title}
          onChangeText={setTitle}
          onFocus={() => setTitleFocused(true)}
          onBlur={() => {
            setTitleFocused(false);
            const next = title.trim();
            if (!next || next === task.title) {
              setTitle(task.title);
              return;
            }
            void save({ title: next }, "标题已保存");
          }}
          editable={!saving}
          testID="task-detail-title"
          tokens={tokens}
        />
      </Field>

      <Field label="描述" tokens={tokens}>
        {editingDescription ? (
          <FormInput
            value={description}
            onChangeText={setDescription}
            onBlur={() => {
              setEditingDescription(false);
              if (description === (task.description ?? "")) return;
              void save(
                { description: description.trim() || null },
                "描述已保存",
              );
            }}
            multiline
            minHeight={220}
            editable={!saving}
            placeholder="支持 Markdown"
            testID="task-detail-description"
            tokens={tokens}
          />
        ) : (
          <View style={{ gap: tokens.spacing[1] }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="编辑描述"
              onPress={() => setEditingDescription(true)}
              style={{
                padding: tokens.spacing[3],
                borderRadius: tokens.radius.lg,
                backgroundColor: tokens.colors.surface1,
                maxHeight: expanded ? undefined : 260,
                overflow: "hidden",
              }}
            >
              {task.description?.trim() ? (
                <MarkdownLite text={task.description} tokens={tokens} />
              ) : (
                <Text
                  style={{
                    color: tokens.colors.foregroundExtraMuted,
                    fontSize: tokens.fontSize.sm,
                  }}
                >
                  添加描述...
                </Text>
              )}
            </Pressable>
            {longDescription ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setExpanded((value) => !value)}
                style={{
                  alignSelf: "flex-start",
                  paddingVertical: tokens.spacing[1],
                }}
              >
                <Text
                  style={{
                    color: tokens.colors.accent,
                    fontSize: tokens.fontSize.sm,
                  }}
                >
                  {expanded ? "收起" : "展开全文"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </Field>

      <View
        style={{
          flexDirection: compact ? "column" : "row",
          gap: tokens.spacing[3],
        }}
      >
        <View style={{ width: compact ? "100%" : 198 }}>
          <SelectField
            label="状态"
            value={task.status}
            options={BOARD_STATUSES.map((status) => ({
              value: status,
              label: BOARD_STATUS_LABELS[status],
            }))}
            placeholder="选择状态"
            onChange={(value) => void changeStatus(value as BoardStatus)}
            tokens={tokens}
            disabled={saving}
            testID="task-detail-status"
          />
        </View>
        <View style={{ width: compact ? "100%" : 198 }}>
          <SelectField
            label="优先级"
            value={task.priority}
            options={(
              ["none", "low", "medium", "high", "urgent"] as BoardPriority[]
            ).map((priority) => ({
              value: priority,
              label: BOARD_PRIORITY_LABELS[priority],
            }))}
            placeholder="选择优先级"
            onChange={(value) =>
              void save({ priority: value as BoardPriority }, "优先级已保存")
            }
            tokens={tokens}
            disabled={saving}
            testID="task-detail-priority"
          />
        </View>
      </View>

      <Text
        style={{
          color: tokens.colors.foregroundMuted,
          fontSize: tokens.fontSize.sm,
        }}
      >
        创建 {formatTime(task.createdAt)} · 更新 {formatTime(task.updatedAt)}
        {task.blockReason
          ? ` · 阻塞：${BLOCK_REASON_LABELS[task.blockReason] ?? task.blockReason}`
          : ""}
      </Text>

      <SectionLabel label="执行" tokens={tokens} />
      {scheduleLine ? (
        <View
          style={{
            gap: tokens.spacing[1],
            padding: tokens.spacing[3],
            borderRadius: tokens.radius.lg,
            backgroundColor: tokens.colors.surface1,
          }}
        >
          <Text
            style={{
              color: tokens.colors.foregroundMuted,
              fontSize: tokens.fontSize.sm,
            }}
          >
            {scheduleLine}
          </Text>
          {task.nextRunAt ? (
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
              }}
            >
              下次执行：{formatTime(task.nextRunAt)}
            </Text>
          ) : null}
          {task.runCount > 0 ? (
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
              }}
            >
              已执行 {task.runCount} 次
            </Text>
          ) : null}
        </View>
      ) : null}
      {task.execution ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: tokens.spacing[3],
            padding: tokens.spacing[3],
            borderRadius: tokens.radius.lg,
            borderWidth: 1,
            borderColor: tokens.colors.border,
            backgroundColor: tokens.colors.surface1,
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: tokens.spacing[1] }}>
            <Text
              style={{
                color: tokens.colors.foreground,
                fontSize: 18,
                fontWeight: "500",
              }}
            >
              {task.execution.agentTitle ?? task.execution.agentId}
            </Text>
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
              }}
            >
              {task.execution.provider}
              {task.execution.model ? ` · ${task.execution.model}` : ""}
            </Text>
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
              }}
            >
              工作区：{task.execution.workspace.workspaceName}
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            icon="ExternalLink"
            onPress={() =>
              navigation?.openAgent?.({
                agentId: task.execution?.agentId ?? "",
              })
            }
            tokens={tokens}
            testID="task-detail-open-execution"
          >
            打开
          </Button>
        </View>
      ) : task.assignment ? (
        <View style={{ gap: tokens.spacing[2] }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: tokens.spacing[3],
              padding: tokens.spacing[3],
              borderRadius: tokens.radius.lg,
              borderWidth: 1,
              borderColor: tokens.colors.border,
              backgroundColor: tokens.colors.surface1,
            }}
          >
            <View style={{ flex: 1, minWidth: 0, gap: tokens.spacing[1] }}>
              <Text
                style={{
                  color: tokens.colors.foreground,
                  fontSize: tokens.fontSize.base,
                  fontWeight: "500",
                }}
              >
                {task.assignment.agent.kind === "existing"
                  ? "复用已有 Agent"
                  : `新建 Agent · ${task.assignment.agent.provider}`}
              </Text>
              {task.assignment.agent.kind === "create" ? (
                <Text
                  style={{
                    color: tokens.colors.foregroundMuted,
                    fontSize: tokens.fontSize.sm,
                  }}
                >
                  {[
                    task.assignment.agent.model
                      ? `模型 ${task.assignment.agent.model}`
                      : null,
                    task.assignment.agent.modeId
                      ? `权限 ${task.assignment.agent.modeId}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              ) : (
                <Text
                  style={{
                    color: tokens.colors.foregroundMuted,
                    fontSize: tokens.fontSize.sm,
                  }}
                >
                  Agent：{task.assignment.agent.agentId}
                </Text>
              )}
            </View>
            <Button
              variant="outline"
              size="sm"
              onPress={() => onAssign(task)}
              tokens={tokens}
              testID="task-detail-edit-assignment"
            >
              编辑
            </Button>
          </View>
          <Hint tokens={tokens}>尚未创建对话。返回看板后点「执行」开始。</Hint>
        </View>
      ) : (
        <Text
          style={{
            color: tokens.colors.foregroundMuted,
            fontSize: tokens.fontSize.sm,
          }}
        >
          尚未分配。返回看板后点「分配」选择执行方式。
        </Text>
      )}

      {task.declaration?.humanRequest ? (
        <View
          style={{
            gap: tokens.spacing[2],
            padding: tokens.spacing[3],
            borderRadius: tokens.radius.lg,
            borderWidth: 1,
            borderColor: tokens.colors.statusDotWarning,
            backgroundColor: tokens.colors.surface1,
          }}
        >
          <Text
            style={{
              color: tokens.colors.foreground,
              fontSize: tokens.fontSize.base,
              fontWeight: "500",
            }}
          >
            {task.declaration.humanRequest.title}
          </Text>
          <Text
            style={{
              color: tokens.colors.foreground,
              fontSize: tokens.fontSize.sm,
            }}
          >
            {task.declaration.humanRequest.instructions}
          </Text>
          {task.declaration.humanRequest.action?.kind === "open_url" ? (
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
                fontFamily: "monospace",
              }}
            >
              {task.declaration.humanRequest.action.url}
            </Text>
          ) : null}
          {task.declaration.humanRequest.action?.kind === "open_terminal" ? (
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
                fontFamily: "monospace",
              }}
            >
              $ {task.declaration.humanRequest.action.command}
            </Text>
          ) : null}
        </View>
      ) : null}

      <SectionLabel label="父任务" tokens={tokens} />
      <View style={{ gap: tokens.spacing[2] }}>
        {parent ? (
          <RelatedTaskRow
            task={parent}
            tokens={tokens}
            onOpen={() => onOpenTask(parent.id)}
            testID="task-detail-parent-row"
          />
        ) : task.hierarchyParentId ? (
          <Hint tokens={tokens}>父任务当前不可见（可能已删除）。</Hint>
        ) : (
          <Hint tokens={tokens}>未关联父任务：这是一张顶层任务。</Hint>
        )}
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-end",
            flexWrap: "wrap",
            gap: tokens.spacing[2],
          }}
        >
          <View
            style={{
              flexGrow: 1,
              flexShrink: 1,
              flexBasis: 240,
              maxWidth: 420,
            }}
          >
            <SelectField
              label={task.hierarchyParentId ? "更换父任务" : "关联父任务"}
              value={task.hierarchyParentId}
              options={parentOptions}
              placeholder="选择父任务"
              onChange={(value) => void changeParent(value || null)}
              tokens={tokens}
              disabled={saving}
              testID="task-detail-parent"
            />
          </View>
          {task.hierarchyParentId ? (
            <Button
              variant="outline"
              size="sm"
              icon="Unlink"
              onPress={() => void changeParent(null)}
              disabled={saving}
              tokens={tokens}
              testID="task-detail-clear-parent"
            >
              取消关联
            </Button>
          ) : null}
        </View>
      </View>

      <SectionLabel label="子任务" tokens={tokens} />
      <View style={{ gap: tokens.spacing[2] }}>
        {children.length === 0 ? (
          <Hint tokens={tokens}>还没有子任务。</Hint>
        ) : (
          <View style={{ gap: tokens.spacing[1] }}>
            {children.map((child) => (
              <RelatedTaskRow
                key={child.id}
                task={child}
                tokens={tokens}
                onOpen={() => onOpenTask(child.id)}
                testID={`task-child-row-${child.displayId}`}
              />
            ))}
          </View>
        )}
        <Button
          variant="outline"
          size="sm"
          icon="Plus"
          onPress={() => onCreateChild(task.id)}
          disabled={saving}
          tokens={tokens}
          testID="task-detail-create-child"
        >
          新建子任务
        </Button>
        {children.length > 0 ? (
          <Hint tokens={tokens}>
            共 {children.length} 个直接子任务，已完成{" "}
            {children.filter((child) => child.status === "done").length} 个。
          </Hint>
        ) : (
          <Hint tokens={tokens}>
            子任务各自独立调度：完成子任务不会自动推进 {task.displayId}。
          </Hint>
        )}
      </View>

      <SectionLabel label="活动" tokens={tokens} />
      <View style={{ gap: tokens.spacing[2] }}>
        {[...task.activity].reverse().length === 0 ? (
          <Hint tokens={tokens}>暂无活动记录</Hint>
        ) : (
          [...task.activity].reverse().map((entry, index) => (
            <View
              key={`${entry.at}-${entry.kind}-${index}`}
              style={{ flexDirection: "row", gap: tokens.spacing[3] }}
            >
              <Text
                style={{
                  width: 96,
                  color: tokens.colors.foregroundMuted,
                  fontSize: tokens.fontSize.sm,
                }}
              >
                {formatTime(entry.at)}
              </Text>
              <Text
                style={{
                  flex: 1,
                  color: tokens.colors.foreground,
                  fontSize: tokens.fontSize.sm,
                }}
              >
                {describeActivity(entry, taskMap)}
              </Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

function MarkdownLite({ text, tokens }: { text: string; tokens: Tokens }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return (
    <View style={{ gap: tokens.spacing[1], alignItems: "stretch" }}>
      {lines.map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed)
          return <View key={`blank-${index}`} style={{ height: 4 }} />;
        if (trimmed.startsWith("### ")) {
          return (
            <Text
              key={`h3-${index}`}
              style={{
                color: tokens.colors.foreground,
                fontSize: tokens.fontSize.base,
                fontWeight: "600",
                textAlign: "left",
              }}
            >
              {trimmed.slice(4)}
            </Text>
          );
        }
        if (trimmed.startsWith("## ")) {
          return (
            <Text
              key={`h2-${index}`}
              style={{
                color: tokens.colors.foreground,
                fontSize: 20,
                fontWeight: "600",
                textAlign: "left",
                marginTop: tokens.spacing[2],
              }}
            >
              {trimmed.slice(3)}
            </Text>
          );
        }
        if (trimmed.startsWith("# ")) {
          return (
            <Text
              key={`h1-${index}`}
              style={{
                color: tokens.colors.foreground,
                fontSize: 26,
                fontWeight: "600",
                textAlign: "left",
              }}
            >
              {trimmed.slice(2)}
            </Text>
          );
        }
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
          return (
            <View
              key={`li-${index}`}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: tokens.spacing[2],
              }}
            >
              <Text
                style={{
                  color: tokens.colors.foregroundMuted,
                  fontSize: 15,
                }}
              >
                •
              </Text>
              <Text
                style={{
                  flex: 1,
                  color: tokens.colors.foreground,
                  fontSize: 15,
                  textAlign: "left",
                }}
              >
                {trimmed.slice(2)}
              </Text>
            </View>
          );
        }
        return (
          <Text
            key={`p-${index}`}
            style={{
              color: tokens.colors.foreground,
              fontSize: 15,
              lineHeight: 22,
              textAlign: "left",
            }}
          >
            {trimmed}
          </Text>
        );
      })}
    </View>
  );
}

function RelatedTaskRow({
  task,
  tokens,
  onOpen,
  testID,
}: {
  task: BoardTask;
  tokens: Tokens;
  onOpen: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开 ${task.displayId} 详情`}
      onPress={onOpen}
      testID={testID}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: tokens.spacing[2],
        paddingVertical: tokens.spacing[2],
        paddingHorizontal: tokens.spacing[3],
        borderRadius: tokens.radius.md,
        backgroundColor: tokens.colors.surface1,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: tokens.spacing[2],
          }}
        >
          <StatusDot status={task.status} tokens={tokens} />
          <Text
            style={{
              color: tokens.colors.foreground,
              fontSize: tokens.fontSize.sm,
            }}
          >
            {task.displayId}
          </Text>
          <Text
            style={{
              color: tokens.colors.foregroundMuted,
              fontSize: tokens.fontSize.sm,
            }}
          >
            {BOARD_STATUS_LABELS[task.status]}
          </Text>
        </View>
        <Text
          numberOfLines={1}
          style={{
            color: tokens.colors.foregroundExtraMuted,
            fontSize: tokens.fontSize.sm,
          }}
        >
          {task.title}
        </Text>
      </View>
      <Icon
        name="ExternalLink"
        size={12}
        color={tokens.colors.foregroundMuted}
      />
    </Pressable>
  );
}
