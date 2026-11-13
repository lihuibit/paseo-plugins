import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import {
  BOARD_PRIORITY_LABELS,
  BOARD_STATUS_LABELS,
  type BoardPriority,
  type BoardStatus,
  type BoardTask,
  type BoardTaskKind,
} from "../shared/core/board/types";
import { createRpc } from "../shared/contracts";
import { Button, Pill, Sheet, useOverlayMenu } from "./ui/components";
import type { Tokens } from "./ui/tokens";

const PRIORITIES: BoardPriority[] = ["none", "low", "medium", "high", "urgent"];
const STATUSES: BoardStatus[] = [
  "planning",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
];

function kindLabel(kind: BoardTaskKind): string {
  return kind === "task-planning" ? "规划任务" : "普通任务";
}

export function CreateTaskSheet({
  visible,
  initialStatus,
  initialParentId,
  tasks,
  tokens,
  compact,
  onClose,
  onCreated,
}: {
  visible: boolean;
  initialStatus: BoardStatus;
  initialParentId?: string | null;
  tasks: BoardTask[];
  tokens: Tokens;
  compact: boolean;
  onClose: () => void;
  onCreated: (task: BoardTask) => void;
}) {
  const create = useRpc(createRpc);
  const { openMenu } = useOverlayMenu();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [labelDraft, setLabelDraft] = useState("");
  const [priority, setPriority] = useState<BoardPriority>("none");
  const [kind, setKind] = useState<BoardTaskKind>("task");
  const [status, setStatus] = useState<BoardStatus>(initialStatus);
  const [parentId, setParentId] = useState<string | null>(
    initialParentId ?? null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setTitle("");
    setDescription("");
    setLabels([]);
    setLabelDraft("");
    setPriority("none");
    setKind("task");
    setStatus(initialStatus);
    setParentId(initialParentId ?? null);
    setError(null);
  }, [initialParentId, initialStatus]);

  useEffect(() => {
    if (!visible) return;
    reset();
  }, [reset, visible]);

  const parentOptions = useMemo(
    () => [
      { value: "", label: "无（顶层任务）" },
      ...tasks.map((task) => ({
        value: task.id,
        label: `${task.displayId} · ${task.title}`,
        description: BOARD_STATUS_LABELS[task.status],
      })),
    ],
    [tasks],
  );
  const selectedParent = tasks.find((task) => task.id === parentId) ?? null;

  const addLabel = () => {
    const next = labelDraft.trim();
    if (!next) return;
    setLabels((current) =>
      current.includes(next) ? current : [...current, next],
    );
    setLabelDraft("");
  };

  const canSubmit = !submitting && title.trim().length > 0;

  const submit = async () => {
    if (!title.trim()) {
      setError("请填写任务标题");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const envelope = await create({
        title: title.trim(),
        description: description.trim() || undefined,
        labels: labels.length > 0 ? labels : undefined,
        priority,
        status,
        kind,
        hierarchyParentId: parentId,
      });
      if (!envelope.ok)
        throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
      const task = envelope.value.task;
      reset();
      onCreated(task);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    reset();
    onClose();
  };

  return (
    <Sheet
      visible={visible}
      title="新建任务"
      onClose={close}
      tokens={tokens}
      compact={compact}
      width={720}
      height={460}
      scrollable={false}
      testID="create-task-sheet"
      contentStyle={{ flexGrow: 1, gap: tokens.spacing[1] }}
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            onPress={close}
            disabled={submitting}
            tokens={tokens}
          >
            取消
          </Button>
          <Button
            variant="default"
            size="sm"
            onPress={() => void submit()}
            disabled={!canSubmit}
            testID="create-task-submit"
            tokens={tokens}
            style={
              canSubmit
                ? undefined
                : {
                    backgroundColor: tokens.colors.surface3,
                    borderColor: tokens.colors.surface3,
                  }
            }
            textStyle={
              canSubmit ? undefined : { color: tokens.colors.foregroundMuted }
            }
          >
            创建任务
          </Button>
          {error ? (
            <Text
              numberOfLines={2}
              style={{
                flexShrink: 1,
                color: tokens.colors.destructive,
                fontSize: tokens.fontSize.sm,
              }}
            >
              {error}
            </Text>
          ) : null}
        </>
      }
    >
      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="任务标题"
        placeholderTextColor={tokens.colors.foregroundMuted}
        multiline
        autoFocus
        editable={!submitting}
        testID="create-task-title"
        style={{
          minHeight: 34,
          padding: 0,
          outlineWidth: 0,
          outlineStyle: "solid",
          outlineColor: "transparent",
          color: tokens.colors.foreground,
          fontSize: tokens.fontSize["2xl"],
          fontWeight: "500",
        }}
      />
      <TextInput
        value={description}
        onChangeText={setDescription}
        placeholder="添加描述..."
        placeholderTextColor={tokens.colors.foregroundMuted}
        multiline
        textAlignVertical="top"
        editable={!submitting}
        testID="create-task-description"
        style={{
          flexGrow: 1,
          minHeight: 160,
          padding: 0,
          outlineWidth: 0,
          outlineStyle: "solid",
          outlineColor: "transparent",
          color: tokens.colors.foreground,
          fontSize: tokens.fontSize.base,
        }}
      />
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: tokens.spacing[2],
          paddingTop: tokens.spacing[2],
        }}
      >
        <Pill
          label={kind === "task-planning" ? kindLabel(kind) : "类型"}
          active={kind === "task-planning"}
          tokens={tokens}
          testID="task-kind-pill"
          onPress={() =>
            openMenu({
              title: "类型",
              options: [
                { value: "task", label: "普通任务" },
                { value: "task-planning", label: "规划任务" },
              ],
              selected: kind,
              onSelect: (value) => {
                const next = value as BoardTaskKind;
                setKind(next);
                if (next === "task-planning") setStatus("planning");
              },
            })
          }
        />
        <Pill
          label={
            selectedParent ? `父任务 ${selectedParent.displayId}` : "父任务"
          }
          active={parentId !== null}
          tokens={tokens}
          testID="task-parent-pill"
          onPress={() =>
            openMenu({
              title: "父任务",
              options: parentOptions,
              selected: parentId ?? "",
              onSelect: (value) => setParentId(value || null),
            })
          }
        />
        <Pill
          label={BOARD_STATUS_LABELS[status]}
          active={status !== "planning"}
          tokens={tokens}
          testID="task-status-pill"
          onPress={() =>
            openMenu({
              title: "状态",
              options: STATUSES.map((value) => ({
                value,
                label: BOARD_STATUS_LABELS[value],
              })),
              selected: status,
              onSelect: (value) => setStatus(value as BoardStatus),
            })
          }
        />
        <Pill
          label={
            priority === "none" ? "优先级" : BOARD_PRIORITY_LABELS[priority]
          }
          active={priority !== "none"}
          tokens={tokens}
          testID="task-priority-pill"
          onPress={() =>
            openMenu({
              title: "优先级",
              options: PRIORITIES.map((value) => ({
                value,
                label: BOARD_PRIORITY_LABELS[value],
              })),
              selected: priority,
              onSelect: (value) => setPriority(value as BoardPriority),
            })
          }
        />
        {labels.map((label) => (
          <Pill
            key={label}
            label={label}
            active
            icon="Tag"
            tokens={tokens}
            onRemove={() =>
              setLabels((current) => current.filter((entry) => entry !== label))
            }
          />
        ))}
        <View
          style={{
            height: 28,
            flexDirection: "row",
            alignItems: "center",
            gap: tokens.spacing[1],
            paddingHorizontal: tokens.spacing[3],
            borderRadius: 14,
            borderWidth: 1,
            borderColor: tokens.colors.border,
          }}
        >
          <Icon name="Tag" size={12} color={tokens.colors.foregroundMuted} />
          <TextInput
            value={labelDraft}
            onChangeText={setLabelDraft}
            placeholder="添加标签"
            placeholderTextColor={tokens.colors.foregroundMuted}
            onSubmitEditing={addLabel}
            onBlur={addLabel}
            testID="create-task-label-input"
            style={{
              minWidth: 88,
              padding: 0,
              outlineWidth: 0,
              outlineStyle: "solid",
              outlineColor: "transparent",
              color: tokens.colors.foreground,
              fontSize: tokens.fontSize.sm,
            }}
          />
        </View>
      </View>
    </Sheet>
  );
}
