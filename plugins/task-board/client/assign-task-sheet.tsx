import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { BoardTask } from "../shared/core/board/types";
import {
  assignRpc,
  candidatesRpc,
  scheduleRpc,
  type CandidatesResult,
  type PaseoAgentProfile,
} from "../shared/contracts";
import { AgentConfigFields } from "./agent-config-fields";
import {
  combineLocalDateTime,
  defaultScheduledAt,
  recurrenceToCron,
  splitLocalDateTime,
  type RecurrenceDraft,
} from "./recurrence-model";
import {
  RecurrenceTimingField,
  OneShotTimingField,
  defaultRecurrence,
  isScheduledInPast,
} from "./timing-fields";
import {
  Button,
  Field,
  FormInput,
  Hint,
  SectionLabel,
  SegmentedControl,
  SelectField,
  Sheet,
} from "./ui/components";
import type { Tokens } from "./ui/tokens";

type AssignMode = "agent" | "pipeline";
type AgentSource = "existing" | "create";
type Timing = "immediate" | "manual" | "scheduled" | "recurring";

function prefillMessage(task: BoardTask): string {
  const lines = [`# ${task.displayId} ${task.title}`];
  if (task.description?.trim()) lines.push("", task.description.trim());
  if (task.acceptanceCriteria && task.acceptanceCriteria.length > 0) {
    lines.push("", "验收标准：");
    for (const item of task.acceptanceCriteria) lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

export function AssignTaskSheet({
  visible,
  task,
  tokens,
  compact,
  hostLabel,
  intent = "assign",
  onClose,
  onAssigned,
}: {
  visible: boolean;
  task: BoardTask | null;
  tokens: Tokens;
  compact: boolean;
  hostLabel?: string;
  intent?: "assign" | "reassign";
  onClose: () => void;
  onAssigned: (task: BoardTask) => void;
}) {
  const candidates = useRpc(candidatesRpc);
  const assign = useRpc(assignRpc);
  const schedule = useRpc(scheduleRpc);
  const [mode, setMode] = useState<AssignMode>("agent");
  const [projectId, setProjectId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [agentSource, setAgentSource] = useState<AgentSource>("existing");
  const [agentId, setAgentId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [thinkingOptionId, setThinkingOptionId] = useState("");
  const [modeId, setModeId] = useState("");
  const [message, setMessage] = useState("");
  const [timing, setTiming] = useState<Timing>("immediate");
  const [scheduledAt, setScheduledAt] = useState(() =>
    defaultScheduledAt(new Date()),
  );
  const [recurrence, setRecurrence] =
    useState<RecurrenceDraft>(defaultRecurrence);
  const [data, setData] = useState<CandidatesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !task) return;
    setMode("agent");
    setTiming("immediate");
    setScheduledAt(defaultScheduledAt(new Date()));
    setRecurrence(defaultRecurrence());
    setError(null);
    setMessage(prefillMessage(task));
    setProvider(
      task.assignment?.agent.kind === "create"
        ? task.assignment.agent.provider
        : "",
    );
    setModel(
      task.assignment?.agent.kind === "create"
        ? (task.assignment.agent.model ?? "")
        : "",
    );
    setModeId(
      task.assignment?.agent.kind === "create"
        ? (task.assignment.agent.modeId ?? "")
        : "",
    );
    setThinkingOptionId(
      task.assignment?.agent.kind === "create"
        ? (task.assignment.agent.thinkingOptionId ?? "")
        : "",
    );
    setAgentSource(
      task.assignment?.agent.kind === "existing" ? "existing" : "existing",
    );
    setAgentId(
      task.assignment?.agent.kind === "existing"
        ? task.assignment.agent.agentId
        : "",
    );
    setProjectId(task.assignment?.projectId ?? "");
    setWorkspaceId(task.assignment?.workspaceId ?? "");
    setProfileId("");
    setLoading(true);
    void candidates({}).then((envelope) => {
      setLoading(false);
      if (!envelope.ok) {
        setError(`${envelope.error.code}: ${envelope.error.message}`);
        return;
      }
      setData(envelope.value);
    });
  }, [candidates, task, visible]);

  const projects = data?.projects ?? [];
  const project =
    projects.find((entry) => entry.projectId === projectId) ??
    projects[0] ??
    null;
  const workspaces = project?.workspaces ?? [];
  const workspace =
    workspaces.find((entry) => entry.workspaceId === workspaceId) ??
    workspaces[0] ??
    null;
  const agents = project?.agents ?? [];
  const profiles = data?.profiles ?? [];
  const selectedProfile =
    profiles.find((profile) => profile.id === profileId) ?? null;

  useEffect(() => {
    if (!visible) return;
    if (!projectId && project) setProjectId(project.projectId);
    if (!workspaceId && workspaces[0])
      setWorkspaceId(workspaces[0].workspaceId);
    if (!provider && data) {
      const first =
        data.providers.find((entry) => entry.available) ?? data.providers[0];
      if (first) setProvider(first.provider);
    }
  }, [agents, project, projectId, visible, workspaceId, workspaces]);

  useEffect(() => {
    if (!selectedProfile) return;
    setProvider(selectedProfile.provider);
    setModel(selectedProfile.model ?? "");
    setModeId(selectedProfile.modeId ?? "");
    setThinkingOptionId(selectedProfile.thinkingOptionId ?? "");
  }, [selectedProfile]);

  const profileOptions: Array<{
    value: string;
    label: string;
    description?: string;
  }> = useMemo(
    () => [
      {
        value: "",
        label: "自定义",
        description: "手动选择 Provider / 模型 / 思考深度 / 权限模式",
      },
      ...profiles.map((profile) => ({
        value: profile.id,
        label: profile.name,
        description: `${profile.provider}${
          profile.model ? ` · ${profile.model}` : ""
        }`,
      })),
    ],
    [profiles],
  );

  const projectOptions = projects.map((entry) => ({
    value: entry.projectId,
    label: entry.name,
    description: entry.rootPath,
  }));
  const workspaceOptions = workspaces.map((entry) => ({
    value: entry.workspaceId,
    label: entry.name,
    description:
      entry.kind === "worktree"
        ? "Worktree 工作区"
        : `${(project?.agents ?? []).length > 0 ? "" : "无 "}Agent`,
  }));
  const agentOptions = agents.map((entry) => ({
    value: entry.agentId,
    label: entry.title ?? entry.agentId.slice(0, 8),
    description: `${entry.provider} · ${entry.status}`,
  }));

  const submitLabel =
    intent === "reassign"
      ? "保存"
      : timing === "immediate"
        ? "开始执行"
        : timing === "manual"
          ? "确认分配"
          : timing === "scheduled"
            ? "定时执行"
            : "保存循环";
  const timingInvalid =
    timing === "scheduled" && isScheduledInPast(scheduledAt);

  const submit = async () => {
    if (!task) return;
    if (mode === "pipeline") {
      setError("本插件只支持独立 Agent 执行；流水线留给 I4。");
      return;
    }
    if (!project) {
      setError("请选择项目");
      return;
    }
    if (!workspace) {
      setError("请选择工作区");
      return;
    }
    if (agentSource === "existing" && !agentId) {
      setError("请选择一个已有 Agent");
      return;
    }
    if (agentSource === "create" && !selectedProfile && !provider.trim()) {
      setError("请填写 Provider");
      return;
    }
    if (timingInvalid) {
      setError("定时执行时间已过去，请选择未来的时间");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const assigned = await assign({
        taskId: task.id,
        expectedRevision: task.revision,
        projectId: project.projectId,
        workspaceId: workspace.workspaceId,
        agent:
          agentSource === "existing"
            ? { kind: "existing", agentId }
            : selectedProfile
              ? {
                  kind: "create",
                  provider: selectedProfile.provider,
                  model: selectedProfile.model,
                  modeId: selectedProfile.modeId,
                  thinkingOptionId: selectedProfile.thinkingOptionId,
                  options: selectedProfile.options,
                }
              : {
                  kind: "create",
                  provider: provider.trim(),
                  model: model.trim() || undefined,
                  modeId: modeId.trim() || undefined,
                  thinkingOptionId: thinkingOptionId.trim() || undefined,
                },
        message: message.trim() || undefined,
        start: timing === "immediate" && intent === "assign",
      });
      if (!assigned.ok)
        throw new Error(`${assigned.error.code}: ${assigned.error.message}`);
      let updated = assigned.value.task;
      if (timing === "scheduled" || timing === "recurring") {
        const [dateValue, timeValue] = splitLocalDateTime(scheduledAt);
        const runAt = combineLocalDateTime(dateValue, timeValue);
        if (timing === "scheduled" && !runAt) {
          throw new Error("请选择有效的日期和时间");
        }
        if (timing === "scheduled" && runAt && isScheduledInPast(scheduledAt)) {
          throw new Error("定时执行时间已过去，请选择未来的时间");
        }
        const scheduled = await schedule({
          taskId: task.id,
          expectedRevision: updated.revision,
          trigger:
            timing === "scheduled"
              ? { kind: "scheduled", runAt: runAt!.toISOString() }
              : {
                  kind: "recurring",
                  cadence: {
                    type: "cron",
                    expression: recurrenceToCron(recurrence),
                  },
                  session: "new",
                },
        });
        if (!scheduled.ok)
          throw new Error(
            `${scheduled.error.code}: ${scheduled.error.message}`,
          );
        updated = scheduled.value.task;
      }
      onAssigned(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet
      visible={visible}
      title={
        task
          ? `${intent === "reassign" ? "编辑执行配置" : "分配"} ${task.displayId}`
          : "分配任务"
      }
      onClose={onClose}
      tokens={tokens}
      compact={compact}
      width={600}
      testID="assign-task-sheet"
      footer={
        <>
          <Button
            variant="ghost"
            size={compact ? "md" : "sm"}
            onPress={onClose}
            disabled={submitting}
            tokens={tokens}
          >
            取消
          </Button>
          <Button
            variant="default"
            size={compact ? "md" : "sm"}
            onPress={() => void submit()}
            disabled={submitting || loading || timingInvalid}
            testID="assign-task-submit"
            tokens={tokens}
          >
            {submitting ? "处理中…" : submitLabel}
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
      <View style={{ gap: tokens.spacing[3] }}>
        <Field label="执行方式" tokens={tokens}>
          <SegmentedControl
            options={[
              {
                value: "agent",
                label: "独立 Agent",
                testID: "assign-mode-agent",
              },
              {
                value: "pipeline",
                label: "流水线",
                testID: "assign-mode-pipeline",
              },
            ]}
            value={mode}
            onValueChange={(value) => setMode(value as AssignMode)}
            tokens={tokens}
            size={compact ? "md" : "sm"}
          />
        </Field>

        <SectionLabel label="目标" tokens={tokens} />
        <SelectField
          label="项目"
          value={projectId || null}
          options={projectOptions}
          placeholder="选择项目"
          onChange={setProjectId}
          tokens={tokens}
          disabled={projectOptions.length === 0}
          hint={hostLabel}
          size={compact ? "md" : "sm"}
          testID="assign-project-trigger"
        />
        <SelectField
          label="工作区"
          value={workspaceId || null}
          options={workspaceOptions}
          placeholder="选择工作区"
          onChange={setWorkspaceId}
          tokens={tokens}
          disabled={workspaceOptions.length === 0}
          hint={`${agents.length} 个 Agent`}
          size={compact ? "md" : "sm"}
          testID="assign-workspace-trigger"
        />

        <SectionLabel label="执行配置" tokens={tokens} />
        {mode === "agent" ? (
          <>
            <Field label="Agent 来源" tokens={tokens}>
              <SegmentedControl
                options={[
                  { value: "existing", label: "选择已有" },
                  { value: "create", label: "新建 Agent" },
                ]}
                value={agentSource}
                onValueChange={(value) => setAgentSource(value as AgentSource)}
                tokens={tokens}
                size={compact ? "md" : "sm"}
              />
            </Field>
            {agentSource === "existing" ? (
              <SelectField
                label="Agent"
                value={agentId || null}
                options={agentOptions}
                placeholder="选择 Agent"
                onChange={setAgentId}
                tokens={tokens}
                disabled={agentOptions.length === 0}
                hint={
                  agentOptions.length === 0
                    ? "该工作区还没有 Agent，请改用「新建 Agent」"
                    : undefined
                }
                size={compact ? "md" : "sm"}
                testID="assign-agent-trigger"
              />
            ) : (
              <>
                <SelectField
                  label="使用 Profile"
                  value={profileId || null}
                  options={profileOptions}
                  placeholder="从已配置的 Profile 选择"
                  onChange={setProfileId}
                  tokens={tokens}
                  hint="Profile 在 Paseo 设置 → Agents 中管理"
                  size={compact ? "md" : "sm"}
                  testID="assign-profile-trigger"
                />
                {selectedProfile ? (
                  <ProfileSummary profile={selectedProfile} tokens={tokens} />
                ) : (
                  <AgentConfigFields
                    providers={data?.providers ?? []}
                    values={{ provider, model, thinkingOptionId, modeId }}
                    cwd={workspace?.directory ?? null}
                    tokens={tokens}
                    compact={compact}
                    onChange={(next) => {
                      setProvider(next.provider);
                      setModel(next.model);
                      setThinkingOptionId(next.thinkingOptionId);
                      setModeId(next.modeId);
                    }}
                  />
                )}
              </>
            )}
            <Field
              label="首条消息"
              hint="留空则自动使用任务标题、描述与验收标准"
              tokens={tokens}
            >
              <FormInput
                value={message}
                onChangeText={setMessage}
                placeholder="补充给 Agent 的说明"
                tokens={tokens}
                multiline
                minHeight={88}
                testID="assign-task-message"
              />
            </Field>
          </>
        ) : (
          <Hint tokens={tokens}>
            本插件只支持独立 Agent 执行。流水线执行、模板与工作流留给 I4。
          </Hint>
        )}

        <SectionLabel label="执行时机" tokens={tokens} />
        <Field label="何时开始" tokens={tokens}>
          <SegmentedControl
            options={[
              {
                value: "immediate",
                label: "立即执行",
                testID: "assign-timing-immediate",
              },
              {
                value: "manual",
                label: "仅分配",
                testID: "assign-timing-manual",
              },
              {
                value: "scheduled",
                label: "定时",
                testID: "assign-timing-scheduled",
              },
              {
                value: "recurring",
                label: "循环",
                testID: "assign-timing-recurring",
              },
            ]}
            value={timing}
            onValueChange={(value) => setTiming(value as Timing)}
            tokens={tokens}
            size={compact ? "xs" : "sm"}
            style={{ flexWrap: "wrap" }}
          />
        </Field>
        {timing === "manual" ? (
          <Hint tokens={tokens}>
            只记录执行目标，任务停在「待办」，不会创建对话。之后在卡片上点「执行」开始。
          </Hint>
        ) : null}
        {timing === "scheduled" ? (
          <OneShotTimingField
            scheduledAt={scheduledAt}
            onChange={setScheduledAt}
            tokens={tokens}
            compact={compact}
            disabled={submitting}
          />
        ) : null}
        {timing === "recurring" ? (
          <>
            <RecurrenceTimingField
              value={recurrence}
              onChange={setRecurrence}
              tokens={tokens}
              compact={compact}
              disabled={submitting}
            />
            <Hint tokens={tokens}>
              每轮都会创建一个独立任务，走完整的执行与验收流程。
            </Hint>
          </>
        ) : null}
      </View>
    </Sheet>
  );
}

function ProfileSummary({
  profile,
  tokens,
}: {
  profile: PaseoAgentProfile;
  tokens: Tokens;
}) {
  const rows: Array<[string, string]> = [
    ["Provider", profile.provider],
    ["模型", profile.model ?? "默认"],
    ["思考深度", profile.thinkingOptionId ?? "默认"],
    ["权限模式", profile.modeId ?? "默认"],
  ];
  return (
    <View
      style={{
        gap: tokens.spacing[1],
        padding: tokens.spacing[3],
        borderRadius: tokens.radius.lg,
        borderWidth: 1,
        borderColor: tokens.colors.border,
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
        {profile.name}
      </Text>
      {rows.map(([label, value]) => (
        <View
          key={label}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: tokens.spacing[2],
          }}
        >
          <Text
            style={{
              width: 72,
              color: tokens.colors.foregroundMuted,
              fontSize: tokens.fontSize.sm,
            }}
          >
            {label}
          </Text>
          <Text
            style={{
              flex: 1,
              color: tokens.colors.foreground,
              fontSize: tokens.fontSize.sm,
            }}
          >
            {value}
          </Text>
        </View>
      ))}
      {profile.notes ? <Hint tokens={tokens}>{profile.notes}</Hint> : null}
    </View>
  );
}
