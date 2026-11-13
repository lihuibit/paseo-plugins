import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import type { BoardRpcEnvelope } from "../shared/core/board/errors";
import type {
  BoardPriority,
  BoardStatus,
  BoardTask,
  Trigger,
} from "../shared/core/board/types";
import {
  BLOCK_REASON_LABELS,
  BOARD_STATUSES,
  BOARD_STATUS_COLORS,
  BOARD_STATUS_LABELS,
  isTerminalStatus,
} from "../shared/core/board/types";
import type {
  CandidatesResult,
  HealthResult,
  HierarchyResult,
} from "../shared/contracts";
import {
  assignRpc,
  cancelRpc,
  candidatesRpc,
  createRpc,
  deleteRpc,
  healthRpc,
  hierarchyRpc,
  listRpc,
  migrateLegacyRpc,
  notificationsTestRpc,
  scheduleRpc,
  setHierarchyRpc,
  setStatusRpc,
  settingsGetRpc,
  settingsUpdateRpc,
  startRpc,
  stopRpc,
  unassignRpc,
  updateRpc,
} from "../shared/contracts";
import type { BoardSettings } from "../shared/settings";

type Theme = PluginScreenProps["theme"];
type Styles = ReturnType<typeof makeStyles>;

class ClientError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(`${error.code}: ${error.message}`);
    this.name = "ClientError";
    this.code = error.code;
    this.details = error.details;
  }
}

function unwrap<T>(envelope: BoardRpcEnvelope<T>): T {
  if (envelope.ok) return envelope.value;
  throw new ClientError(envelope.error);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isConflict(error: unknown): error is ClientError {
  return error instanceof ClientError && error.code === "E_REVISION_CONFLICT";
}

function formatWhen(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function triggerLabel(trigger: Trigger | undefined): string {
  if (!trigger) return "无";
  if (trigger.kind === "scheduled") return `定时 ${formatWhen(trigger.runAt)}`;
  if (trigger.kind === "recurring") {
    const cadence =
      trigger.cadence.type === "every"
        ? `每 ${Math.max(1, Math.round(trigger.cadence.everyMs / 1000))} 秒`
        : `cron ${trigger.cadence.expression}`;
    return `周期 ${cadence} · ${trigger.session === "reuse" ? "复用会话" : "新会话"}`;
  }
  return trigger.kind === "immediate" ? "立即" : "手动";
}

function makeStyles(theme: Theme, compact: boolean) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    header: {
      paddingHorizontal: compact ? 14 : 22,
      paddingVertical: compact ? 10 : 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
      gap: 8,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
      flexWrap: "wrap",
    },
    title: {
      color: theme.colors.foreground,
      fontSize: compact ? 19 : 23,
      fontWeight: "600",
    },
    subtitle: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      lineHeight: 17,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flexWrap: "wrap",
    },
    spacer: { flex: 1 },
    button: {
      paddingVertical: 7,
      paddingHorizontal: 11,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
    },
    buttonPrimary: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.accent,
    },
    buttonDanger: { borderColor: theme.colors.statusDanger },
    buttonDisabled: { opacity: 0.45 },
    buttonText: { color: theme.colors.foreground, fontSize: 12 },
    buttonTextPrimary: { color: theme.colors.accentForeground, fontSize: 12 },
    buttonTextDanger: { color: theme.colors.statusDanger, fontSize: 12 },
    input: {
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 6,
      backgroundColor: theme.colors.surface0,
      color: theme.colors.foreground,
      paddingHorizontal: 9,
      paddingVertical: 7,
      fontSize: 12,
    },
    textArea: { minHeight: 74, textAlignVertical: "top" },
    field: { gap: 4 },
    label: { color: theme.colors.foregroundMuted, fontSize: 11 },
    value: { color: theme.colors.foreground, fontSize: 12 },
    mono: {
      color: theme.colors.foreground,
      fontFamily: "monospace",
      fontSize: 11,
    },
    card: {
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 9,
      backgroundColor: theme.colors.surface1,
      padding: 12,
      gap: 8,
    },
    cardPressed: { borderColor: theme.colors.accent },
    error: { color: theme.colors.statusDanger, fontSize: 12 },
    ok: { color: theme.colors.statusSuccess, fontSize: 12 },
    warn: { color: theme.colors.statusWarning, fontSize: 12 },
    banner: {
      borderWidth: 1,
      borderColor: theme.colors.statusDanger,
      borderRadius: 8,
      padding: 10,
      gap: 4,
      backgroundColor: theme.colors.surface1,
    },
    warnBanner: {
      borderWidth: 1,
      borderColor: theme.colors.statusWarning,
      borderRadius: 8,
      padding: 8,
      backgroundColor: theme.colors.surface1,
    },
    badge: {
      borderRadius: 999,
      paddingHorizontal: 7,
      paddingVertical: 1,
      borderWidth: 1,
      borderColor: theme.colors.border,
      alignSelf: "flex-start",
    },
    badgeText: { color: theme.colors.foregroundMuted, fontSize: 10 },
    board: { flex: 1 },
    statusStrip: { flexGrow: 0, flexShrink: 0, maxHeight: 44 },
    boardContent: {
      padding: compact ? 12 : 18,
      gap: 12,
      flexGrow: 1,
    },
    column: {
      width: compact ? undefined : 240,
      minWidth: compact ? undefined : 232,
      flexGrow: compact ? 1 : 0,
      flexShrink: compact ? 1 : 0,
      backgroundColor: theme.colors.surface0,
      borderRadius: 9,
      borderWidth: 1,
      borderColor: theme.colors.border,
      padding: 9,
      gap: 8,
    },
    columnHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingBottom: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    columnTitle: {
      color: theme.colors.foreground,
      fontSize: 12,
      fontWeight: "600",
    },
    columnCount: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
    },
    columnScroll: { flex: 1 },
    cardTitle: {
      color: theme.colors.foreground,
      fontSize: 12,
      fontWeight: "600",
      lineHeight: 16,
    },
    cardMeta: { color: theme.colors.foregroundMuted, fontSize: 10 },
    empty: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      paddingVertical: 10,
      textAlign: "center",
    },
    detail: { flex: 1 },
    detailContent: {
      padding: compact ? 14 : 22,
      gap: 14,
      paddingBottom: 40,
      maxWidth: 980,
    },
    section: { gap: 8 },
    sectionTitle: {
      color: theme.colors.foreground,
      fontSize: 14,
      fontWeight: "600",
    },
    chip: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.border,
      paddingHorizontal: 9,
      paddingVertical: 4,
      flexShrink: 0,
    },
    chipActive: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.surface2,
    },
    chipText: { color: theme.colors.foregroundMuted, fontSize: 11 },
    chipTextActive: { color: theme.colors.foreground, fontWeight: "600" },
    timelineRow: {
      flexDirection: "row",
      gap: 8,
      paddingVertical: 3,
      alignItems: "flex-start",
    },
    timelineAt: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
      fontFamily: "monospace",
      width: 132,
    },
    timelineText: { color: theme.colors.foreground, fontSize: 11, flex: 1 },
    inlineForm: {
      borderColor: theme.colors.accent,
      borderWidth: 1,
      borderRadius: 9,
      padding: 12,
      gap: 9,
      backgroundColor: theme.colors.surface1,
    },
  });
}

function Button({
  label,
  onPress,
  styles,
  primary,
  danger,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  styles: Styles;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        primary ? styles.buttonPrimary : null,
        danger ? styles.buttonDanger : null,
        disabled ? styles.buttonDisabled : null,
      ]}
    >
      <Text
        style={
          primary
            ? styles.buttonTextPrimary
            : danger
              ? styles.buttonTextDanger
              : styles.buttonText
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}

function Badge({
  label,
  color,
  styles,
}: {
  label: string;
  color?: string;
  styles: Styles;
}) {
  return (
    <View style={[styles.badge, color ? { borderColor: color } : null]}>
      <Text style={[styles.badgeText, color ? { color } : null]}>{label}</Text>
    </View>
  );
}

function TaskCard({
  task,
  onPress,
  styles,
}: {
  task: BoardTask;
  onPress: () => void;
  styles: Styles;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      testID={`task-card-${task.id}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        pressed ? styles.cardPressed : null,
      ]}
    >
      <View style={styles.row}>
        <Text style={styles.cardMeta}>{task.displayId}</Text>
        <View style={styles.spacer} />
        {task.priority !== "none" ? (
          <Badge label={task.priority.toUpperCase()} styles={styles} />
        ) : null}
      </View>
      <Text style={styles.cardTitle}>{task.title}</Text>
      {task.labels.length > 0 ? (
        <Text style={styles.cardMeta}>{task.labels.join(" · ")}</Text>
      ) : null}
      {task.blockReason ? (
        <Text style={styles.error}>
          {BLOCK_REASON_LABELS[task.blockReason]}
          {task.blockDetail ? ` · ${task.blockDetail}` : ""}
        </Text>
      ) : null}
      {task.progress ? (
        <Text style={styles.cardMeta}>
          {task.progress.stage ? `${task.progress.stage}: ` : ""}
          {task.progress.summary}
        </Text>
      ) : null}
      {task.declaration?.kind === "waiting" && task.declaration.summary ? (
        <Text style={styles.warn}>等待中 · {task.declaration.summary}</Text>
      ) : null}
      {task.pendingPermission ? (
        <Text style={styles.error}>
          等待{task.pendingPermission.kind === "question" ? "回答" : "权限"} ·{" "}
          {task.pendingPermission.title}
        </Text>
      ) : null}
      {task.trigger ? (
        <Text style={styles.cardMeta}>
          {triggerLabel(task.trigger)}
          {task.nextRunAt ? ` · 下次 ${formatWhen(task.nextRunAt)}` : ""}
        </Text>
      ) : null}
      {task.hierarchyParentId ? (
        <Text style={styles.cardMeta}>↳ 子任务</Text>
      ) : null}
      {task.parentTaskId ? <Text style={styles.cardMeta}>周期派生</Text> : null}
      <View style={styles.row}>
        <Text style={styles.cardMeta}>rev {task.revision}</Text>
        {task.execution ? (
          <Text style={styles.cardMeta}>
            {task.execution.agentTitle ?? task.execution.agentId.slice(0, 8)}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function CreateCardForm({
  tasks,
  onSubmit,
  onCancel,
  busy,
  styles,
}: {
  tasks: BoardTask[];
  onSubmit: (input: {
    title: string;
    description?: string;
    acceptanceCriteria?: string[];
    priority: BoardPriority;
    labels: string[];
    trigger?: Trigger;
    hierarchyParentId?: string | null;
  }) => void;
  onCancel: () => void;
  busy: boolean;
  styles: Styles;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [priority, setPriority] = useState<BoardPriority>("none");
  const [labels, setLabels] = useState("");
  const [scheduleKind, setScheduleKind] = useState<
    "none" | "scheduled" | "recurring"
  >("none");
  const [runAt, setRunAt] = useState(
    new Date(Date.now() + 10 * 60_000).toISOString(),
  );
  const [cadenceKind, setCadenceKind] = useState<"every" | "cron">("every");
  const [everySeconds, setEverySeconds] = useState("300");
  const [cron, setCron] = useState("*/5 * * * *");
  const [timezone, setTimezone] = useState("");
  const [session, setSession] = useState<"new" | "reuse">("new");
  const [parentId, setParentId] = useState("");

  const buildTrigger = (): Trigger | undefined => {
    if (scheduleKind === "scheduled") {
      return { kind: "scheduled", runAt };
    }
    if (scheduleKind === "recurring") {
      return {
        kind: "recurring",
        cadence:
          cadenceKind === "every"
            ? {
                type: "every",
                everyMs: Math.max(1, Number(everySeconds) || 1) * 1000,
              }
            : {
                type: "cron",
                expression: cron.trim(),
                timezone: timezone.trim() || undefined,
              },
        session,
      };
    }
    return undefined;
  };

  return (
    <View style={styles.inlineForm} testID="task-board-create-form">
      <Text style={styles.sectionTitle}>新建任务</Text>
      <View style={styles.field}>
        <Text style={styles.label}>标题</Text>
        <TextInput
          testID="task-board-create-title"
          value={title}
          onChangeText={setTitle}
          placeholder="例如：修复登录超时"
          placeholderTextColor={styles.label.color}
          style={styles.input}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>描述</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          multiline
          style={[styles.input, styles.textArea]}
          placeholder="背景、约束、相关文件"
          placeholderTextColor={styles.label.color}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>验收标准（每行一条）</Text>
        <TextInput
          value={acceptance}
          onChangeText={setAcceptance}
          multiline
          style={[styles.input, styles.textArea]}
          placeholder={"测试通过\nUI 截图正常"}
          placeholderTextColor={styles.label.color}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>优先级</Text>
        <View style={styles.row}>
          {(["none", "low", "medium", "high", "urgent"] as BoardPriority[]).map(
            (value) => (
              <Pressable
                key={value}
                onPress={() => setPriority(value)}
                style={[
                  styles.chip,
                  priority === value ? styles.chipActive : null,
                ]}
              >
                <Text
                  style={[
                    styles.chipText,
                    priority === value ? styles.chipTextActive : null,
                  ]}
                >
                  {value}
                </Text>
              </Pressable>
            ),
          )}
        </View>
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>标签（逗号分隔）</Text>
        <TextInput
          value={labels}
          onChangeText={setLabels}
          style={styles.input}
          placeholder="cli, paseo"
          placeholderTextColor={styles.label.color}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>父任务</Text>
        <View style={styles.row}>
          <Pressable
            onPress={() => setParentId("")}
            style={[styles.chip, parentId === "" ? styles.chipActive : null]}
          >
            <Text
              style={[
                styles.chipText,
                parentId === "" ? styles.chipTextActive : null,
              ]}
            >
              顶层
            </Text>
          </Pressable>
          {tasks
            .filter((task) => !isTerminalStatus(task.status))
            .slice(0, 8)
            .map((task) => (
              <Pressable
                key={task.id}
                onPress={() => setParentId(task.id)}
                style={[
                  styles.chip,
                  parentId === task.id ? styles.chipActive : null,
                ]}
              >
                <Text
                  style={[
                    styles.chipText,
                    parentId === task.id ? styles.chipTextActive : null,
                  ]}
                >
                  {task.displayId}
                </Text>
              </Pressable>
            ))}
        </View>
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>定时 / 周期</Text>
        <View style={styles.row}>
          {(
            [
              ["none", "无"],
              ["scheduled", "定时一次"],
              ["recurring", "周期"],
            ] as const
          ).map(([value, label]) => (
            <Pressable
              key={value}
              onPress={() => setScheduleKind(value)}
              style={[
                styles.chip,
                scheduleKind === value ? styles.chipActive : null,
              ]}
            >
              <Text
                style={[
                  styles.chipText,
                  scheduleKind === value ? styles.chipTextActive : null,
                ]}
              >
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
        {scheduleKind === "scheduled" ? (
          <TextInput
            value={runAt}
            onChangeText={setRunAt}
            style={styles.input}
            placeholder="2026-11-13T10:30:00.000Z"
            placeholderTextColor={styles.label.color}
          />
        ) : null}
        {scheduleKind === "recurring" ? (
          <>
            <View style={styles.row}>
              <Pressable
                onPress={() => setCadenceKind("every")}
                style={[
                  styles.chip,
                  cadenceKind === "every" ? styles.chipActive : null,
                ]}
              >
                <Text style={styles.chipText}>固定间隔</Text>
              </Pressable>
              <Pressable
                onPress={() => setCadenceKind("cron")}
                style={[
                  styles.chip,
                  cadenceKind === "cron" ? styles.chipActive : null,
                ]}
              >
                <Text style={styles.chipText}>Cron</Text>
              </Pressable>
            </View>
            {cadenceKind === "every" ? (
              <TextInput
                value={everySeconds}
                onChangeText={setEverySeconds}
                keyboardType="numeric"
                style={styles.input}
                placeholder="间隔秒数，例如 300"
                placeholderTextColor={styles.label.color}
              />
            ) : (
              <>
                <TextInput
                  value={cron}
                  onChangeText={setCron}
                  style={styles.input}
                  placeholder="*/5 * * * *"
                  placeholderTextColor={styles.label.color}
                />
                <TextInput
                  value={timezone}
                  onChangeText={setTimezone}
                  style={styles.input}
                  placeholder="IANA 时区，例如 Asia/Shanghai（可选）"
                  placeholderTextColor={styles.label.color}
                />
              </>
            )}
            <View style={styles.row}>
              <Pressable
                onPress={() => setSession("new")}
                style={[
                  styles.chip,
                  session === "new" ? styles.chipActive : null,
                ]}
              >
                <Text style={styles.chipText}>每轮新会话</Text>
              </Pressable>
              <Pressable
                onPress={() => setSession("reuse")}
                style={[
                  styles.chip,
                  session === "reuse" ? styles.chipActive : null,
                ]}
              >
                <Text style={styles.chipText}>复用上一轮会话</Text>
              </Pressable>
            </View>
          </>
        ) : null}
      </View>
      <View style={styles.row}>
        <Button
          label={busy ? "创建中…" : "创建"}
          testID="task-board-create-submit"
          primary
          disabled={busy || !title.trim()}
          onPress={() =>
            onSubmit({
              title: title.trim(),
              description: description.trim() || undefined,
              acceptanceCriteria: acceptance
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
              priority,
              labels: labels
                .split(",")
                .map((label) => label.trim())
                .filter(Boolean),
              trigger: buildTrigger(),
              hierarchyParentId: parentId || null,
            })
          }
          styles={styles}
        />
        <Button
          label="取消"
          onPress={onCancel}
          disabled={busy}
          styles={styles}
        />
      </View>
    </View>
  );
}

function Timeline({ task, styles }: { task: BoardTask; styles: Styles }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>活动</Text>
      {task.activity.length === 0 ? (
        <Text style={styles.empty}>暂无活动</Text>
      ) : (
        [...task.activity]
          .reverse()
          .slice(0, 20)
          .map((entry, index) => (
            <View key={`${entry.at}-${index}`} style={styles.timelineRow}>
              <Text style={styles.timelineAt}>
                {new Date(entry.at).toLocaleTimeString()}
              </Text>
              <Text style={styles.timelineText}>
                {entry.kind}
                {entry.detail ? ` · ${JSON.stringify(entry.detail)}` : ""}
              </Text>
            </View>
          ))
      )}
    </View>
  );
}

function AssignForm({
  task,
  onCancel,
  onAssigned,
  styles,
}: {
  task: BoardTask;
  onCancel: () => void;
  onAssigned: (task: BoardTask) => void;
  styles: Styles;
}) {
  const candidates = useRpc(candidatesRpc);
  const assign = useRpc(assignRpc);
  const [data, setData] = useState<CandidatesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [mode, setMode] = useState<"create" | "existing">("create");
  const [provider, setProvider] = useState("codex");
  const [model, setModel] = useState("workbuddy/hy4flash-dev");
  const [modeId, setModeId] = useState("full-access");
  const [existingAgentId, setExistingAgentId] = useState("");
  const [message, setMessage] = useState("");
  const [start, setStart] = useState(true);
  const expectedRevision = useRefRevision(task.revision);

  useEffect(() => {
    let active = true;
    void candidates({}).then((envelope) => {
      if (!active) return;
      if (!envelope.ok) {
        setError(`${envelope.error.code}: ${envelope.error.message}`);
        return;
      }
      const value = envelope.value;
      setData(value);
      const firstProject = value.projects[0];
      if (firstProject) {
        setProjectId(firstProject.projectId);
        const firstWorkspace = firstProject.workspaces[0];
        if (firstWorkspace) setWorkspaceId(firstWorkspace.workspaceId);
        const firstAgent = firstProject.agents[0];
        if (firstAgent) setExistingAgentId(firstAgent.agentId);
      }
    });
    return () => {
      active = false;
    };
  }, [candidates]);

  const project = data?.projects.find((entry) => entry.projectId === projectId);
  const workspace = project?.workspaces.find(
    (entry) => entry.workspaceId === workspaceId,
  );

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const envelope = await assign({
        taskId: task.id,
        expectedRevision: expectedRevision.current,
        projectId,
        workspaceId,
        agent:
          mode === "create"
            ? {
                kind: "create",
                provider: provider.trim(),
                model: model.trim() || undefined,
                modeId: modeId.trim() || undefined,
              }
            : { kind: "existing", agentId: existingAgentId },
        message: message.trim() || undefined,
        start,
      });
      onAssigned(unwrap(envelope).task);
    } catch (value) {
      setError(messageOf(value));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    !busy &&
    projectId.length > 0 &&
    workspaceId.length > 0 &&
    (mode === "create"
      ? provider.trim().length > 0
      : existingAgentId.length > 0);

  return (
    <View style={styles.inlineForm} testID="task-board-assign-form">
      <Text style={styles.sectionTitle}>分配 Agent</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!data ? (
        <ActivityIndicator color={styles.label.color} />
      ) : (
        <>
          <View style={styles.field}>
            <Text style={styles.label}>Project</Text>
            <View style={styles.row}>
              {data.projects.map((entry) => (
                <Pressable
                  key={entry.projectId}
                  onPress={() => {
                    setProjectId(entry.projectId);
                    const firstWorkspace = entry.workspaces[0];
                    setWorkspaceId(firstWorkspace?.workspaceId ?? "");
                    setExistingAgentId(entry.agents[0]?.agentId ?? "");
                  }}
                  style={[
                    styles.chip,
                    projectId === entry.projectId ? styles.chipActive : null,
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      projectId === entry.projectId
                        ? styles.chipTextActive
                        : null,
                    ]}
                  >
                    {entry.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Workspace</Text>
            <View style={styles.row}>
              {(project?.workspaces ?? []).map((entry) => (
                <Pressable
                  key={entry.workspaceId}
                  onPress={() => setWorkspaceId(entry.workspaceId)}
                  style={[
                    styles.chip,
                    workspaceId === entry.workspaceId
                      ? styles.chipActive
                      : null,
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      workspaceId === entry.workspaceId
                        ? styles.chipTextActive
                        : null,
                    ]}
                  >
                    {entry.name}
                  </Text>
                </Pressable>
              ))}
            </View>
            {workspace ? (
              <Text style={styles.cardMeta}>{workspace.directory}</Text>
            ) : null}
          </View>
          <View style={styles.row}>
            <Button
              label="新建 Agent"
              primary={mode === "create"}
              onPress={() => setMode("create")}
              styles={styles}
            />
            <Button
              label="复用已有 Agent"
              primary={mode === "existing"}
              onPress={() => setMode("existing")}
              styles={styles}
            />
          </View>
          {mode === "create" ? (
            <>
              <View style={styles.field}>
                <Text style={styles.label}>Provider / Model / Mode</Text>
                <View style={styles.row}>
                  <TextInput
                    value={provider}
                    onChangeText={setProvider}
                    style={[styles.input, { flex: 1, minWidth: 110 }]}
                    placeholder="codex"
                    placeholderTextColor={styles.label.color}
                  />
                  <TextInput
                    value={model}
                    onChangeText={setModel}
                    style={[styles.input, { flex: 2, minWidth: 160 }]}
                    placeholder="workbuddy/hy4flash-dev"
                    placeholderTextColor={styles.label.color}
                  />
                  <TextInput
                    value={modeId}
                    onChangeText={setModeId}
                    style={[styles.input, { flex: 1, minWidth: 110 }]}
                    placeholder="full-access"
                    placeholderTextColor={styles.label.color}
                  />
                </View>
                <Text style={styles.cardMeta}>
                  无人值守需要 modeId=full-access；background=true
                  只影响可见性。
                </Text>
              </View>
            </>
          ) : (
            <View style={styles.field}>
              <Text style={styles.label}>已有 Agent</Text>
              <View style={styles.row}>
                {(project?.agents ?? []).map((entry) => (
                  <Pressable
                    key={entry.agentId}
                    onPress={() => setExistingAgentId(entry.agentId)}
                    style={[
                      styles.chip,
                      existingAgentId === entry.agentId
                        ? styles.chipActive
                        : null,
                    ]}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        existingAgentId === entry.agentId
                          ? styles.chipTextActive
                          : null,
                      ]}
                    >
                      {entry.title ?? entry.agentId.slice(0, 8)} ·{" "}
                      {entry.status}
                    </Text>
                  </Pressable>
                ))}
                {(project?.agents ?? []).length === 0 ? (
                  <Text style={styles.cardMeta}>
                    该 Workspace 暂无可用 Agent
                  </Text>
                ) : null}
              </View>
            </View>
          )}
          <View style={styles.field}>
            <Text style={styles.label}>首条消息（留空使用卡片内容）</Text>
            <TextInput
              value={message}
              onChangeText={setMessage}
              multiline
              style={[styles.input, styles.textArea]}
              placeholder="Tell the agent what to do first."
              placeholderTextColor={styles.label.color}
            />
          </View>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: start }}
            onPress={() => setStart((value) => !value)}
            style={styles.row}
          >
            <Text style={styles.value}>{start ? "☑" : "☐"} 分配后立即启动</Text>
          </Pressable>
          <View style={styles.row}>
            <Button
              label={busy ? "分配中…" : "分配"}
              testID="task-board-assign-submit"
              primary
              disabled={!canSubmit}
              onPress={() => void submit()}
              styles={styles}
            />
            <Button
              label="取消"
              onPress={onCancel}
              disabled={busy}
              styles={styles}
            />
          </View>
        </>
      )}
    </View>
  );
}

function useRefRevision(revision: number) {
  const [reference] = useState({ current: revision });
  return reference;
}

function TaskDetail({
  task,
  tasks,
  styling,
  onBack,
  onRefresh,
  onChanged,
  navigation,
}: {
  task: BoardTask;
  tasks: BoardTask[];
  styling: Styles;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onChanged: (task: BoardTask | null) => void;
  navigation: PluginScreenProps["navigation"];
}) {
  const update = useRpc(updateRpc);
  const setStatus = useRpc(setStatusRpc);
  const start = useRpc(startRpc);
  const stop = useRpc(stopRpc);
  const del = useRpc(deleteRpc);
  const schedule = useRpc(scheduleRpc);
  const setHierarchy = useRpc(setHierarchyRpc);
  const cancelTask = useRpc(cancelRpc);
  const unassign = useRpc(unassignRpc);
  const hierarchy = useRpc(hierarchyRpc);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editRevision, setEditRevision] = useState(task.revision);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [acceptance, setAcceptance] = useState(
    (task.acceptanceCriteria ?? []).join("\n"),
  );
  const [priority, setPriority] = useState<BoardPriority>(task.priority);
  const [labels, setLabels] = useState(task.labels.join(", "));
  const [assigning, setAssigning] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleKind, setScheduleKind] = useState<
    "none" | "scheduled" | "recurring"
  >(
    task.trigger?.kind === "scheduled"
      ? "scheduled"
      : task.trigger?.kind === "recurring"
        ? "recurring"
        : "none",
  );
  const [runAt, setRunAt] = useState(
    task.trigger?.kind === "scheduled"
      ? task.trigger.runAt
      : new Date(Date.now() + 10 * 60_000).toISOString(),
  );
  const [cadenceKind, setCadenceKind] = useState<"every" | "cron">(
    task.trigger?.kind === "recurring" ? task.trigger.cadence.type : "every",
  );
  const [everySeconds, setEverySeconds] = useState(
    task.trigger?.kind === "recurring" && task.trigger.cadence.type === "every"
      ? String(Math.round(task.trigger.cadence.everyMs / 1000))
      : "300",
  );
  const [cron, setCron] = useState(
    task.trigger?.kind === "recurring" && task.trigger.cadence.type === "cron"
      ? task.trigger.cadence.expression
      : "*/5 * * * *",
  );
  const [timezone, setTimezone] = useState(
    task.trigger?.kind === "recurring" && task.trigger.cadence.type === "cron"
      ? (task.trigger.cadence.timezone ?? "")
      : "",
  );
  const [session, setSession] = useState<"new" | "reuse">(
    task.trigger?.kind === "recurring" ? task.trigger.session : "new",
  );
  const [parentId, setParentId] = useState(task.hierarchyParentId ?? "");
  const [tree, setTree] = useState<HierarchyResult | null>(null);

  useEffect(() => {
    if (editing) return;
    setTitle(task.title);
    setDescription(task.description ?? "");
    setAcceptance((task.acceptanceCriteria ?? []).join("\n"));
    setPriority(task.priority);
    setLabels(task.labels.join(", "));
  }, [task.revision, editing, task]);

  useEffect(() => {
    let active = true;
    void hierarchy({ taskId: task.id }).then((envelope) => {
      if (!active) return;
      if (envelope.ok) {
        setTree(envelope.value);
        setParentId(envelope.value.task.hierarchyParentId ?? "");
      }
    });
    return () => {
      active = false;
    };
  }, [hierarchy, task.id, task.revision]);

  useEffect(() => {
    setScheduling(false);
    setScheduleKind(
      task.trigger?.kind === "scheduled"
        ? "scheduled"
        : task.trigger?.kind === "recurring"
          ? "recurring"
          : "none",
    );
    setRunAt(
      task.trigger?.kind === "scheduled"
        ? task.trigger.runAt
        : new Date(Date.now() + 10 * 60_000).toISOString(),
    );
    setCadenceKind(
      task.trigger?.kind === "recurring" ? task.trigger.cadence.type : "every",
    );
    setEverySeconds(
      task.trigger?.kind === "recurring" &&
        task.trigger.cadence.type === "every"
        ? String(Math.round(task.trigger.cadence.everyMs / 1000))
        : "300",
    );
    setCron(
      task.trigger?.kind === "recurring" && task.trigger.cadence.type === "cron"
        ? task.trigger.cadence.expression
        : "*/5 * * * *",
    );
    setTimezone(
      task.trigger?.kind === "recurring" && task.trigger.cadence.type === "cron"
        ? (task.trigger.cadence.timezone ?? "")
        : "",
    );
    setSession(
      task.trigger?.kind === "recurring" ? task.trigger.session : "new",
    );
  }, [task.id]);

  const handleConflict = (value: unknown) => {
    if (isConflict(value)) {
      const details = value.details ?? {};
      setConflict(
        `409 revision 冲突：期望 ${String(details.expected)}，当前 ${String(
          details.actual,
        )}。卡片已被其他操作更新。`,
      );
      return true;
    }
    return false;
  };

  const run = async (name: string, work: () => Promise<BoardTask | null>) => {
    setBusy(name);
    setError(null);
    try {
      const result = await work();
      onChanged(result);
    } catch (value) {
      if (!handleConflict(value)) setError(messageOf(value));
    } finally {
      setBusy(null);
    }
  };

  const beginEdit = () => {
    setEditRevision(task.revision);
    setEditing(true);
    setConflict(null);
  };

  const save = () =>
    run("save", async () => {
      const value = unwrap(
        await update({
          taskId: task.id,
          expectedRevision: editRevision,
          patch: {
            title: title.trim(),
            description: description.trim() || null,
            acceptanceCriteria: acceptance
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
            priority,
            labels: labels
              .split(",")
              .map((label) => label.trim())
              .filter(Boolean),
          },
        }),
      );
      setEditing(false);
      setConflict(null);
      return value.task;
    });

  const saveSchedule = () =>
    run("schedule", async () => {
      let trigger: Trigger | null = null;
      if (scheduleKind === "scheduled") {
        trigger = { kind: "scheduled", runAt };
      } else if (scheduleKind === "recurring") {
        trigger = {
          kind: "recurring",
          cadence:
            cadenceKind === "every"
              ? {
                  type: "every",
                  everyMs: Math.max(1, Number(everySeconds) || 1) * 1000,
                }
              : {
                  type: "cron",
                  expression: cron.trim(),
                  timezone: timezone.trim() || undefined,
                },
          session,
        };
      }
      const value = unwrap(
        await schedule({
          taskId: task.id,
          expectedRevision: task.revision,
          trigger,
        }),
      );
      setScheduling(false);
      return value.task;
    });

  const saveParent = () =>
    run("parent", async () => {
      const value = unwrap(
        await setHierarchy({
          taskId: task.id,
          expectedRevision: task.revision,
          parentId: parentId || null,
        }),
      );
      return value.task;
    });

  return (
    <View style={styling.detail} testID="task-board-detail">
      <ScrollView contentContainerStyle={styling.detailContent}>
        <View style={styling.row}>
          <Button label="← 返回看板" onPress={onBack} styles={styling} />
          <Text style={styling.subtitle}>{task.displayId}</Text>
          <View style={styling.spacer} />
          <Badge
            label={`${BOARD_STATUS_LABELS[task.status]} · rev ${task.revision}`}
            color={BOARD_STATUS_COLORS[task.status]}
            styles={styling}
          />
        </View>

        {conflict ? (
          <View style={styling.banner} testID="task-board-conflict">
            <Text style={styling.error}>{conflict}</Text>
            <View style={styling.row}>
              <Button
                label="刷新卡片"
                primary
                onPress={() =>
                  void onRefresh().then(() => {
                    setConflict(null);
                    setEditing(false);
                  })
                }
                styles={styling}
              />
            </View>
          </View>
        ) : null}
        {error ? <Text style={styling.error}>{error}</Text> : null}

        {editing ? (
          <View style={styling.inlineForm}>
            <View style={styling.field}>
              <Text style={styling.label}>标题</Text>
              <TextInput
                value={title}
                onChangeText={setTitle}
                style={styling.input}
                testID="task-board-edit-title"
              />
            </View>
            <View style={styling.field}>
              <Text style={styling.label}>描述</Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                multiline
                style={[styling.input, styling.textArea]}
              />
            </View>
            <View style={styling.field}>
              <Text style={styling.label}>验收标准（每行一条）</Text>
              <TextInput
                value={acceptance}
                onChangeText={setAcceptance}
                multiline
                style={[styling.input, styling.textArea]}
              />
            </View>
            <View style={styling.field}>
              <Text style={styling.label}>优先级</Text>
              <View style={styling.row}>
                {(
                  ["none", "low", "medium", "high", "urgent"] as BoardPriority[]
                ).map((value) => (
                  <Pressable
                    key={value}
                    onPress={() => setPriority(value)}
                    style={[
                      styling.chip,
                      priority === value ? styling.chipActive : null,
                    ]}
                  >
                    <Text
                      style={[
                        styling.chipText,
                        priority === value ? styling.chipTextActive : null,
                      ]}
                    >
                      {value}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <View style={styling.field}>
              <Text style={styling.label}>标签</Text>
              <TextInput
                value={labels}
                onChangeText={setLabels}
                style={styling.input}
              />
            </View>
            <View style={styling.row}>
              <Button
                label={busy === "save" ? "保存中…" : "保存"}
                testID="task-board-edit-save"
                primary
                disabled={busy !== null}
                onPress={() => void save()}
                styles={styling}
              />
              <Button
                label="取消"
                disabled={busy !== null}
                onPress={() => setEditing(false)}
                styles={styling}
              />
            </View>
          </View>
        ) : (
          <View style={styling.section}>
            <Text style={styling.title}>{task.title}</Text>
            <Text style={styling.value}>
              {task.description ?? "（无描述）"}
            </Text>
            {(task.acceptanceCriteria ?? []).length > 0 ? (
              <View style={styling.section}>
                <Text style={styling.sectionTitle}>验收标准</Text>
                {(task.acceptanceCriteria ?? []).map((item) => (
                  <Text key={item} style={styling.value}>
                    • {item}
                  </Text>
                ))}
              </View>
            ) : null}
            <View style={styling.row}>
              <Text style={styling.label}>优先级</Text>
              <Text style={styling.value}>{task.priority}</Text>
              <Text style={styling.label}>标签</Text>
              <Text style={styling.value}>
                {task.labels.length > 0 ? task.labels.join(", ") : "—"}
              </Text>
            </View>
          </View>
        )}

        {task.blockReason ? (
          <View style={styling.banner}>
            <Text style={styling.error}>
              {BLOCK_REASON_LABELS[task.blockReason]}
            </Text>
            {task.blockDetail ? (
              <Text style={styling.value}>{task.blockDetail}</Text>
            ) : null}
            {task.pendingPermission ? (
              <>
                <Text style={styling.label}>
                  待处理请求 · {task.pendingPermission.requestId}
                </Text>
                <Text style={styling.value}>
                  {task.pendingPermission.title}
                </Text>
                {task.pendingPermission.detail ? (
                  <Text style={styling.value}>
                    {task.pendingPermission.detail}
                  </Text>
                ) : null}
                <Text style={styling.cardMeta}>
                  {task.pendingPermission.kind === "question"
                    ? "Agent 提问，答复后自动恢复。"
                    : "Agent 等待权限，允许后自动恢复；拒绝则保持阻塞。"}
                </Text>
              </>
            ) : null}
            {task.declaration?.humanRequest ? (
              <>
                <Text style={styling.sectionTitle}>
                  {task.declaration.humanRequest.title}
                </Text>
                <Text style={styling.value}>
                  {task.declaration.humanRequest.instructions}
                </Text>
                {task.declaration.humanRequest.action?.kind === "open_url" ? (
                  <Text style={styling.mono}>
                    {task.declaration.humanRequest.action.url}
                  </Text>
                ) : null}
                {task.declaration.humanRequest.action?.kind ===
                "open_terminal" ? (
                  <Text style={styling.mono}>
                    $ {task.declaration.humanRequest.action.command}
                  </Text>
                ) : null}
              </>
            ) : null}
          </View>
        ) : null}

        {task.declaration?.kind === "waiting" ? (
          <View style={styling.warnBanner}>
            <Text style={styling.warn}>
              等待中
              {task.declaration.summary ? `：${task.declaration.summary}` : ""}
            </Text>
          </View>
        ) : null}
        {task.progress ? (
          <View style={styling.warnBanner}>
            <Text style={styling.warn}>
              进度{task.progress.stage ? ` [${task.progress.stage}]` : ""}：
              {task.progress.summary}
            </Text>
          </View>
        ) : null}

        <View style={styling.section}>
          <Text style={styling.sectionTitle}>层级 / 子任务</Text>
          {tree?.parent ? (
            <Text style={styling.value}>
              父任务：{tree.parent.displayId} · {tree.parent.title}
            </Text>
          ) : (
            <Text style={styling.subtitle}>顶层任务</Text>
          )}
          {tree ? (
            <Text style={styling.cardMeta}>
              子任务 {tree.summary.done}/{tree.summary.total} 完成 ·{" "}
              {tree.summary.percent}% · 进行中 {tree.summary.inProgress} ·
              待验收 {tree.summary.inReview} · 阻塞 {tree.summary.blocked}
            </Text>
          ) : null}
          {(tree?.children ?? []).length > 0 ? (
            <View style={styling.section}>
              {(tree?.children ?? []).map((child) => (
                <View key={child.id} style={styling.row}>
                  <Text style={styling.mono}>{child.displayId}</Text>
                  <Text style={styling.value}>{child.title}</Text>
                  <Badge
                    label={BOARD_STATUS_LABELS[child.status]}
                    color={BOARD_STATUS_COLORS[child.status]}
                    styles={styling}
                  />
                </View>
              ))}
            </View>
          ) : null}
          <View style={styling.row}>
            <Pressable
              onPress={() => setParentId("")}
              style={[
                styling.chip,
                parentId === "" ? styling.chipActive : null,
              ]}
            >
              <Text
                style={[
                  styling.chipText,
                  parentId === "" ? styling.chipTextActive : null,
                ]}
              >
                设为顶层
              </Text>
            </Pressable>
            {tasks
              .filter(
                (entry) =>
                  entry.id !== task.id && !isTerminalStatus(entry.status),
              )
              .slice(0, 8)
              .map((entry) => (
                <Pressable
                  key={entry.id}
                  onPress={() => setParentId(entry.id)}
                  style={[
                    styling.chip,
                    parentId === entry.id ? styling.chipActive : null,
                  ]}
                >
                  <Text style={styling.chipText}>{entry.displayId}</Text>
                </Pressable>
              ))}
            <Button
              label={busy === "parent" ? "保存中…" : "保存父任务"}
              disabled={busy !== null}
              onPress={() => void saveParent()}
              styles={styling}
            />
          </View>
        </View>

        <View style={styling.section}>
          <Text style={styling.sectionTitle}>定时 / 周期</Text>
          <Text style={styling.value}>当前：{triggerLabel(task.trigger)}</Text>
          <Text style={styling.cardMeta}>
            下次触发：{formatWhen(task.nextRunAt)}
            {task.derivedCount > 0 ? ` · 已派生 ${task.derivedCount} 轮` : ""}
          </Text>
          {scheduling ? (
            <View style={styling.inlineForm}>
              <View style={styling.row}>
                {(
                  [
                    ["none", "无"],
                    ["scheduled", "定时一次"],
                    ["recurring", "周期"],
                  ] as const
                ).map(([value, label]) => (
                  <Pressable
                    key={value}
                    onPress={() => setScheduleKind(value)}
                    style={[
                      styling.chip,
                      scheduleKind === value ? styling.chipActive : null,
                    ]}
                  >
                    <Text
                      style={[
                        styling.chipText,
                        scheduleKind === value ? styling.chipTextActive : null,
                      ]}
                    >
                      {label}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {scheduleKind === "scheduled" ? (
                <TextInput
                  value={runAt}
                  onChangeText={setRunAt}
                  style={styling.input}
                  placeholder="2026-11-13T10:30:00.000Z"
                  placeholderTextColor={styling.label.color}
                />
              ) : null}
              {scheduleKind === "recurring" ? (
                <>
                  <View style={styling.row}>
                    <Pressable
                      onPress={() => setCadenceKind("every")}
                      style={[
                        styling.chip,
                        cadenceKind === "every" ? styling.chipActive : null,
                      ]}
                    >
                      <Text style={styling.chipText}>固定间隔</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setCadenceKind("cron")}
                      style={[
                        styling.chip,
                        cadenceKind === "cron" ? styling.chipActive : null,
                      ]}
                    >
                      <Text style={styling.chipText}>Cron</Text>
                    </Pressable>
                  </View>
                  {cadenceKind === "every" ? (
                    <TextInput
                      value={everySeconds}
                      onChangeText={setEverySeconds}
                      keyboardType="numeric"
                      style={styling.input}
                      placeholder="间隔秒数"
                      placeholderTextColor={styling.label.color}
                    />
                  ) : (
                    <>
                      <TextInput
                        value={cron}
                        onChangeText={setCron}
                        style={styling.input}
                        placeholder="*/5 * * * *"
                        placeholderTextColor={styling.label.color}
                      />
                      <TextInput
                        value={timezone}
                        onChangeText={setTimezone}
                        style={styling.input}
                        placeholder="Asia/Shanghai（可选）"
                        placeholderTextColor={styling.label.color}
                      />
                    </>
                  )}
                  <View style={styling.row}>
                    <Pressable
                      onPress={() => setSession("new")}
                      style={[
                        styling.chip,
                        session === "new" ? styling.chipActive : null,
                      ]}
                    >
                      <Text style={styling.chipText}>每轮新会话</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setSession("reuse")}
                      style={[
                        styling.chip,
                        session === "reuse" ? styling.chipActive : null,
                      ]}
                    >
                      <Text style={styling.chipText}>复用上一轮会话</Text>
                    </Pressable>
                  </View>
                </>
              ) : null}
              <View style={styling.row}>
                <Button
                  label={busy === "schedule" ? "保存中…" : "保存定时"}
                  primary
                  disabled={busy !== null}
                  onPress={() => void saveSchedule()}
                  styles={styling}
                />
                <Button
                  label="取消"
                  disabled={busy !== null}
                  onPress={() => setScheduling(false)}
                  styles={styling}
                />
              </View>
            </View>
          ) : (
            <View style={styling.row}>
              <Button
                label={task.trigger ? "修改定时" : "设置定时"}
                disabled={busy !== null || isTerminalStatus(task.status)}
                onPress={() => setScheduling(true)}
                styles={styling}
              />
              {task.trigger ? (
                <Button
                  label="清除定时"
                  disabled={busy !== null}
                  onPress={() =>
                    void run("schedule", async () => {
                      const value = unwrap(
                        await schedule({
                          taskId: task.id,
                          expectedRevision: task.revision,
                          trigger: null,
                        }),
                      );
                      return value.task;
                    })
                  }
                  styles={styling}
                />
              ) : null}
            </View>
          )}
        </View>

        <View style={styling.section}>
          <Text style={styling.sectionTitle}>执行</Text>
          {task.execution ? (
            <View style={styling.card}>
              <View style={styling.row}>
                <Text style={styling.label}>Project</Text>
                <Text style={styling.value}>
                  {task.execution.project.projectName}
                </Text>
              </View>
              <View style={styling.row}>
                <Text style={styling.label}>Workspace</Text>
                <Text style={styling.value}>
                  {task.execution.workspace.workspaceName}
                </Text>
              </View>
              <View style={styling.row}>
                <Text style={styling.label}>Agent</Text>
                {navigation ? (
                  <Pressable
                    onPress={() =>
                      navigation.openAgent({
                        agentId: task.execution?.agentId ?? "",
                      })
                    }
                  >
                    <Text style={[styling.value, { color: styling.ok.color }]}>
                      {task.execution.agentTitle ??
                        task.execution.agentId.slice(0, 12)}
                    </Text>
                  </Pressable>
                ) : (
                  <Text style={styling.value}>
                    {task.execution.agentTitle ??
                      task.execution.agentId.slice(0, 12)}
                  </Text>
                )}
                <Text style={styling.mono}>{task.execution.agentId}</Text>
              </View>
              <View style={styling.row}>
                <Text style={styling.label}>Provider</Text>
                <Text style={styling.value}>
                  {task.execution.provider}
                  {task.execution.model ? `/${task.execution.model}` : ""}
                </Text>
                <Text style={styling.label}>Runs</Text>
                <Text style={styling.value}>{task.runCount}</Text>
              </View>
            </View>
          ) : (
            <Text style={styling.subtitle}>尚未分配 Agent。</Text>
          )}
        </View>

        {assigning ? (
          <AssignForm
            task={task}
            styles={styling}
            onCancel={() => setAssigning(false)}
            onAssigned={(updated) => {
              setAssigning(false);
              onChanged(updated);
            }}
          />
        ) : null}

        <View style={styling.row}>
          {!isTerminalStatus(task.status) &&
          task.status !== "in_progress" &&
          task.execution ? (
            <Button
              label="开始执行"
              testID="task-board-start"
              primary
              disabled={busy !== null}
              onPress={() =>
                void run("start", async () => {
                  const value = unwrap(await start({ taskId: task.id }));
                  return value.task;
                })
              }
              styles={styling}
            />
          ) : null}
          {!isTerminalStatus(task.status) && task.execution ? (
            <Button
              label={busy === "stop" ? "停止中…" : "停止"}
              testID="task-board-stop"
              danger
              disabled={busy !== null}
              onPress={() =>
                void run("stop", async () => {
                  const value = unwrap(await stop({ taskId: task.id }));
                  return value.task;
                })
              }
              styles={styling}
            />
          ) : null}
          {!task.execution && !isTerminalStatus(task.status) ? (
            <Button
              label="分配 Agent"
              testID="task-board-assign-open"
              primary
              onPress={() => setAssigning(true)}
              styles={styling}
            />
          ) : null}
          {task.execution && !isTerminalStatus(task.status) ? (
            <Button
              label={busy === "unassign" ? "解除中…" : "解除绑定"}
              testID="task-board-unassign"
              disabled={busy !== null}
              onPress={() =>
                void run("unassign", async () => {
                  const value = unwrap(
                    await unassign({
                      taskId: task.id,
                      expectedRevision: task.revision,
                    }),
                  );
                  return value.task;
                })
              }
              styles={styling}
            />
          ) : null}
          {task.status === "in_review" || task.status === "blocked" ? (
            <Button
              label="验收完成"
              testID="task-board-done"
              primary
              disabled={busy !== null}
              onPress={() =>
                void run("done", async () => {
                  const value = unwrap(
                    await setStatus({
                      taskId: task.id,
                      expectedRevision: task.revision,
                      status: "done",
                    }),
                  );
                  return value.task;
                })
              }
              styles={styling}
            />
          ) : null}
          {!editing ? (
            <Button label="编辑" onPress={beginEdit} styles={styling} />
          ) : null}
          {!isTerminalStatus(task.status) ? (
            <Button
              label="取消任务"
              danger
              disabled={busy !== null}
              onPress={() =>
                void run("cancel", async () => {
                  const value = unwrap(
                    await cancelTask({
                      taskId: task.id,
                      expectedRevision: task.revision,
                    }),
                  );
                  return value.task;
                })
              }
              styles={styling}
            />
          ) : null}
          {isTerminalStatus(task.status) ? (
            <Button
              label="重新打开"
              disabled={busy !== null}
              onPress={() =>
                void run("reopen", async () => {
                  const value = unwrap(
                    await setStatus({
                      taskId: task.id,
                      expectedRevision: task.revision,
                      status: "todo",
                    }),
                  );
                  return value.task;
                })
              }
              styles={styling}
            />
          ) : null}
          <Button
            label={deleteArmed ? "确认删除" : "删除"}
            danger
            disabled={busy !== null}
            onPress={() => {
              if (!deleteArmed) {
                setDeleteArmed(true);
                return;
              }
              void run("delete", async () => {
                unwrap(
                  await del({
                    taskId: task.id,
                    expectedRevision: task.revision,
                  }),
                );
                onBack();
                return null;
              });
            }}
            styles={styling}
          />
        </View>

        <Timeline task={task} styles={styling} />
      </ScrollView>
    </View>
  );
}

function SettingsPanel({
  styles,
  health,
  onClose,
}: {
  styles: Styles;
  health: HealthResult | null;
  onClose: () => void;
}) {
  const getSettings = useRpc(settingsGetRpc);
  const updateSettings = useRpc(settingsUpdateRpc);
  const testNotification = useRpc(notificationsTestRpc);
  const migrate = useRpc(migrateLegacyRpc);
  const [settings, setSettings] = useState<BoardSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [sourcePath, setSourcePath] = useState("");
  const [migrationReport, setMigrationReport] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getSettings({}).then((envelope) => {
      if (!active) return;
      if (envelope.ok) setSettings(envelope.value.settings);
      else setError(`${envelope.error.code}: ${envelope.error.message}`);
    });
    return () => {
      active = false;
    };
  }, [getSettings]);

  const patchWecom = (patch: Partial<BoardSettings["wecom"]>) => {
    setSettings((current) =>
      current ? { ...current, wecom: { ...current.wecom, ...patch } } : current,
    );
  };

  const save = async () => {
    if (!settings) return;
    setBusy("save");
    setError(null);
    try {
      const value = unwrap(
        await updateSettings({ patch: { wecom: settings.wecom } }),
      );
      setSettings(value.settings);
    } catch (value) {
      setError(messageOf(value));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!settings) return;
    setBusy("test");
    setError(null);
    setTestResult(null);
    try {
      const value = unwrap(
        await testNotification({
          webhookUrl: settings.wecom.webhookUrl.trim() || undefined,
        }),
      );
      setTestResult(
        value.ok
          ? `发送成功 · ${value.attempts.length} 次尝试`
          : `发送失败 · ${value.attempts.length} 次尝试 · ${value.error ?? "未知错误"}`,
      );
    } catch (value) {
      setError(messageOf(value));
    } finally {
      setBusy(null);
    }
  };

  const runMigration = async (apply: boolean) => {
    setBusy(apply ? "migrate" : "dryrun");
    setError(null);
    setMigrationReport(null);
    try {
      const value = unwrap(
        await migrate({
          dryRun: !apply,
          sourcePath: sourcePath.trim() || undefined,
          includeFinished: true,
        }),
      );
      setMigrationReport(
        [
          value.noop
            ? "no-op（sourceDigest 未变化）"
            : apply
              ? "已导入"
              : "dry-run",
          `source: ${value.sourcePath}`,
          `digest: ${value.sourceDigest.slice(0, 16)}…`,
          `mapped: ${value.mapped.length} · skipped: ${value.skipped.length} · conflicts: ${value.conflicts.length}`,
          ...value.conflicts.map(
            (entry) => `${entry.legacyId} [${entry.kind}] ${entry.message}`,
          ),
        ].join("\n"),
      );
    } catch (value) {
      setError(messageOf(value));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.detailContent}>
      <View style={styles.row}>
        <Button label="← 返回看板" onPress={onClose} styles={styles} />
        <Text style={styles.title}>任务看板设置</Text>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>WeCom 通知</Text>
        <Text style={styles.cardMeta}>
          配置保存在插件数据目录 settings.json，不写入 Paseo 配置。
        </Text>
        {settings ? (
          <>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: settings.wecom.enabled }}
              onPress={() => patchWecom({ enabled: !settings.wecom.enabled })}
              style={styles.row}
            >
              <Text style={styles.value}>
                {settings.wecom.enabled ? "☑" : "☐"} 启用 WeCom 通知
              </Text>
            </Pressable>
            <View style={styles.field}>
              <Text style={styles.label}>Webhook URL</Text>
              <TextInput
                value={settings.wecom.webhookUrl}
                onChangeText={(value) => patchWecom({ webhookUrl: value })}
                style={styles.input}
                placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
                placeholderTextColor={styles.label.color}
              />
            </View>
            <View style={styles.row}>
              {(
                [
                  ["notifyOnReview", "待验收"],
                  ["notifyOnBlocked", "阻塞"],
                  ["notifyOnScheduled", "定时触发"],
                  ["notifyOnProgress", "进度"],
                ] as const
              ).map(([key, label]) => (
                <Pressable
                  key={key}
                  onPress={() => patchWecom({ [key]: !settings.wecom[key] })}
                  style={[
                    styles.chip,
                    settings.wecom[key] ? styles.chipActive : null,
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      settings.wecom[key] ? styles.chipTextActive : null,
                    ]}
                  >
                    {settings.wecom[key] ? "☑" : "☐"} {label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.row}>
              <View style={styles.field}>
                <Text style={styles.label}>重试次数</Text>
                <TextInput
                  value={String(settings.wecom.retries)}
                  onChangeText={(value) =>
                    patchWecom({ retries: Number(value) || 0 })
                  }
                  keyboardType="numeric"
                  style={[styles.input, { width: 90 }]}
                />
              </View>
              <View style={styles.field}>
                <Text style={styles.label}>限流间隔 ms</Text>
                <TextInput
                  value={String(settings.wecom.minIntervalMs)}
                  onChangeText={(value) =>
                    patchWecom({ minIntervalMs: Number(value) || 0 })
                  }
                  keyboardType="numeric"
                  style={[styles.input, { width: 110 }]}
                />
              </View>
            </View>
            <View style={styles.row}>
              <Button
                label={busy === "save" ? "保存中…" : "保存设置"}
                primary
                disabled={busy !== null}
                onPress={() => void save()}
                styles={styles}
              />
              <Button
                label={busy === "test" ? "发送中…" : "发送测试消息"}
                disabled={busy !== null}
                onPress={() => void test()}
                styles={styles}
              />
            </View>
            {testResult ? (
              <Text
                style={
                  testResult.startsWith("发送成功") ? styles.ok : styles.error
                }
              >
                {testResult}
              </Text>
            ) : null}
          </>
        ) : (
          <ActivityIndicator />
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>调度器</Text>
        <Text style={styles.cardMeta}>
          到点任务：{health?.scheduledCount ?? 0} · 等待权限：
          {health?.pendingPermissionCount ?? 0}
        </Text>
        <Text style={styles.cardMeta}>
          lock held: {String(health?.scheduler?.lockHeld ?? false)} · owner:{" "}
          {health?.scheduler?.lockOwner ?? "—"} · last tick:{" "}
          {health?.scheduler?.lastTickAt ?? "—"}
        </Text>
        {health?.scheduler?.lastError ? (
          <Text style={styles.error}>{health.scheduler.lastError}</Text>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>迁移旧任务</Text>
        <Text style={styles.cardMeta}>
          只读 $PASEO_HOME/tasks/tasks.json，不删除、不改写源文件。
        </Text>
        <View style={styles.field}>
          <Text style={styles.label}>源文件（留空使用默认路径）</Text>
          <TextInput
            value={sourcePath}
            onChangeText={setSourcePath}
            style={styles.input}
            placeholder={`${health?.paseoHome ?? "$PASEO_HOME"}/tasks/tasks.json`}
            placeholderTextColor={styles.label.color}
          />
        </View>
        <View style={styles.row}>
          <Button
            label={busy === "dryrun" ? "预演中…" : "预演"}
            disabled={busy !== null}
            onPress={() => void runMigration(false)}
            styles={styles}
          />
          <Button
            label={busy === "migrate" ? "导入中…" : "执行导入"}
            primary
            disabled={busy !== null}
            onPress={() => void runMigration(true)}
            styles={styles}
          />
        </View>
        {migrationReport ? (
          <Text style={styles.mono}>{migrationReport}</Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

export function TaskBoardScreen({
  theme,
  navigation,
  params,
}: PluginScreenProps) {
  const { width: windowWidth } = useWindowDimensions();
  const narrow = windowWidth < 760;
  const styles = useMemo(() => makeStyles(theme, narrow), [theme, narrow]);
  const list = useRpc(listRpc);
  const create = useRpc(createRpc);
  const health = useRpc(healthRpc);
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [healthState, setHealthState] = useState<HealthResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [compactStatus, setCompactStatus] = useState<BoardStatus>("planning");
  const [createOpen, setCreateOpen] = useState(params.new === "1");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const compactInitialized = useRef(false);

  const refresh = useCallback(async () => {
    const envelope = await list({
      includeFinished: true,
      query: query.trim() || undefined,
    });
    if (!envelope.ok) {
      setError(`${envelope.error.code}: ${envelope.error.message}`);
      return;
    }
    setTasks(envelope.value.tasks);
    setCounts(envelope.value.counts);
    setError(null);
    setLoading(false);
  }, [list, query]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let active = true;
    void health({}).then((envelope) => {
      if (active && envelope.ok) setHealthState(envelope.value);
    });
    return () => {
      active = false;
    };
  }, [health]);

  useEffect(() => {
    if (!narrow || compactInitialized.current) return;
    if (Object.values(counts).every((count) => count === 0)) return;
    compactInitialized.current = true;
    if ((counts[compactStatus] ?? 0) > 0) return;
    const firstWithTasks = BOARD_STATUSES.find(
      (status) => (counts[status] ?? 0) > 0,
    );
    if (firstWithTasks) setCompactStatus(firstWithTasks);
  }, [narrow, counts, compactStatus]);

  const selected = tasks.find((task) => task.id === selectedId) ?? null;

  const createTask = async (input: {
    title: string;
    description?: string;
    acceptanceCriteria?: string[];
    priority: BoardPriority;
    labels: string[];
    trigger?: Trigger;
    hierarchyParentId?: string | null;
  }) => {
    setBusy("create");
    setError(null);
    try {
      const value = unwrap(
        await create({
          title: input.title,
          description: input.description,
          acceptanceCriteria: input.acceptanceCriteria,
          priority: input.priority,
          labels: input.labels,
          trigger: input.trigger,
          hierarchyParentId: input.hierarchyParentId,
        }),
      );
      setCreateOpen(false);
      await refresh();
      setSelectedId(value.task.id);
    } catch (value) {
      setError(messageOf(value));
    } finally {
      setBusy(null);
    }
  };

  const columns = narrow
    ? BOARD_STATUSES.filter((status) => status === compactStatus)
    : BOARD_STATUSES;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.title}>
              {settingsOpen
                ? "任务看板设置"
                : selected
                  ? selected.displayId
                  : "任务看板"}
            </Text>
            <Text style={styles.subtitle}>
              待验收 {counts.in_review ?? 0} · 阻塞 {counts.blocked ?? 0} ·
              进行中 {counts.in_progress ?? 0} · 共 {tasks.length}
            </Text>
          </View>
          <View style={styles.row}>
            {settingsOpen ? (
              <Button
                label="← 返回看板"
                onPress={() => setSettingsOpen(false)}
                styles={styles}
              />
            ) : selected ? (
              <Button
                label="← 返回看板"
                onPress={() => setSelectedId(null)}
                styles={styles}
              />
            ) : (
              <>
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder="搜索标题 / 描述"
                  placeholderTextColor={styles.label.color}
                  style={[styles.input, { minWidth: 180 }]}
                  testID="task-board-search"
                />
                <Button
                  label="新建任务"
                  testID="task-board-create-open"
                  primary
                  onPress={() => setCreateOpen(true)}
                  styles={styles}
                />
                <Button
                  label="设置"
                  onPress={() => setSettingsOpen(true)}
                  styles={styles}
                />
              </>
            )}
          </View>
        </View>
        {healthState && !healthState.toolInjectionEnabled && !selected ? (
          <View style={styles.warnBanner} testID="task-board-health">
            <Text style={styles.warn}>
              board_declare 未注入：宿主 daemon.mcp.injectIntoAgents=false。
              Agent 只能依赖 hooks 推断状态；请在宿主配置开启后重启 daemon。
            </Text>
          </View>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      {settingsOpen ? (
        <SettingsPanel
          styles={styles}
          health={healthState}
          onClose={() => {
            setSettingsOpen(false);
            void refresh();
          }}
        />
      ) : selected ? (
        <TaskDetail
          task={selected}
          tasks={tasks}
          styling={styles}
          navigation={navigation}
          onBack={() => setSelectedId(null)}
          onRefresh={refresh}
          onChanged={(updated) => {
            if (updated === null) {
              setSelectedId(null);
              void refresh();
              return;
            }
            setTasks((current) =>
              current.map((task) => (task.id === updated.id ? updated : task)),
            );
            void refresh();
          }}
        />
      ) : (
        <>
          {narrow ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.statusStrip}
              contentContainerStyle={{
                paddingHorizontal: 12,
                paddingTop: 10,
                gap: 6,
                alignItems: "flex-start",
                flexGrow: 0,
              }}
            >
              {BOARD_STATUSES.map((status) => (
                <Pressable
                  key={status}
                  onPress={() => setCompactStatus(status)}
                  style={[
                    styles.chip,
                    compactStatus === status ? styles.chipActive : null,
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      compactStatus === status ? styles.chipTextActive : null,
                    ]}
                  >
                    {BOARD_STATUS_LABELS[status]} {counts[status] ?? 0}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
          {createOpen ? (
            <View style={{ paddingHorizontal: 18, paddingTop: 12 }}>
              <CreateCardForm
                tasks={tasks}
                busy={busy === "create"}
                styles={styles}
                onCancel={() => setCreateOpen(false)}
                onSubmit={(input) => void createTask(input)}
              />
            </View>
          ) : null}
          <ScrollView
            horizontal={!narrow}
            style={styles.board}
            contentContainerStyle={styles.boardContent}
          >
            {columns.map((status) => {
              const columnTasks = tasks.filter(
                (task) => task.status === status,
              );
              return (
                <View key={status} style={styles.column}>
                  <View style={styles.columnHeader}>
                    <View style={styles.row}>
                      <View
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 4,
                          backgroundColor: BOARD_STATUS_COLORS[status],
                        }}
                      />
                      <Text style={styles.columnTitle}>
                        {BOARD_STATUS_LABELS[status]}
                      </Text>
                    </View>
                    <Text style={styles.columnCount}>{columnTasks.length}</Text>
                  </View>
                  {loading ? (
                    <ActivityIndicator />
                  ) : columnTasks.length === 0 ? (
                    <Text style={styles.empty}>空</Text>
                  ) : (
                    <ScrollView
                      style={styles.columnScroll}
                      showsVerticalScrollIndicator={false}
                    >
                      <View style={{ gap: 8 }}>
                        {columnTasks.map((task) => (
                          <TaskCard
                            key={task.id}
                            task={task}
                            styles={styles}
                            onPress={() => setSelectedId(task.id)}
                          />
                        ))}
                      </View>
                    </ScrollView>
                  )}
                </View>
              );
            })}
          </ScrollView>
        </>
      )}
    </View>
  );
}
