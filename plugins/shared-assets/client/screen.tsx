import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import type {
  AssetDiffResult,
  AssetKind,
  AssetRelationshipRow,
  BatchPublishPreview,
  BatchPublishResult,
  Binding,
  DriftItem,
  IgnoreRulesResult,
  LocalAssetSummary,
  MergePreviewResult,
  MergeResolution,
  ProjectAttentionItem,
  ProjectSummary,
  ProviderStatus,
  RelationshipListResult,
  UnlinkResult,
} from "../shared/core/types";
import type { RpcEnvelope } from "../shared/core/errors";
import {
  batchPublishCommitRpc,
  batchPublishPreviewRpc,
  configureRpc,
  diffRpc,
  driftIgnoreRpc,
  driftListRpc,
  driftResolveRpc,
  driftUnignoreRpc,
  ignoreRulesGetRpc,
  ignoreRulesSetRpc,
  instructionsSetEnabledRpc,
  mergeApplyRpc,
  mergePreviewRpc,
  projectsListRpc,
  providersListRpc,
  relationshipsAdoptRpc,
  relationshipsBatchUnlinkRpc,
  relationshipsListRpc,
  relationshipsUnlinkRpc,
  skillsSetEnabledRpc,
  statusRpc,
  syncRpc,
  unbindRpc,
  workspacePullRpc,
} from "../shared/contracts";
import {
  Alert,
  Button,
  Checkbox,
  DialogHeader,
  DialogSummary,
  Empty,
  Field,
  IconButton,
  Muted,
  Mono,
  Overlay,
  Panel,
  SectionTitle,
  Spinner,
  TabButton,
  TabRail,
  TextField,
} from "./ui/components";
import { countDrift } from "./drift-counts";
import {
  batchAssociateRows,
  type BatchAssociateFailure,
} from "./batch-associate";
import { createTokens, type Tokens } from "./ui/tokens";

type Tab = "skills" | "prompt" | "knowledge" | "docs";

type PublishItem = {
  assetId: string;
  kind: AssetKind;
  provider?: string;
  create: boolean;
  localAssetId: string;
};

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "skills", label: "Skills" },
  { id: "prompt", label: "SYSTEM Prompt" },
  { id: "knowledge", label: "经验库" },
  { id: "docs", label: "项目文档" },
];

/** The legacy app's Provider order, narrowed to the providers this plugin manages. */
const PROVIDER_ORDER: readonly string[] = [
  "codebuddy-code",
  "claude",
  "codex",
  "pi",
  "opencode",
  "copilot",
  "omp",
  "dsh",
  "antigravity",
  "muse",
];

const KIND_LABELS: Record<AssetKind, string> = {
  skill: "Skill",
  prompt: "SYSTEM Prompt",
  knowledge: "经验库",
  doc: "项目文档",
};

const ATTENTION_LABELS: Record<ProjectAttentionItem["reason"], string> = {
  diverged: "双方均有修改",
  "local-update": "本地未发布",
  "remote-update": "远端有更新",
  "remote-deleted": "远端已删除",
  "unpublished-local": "未同步远端",
  synced: "已同步",
  missing: "本地缺失",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unwrap<T>(envelope: RpcEnvelope<T>): T {
  if (envelope.ok) return envelope.value;
  throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
}

function isRevisionConflict(error: unknown): boolean {
  return messageOf(error).includes("E_REVISION_CONFLICT");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function repositoryDisplayName(repoUrl: string | null): string {
  if (!repoUrl) return "共享仓库";
  const path = repoUrl.split(/[?#]/, 1)[0] ?? repoUrl;
  return (
    path
      .replace(/\/+$/, "")
      .split(/[/:]/)
      .pop()
      ?.replace(/\.git$/i, "") || repoUrl
  );
}

function syncSummary(project: ProjectSummary): string {
  if (!project.bound) return "未配置共享库";
  if (!project.workspaceId) {
    return "该项目还没有工作区，先创建一个工作区再配置共享资产";
  }
  const active = project.attention.items.filter((item) => !item.ignored);
  if (active.some((item) => item.reason === "diverged")) {
    return "存在冲突，需要处理";
  }
  if (active.some((item) => item.reason === "local-update")) {
    return "有未发布的本地修改";
  }
  if (active.some((item) => item.reason === "unpublished-local")) {
    return "有尚未同步到共享仓库的本地资产";
  }
  if (
    active.some((item) => item.reason === "remote-update") ||
    (project.state?.behind ?? 0) > 0
  ) {
    return "远端有更新";
  }
  if (project.state?.dirty) return "共享 checkout 有未提交修改";
  return "已同步";
}

function attentionKey(item: ProjectAttentionItem): string {
  return `${item.kind}:${item.provider ?? ""}:${item.name}`;
}

function assetIdForLocal(local: LocalAssetSummary): string {
  if (local.kind === "knowledge") return `knowledge/${local.name}.md`;
  if (local.kind === "doc") return `doc/${local.name}`;
  if (local.kind === "prompt") return "prompt";
  return `skill:project/${local.name}`;
}

function StatCard({
  label,
  value,
  tokens,
  compact,
}: {
  label: string;
  value: number;
  tokens: Tokens;
  compact: boolean;
}) {
  return (
    <View
      style={{
        minWidth: compact ? 0 : 110,
        flexBasis: compact ? 96 : undefined,
        flexGrow: compact ? 1 : 0,
        borderWidth: 1,
        borderColor: tokens.colors.border,
        backgroundColor: tokens.colors.surface1,
        borderRadius: tokens.radius.lg,
        paddingHorizontal: compact ? tokens.spacing[2] : tokens.spacing[3],
        paddingVertical: tokens.spacing[2],
        gap: tokens.spacing[1],
      }}
    >
      <Text
        style={{
          color: tokens.colors.foreground,
          fontSize: tokens.fontSize.xl,
          fontWeight: tokens.fontWeight.medium,
        }}
      >
        {value}
      </Text>
      <Text
        style={{
          color: tokens.colors.foregroundMuted,
          fontSize: tokens.fontSize.sm,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

export function SharedAssetsScreen({
  theme,
  layout,
  host,
  params,
}: PluginScreenProps) {
  const tokens = useMemo(() => createTokens(theme), [theme]);
  const compact = layout.compact;
  const projectsCall = useRpc(projectsListRpc);
  const driftIgnoreCall = useRpc(driftIgnoreRpc);
  const driftUnignoreCall = useRpc(driftUnignoreRpc);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(
    params.projectId ?? null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [ignoredOpen, setIgnoredOpen] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setRefreshKey((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void projectsCall({})
      .then(unwrap)
      .then((value) => {
        if (cancelled) return;
        setProjects(value as ProjectSummary[]);
        setError(null);
      })
      .catch((value) => {
        if (!cancelled) setError(messageOf(value));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectsCall, refreshKey]);

  const selected = projects.find((entry) => entry.projectId === selectedId);

  const setIgnored = async (
    project: ProjectSummary,
    item: ProjectAttentionItem,
    ignored: boolean,
  ) => {
    if (!project.workspaceId) return;
    setBusyKey(attentionKey(item));
    setError(null);
    try {
      if (ignored) {
        unwrap(
          await driftIgnoreCall({
            projectId: project.projectId,
            workspaceId: project.workspaceId,
            assetId:
              item.kind === "prompt"
                ? "prompt"
                : item.kind === "knowledge"
                  ? `knowledge/${item.name}.md`
                  : item.kind === "doc"
                    ? `doc/${item.name}`
                    : `skill:project/${item.name}`,
            path: null,
            provider: item.provider ?? undefined,
            reason: ATTENTION_LABELS[item.reason],
          }),
        );
      } else {
        unwrap(
          await driftUnignoreCall({
            projectId: project.projectId,
            workspaceId: project.workspaceId,
            assetId:
              item.kind === "prompt"
                ? "prompt"
                : item.kind === "knowledge"
                  ? `knowledge/${item.name}.md`
                  : item.kind === "doc"
                    ? `doc/${item.name}`
                    : `skill:project/${item.name}`,
            path: null,
            provider: item.provider ?? undefined,
          }),
        );
      }
      refresh();
    } catch (value) {
      setError(messageOf(value));
    } finally {
      setBusyKey(null);
    }
  };

  if (selected) {
    return (
      <ProjectDetail
        project={selected}
        tokens={tokens}
        compact={compact}
        onBack={() => {
          setSelectedId(null);
          refresh();
        }}
        onChanged={refresh}
      />
    );
  }

  const stats = {
    total: projects.length,
    configured: projects.filter((project) => project.bound).length,
    withUpdate: projects.filter(
      (project) =>
        project.attention.items.some(
          (item) => !item.ignored && item.reason === "remote-update",
        ) || (project.state?.behind ?? 0) > 0,
    ).length,
    withChanges: projects.filter((project) =>
      project.attention.items.some(
        (item) =>
          !item.ignored &&
          (item.reason === "local-update" ||
            item.reason === "unpublished-local"),
      ),
    ).length,
    withConflicts: projects.filter((project) =>
      project.attention.items.some(
        (item) => !item.ignored && item.reason === "diverged",
      ),
    ).length,
  };

  return (
    <View
      style={{ flex: 1, backgroundColor: tokens.colors.surfaceWorkspace }}
      testID="shared-assets-screen"
    >
      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ padding: 16, gap: 16 }}
      >
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
                fontWeight: tokens.fontWeight.medium,
              }}
            >
              按项目管理的团队资产
            </Text>
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
              }}
            >
              Skill、SYSTEM Prompt
              与经验库以项目为作用域；同一项目下的工作区共用一套共享库。
            </Text>
          </View>
          <IconButton
            icon="RefreshCw"
            label="刷新项目状态"
            onPress={() => {
              setLoading(true);
              refresh();
            }}
            disabled={loading}
            tokens={tokens}
            testID="shared-assets-refresh"
          />
        </View>

        {error ? (
          <Alert
            tone="danger"
            title="共享资产操作失败"
            description={error}
            tokens={tokens}
          />
        ) : null}

        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: compact ? tokens.spacing[2] : tokens.spacing[3],
          }}
        >
          <StatCard
            label="项目"
            value={stats.total}
            tokens={tokens}
            compact={compact}
          />
          <StatCard
            label="已连接共享库"
            value={stats.configured}
            tokens={tokens}
            compact={compact}
          />
          <StatCard
            label="远端有更新"
            value={stats.withUpdate}
            tokens={tokens}
            compact={compact}
          />
          <StatCard
            label="本地未发布"
            value={stats.withChanges}
            tokens={tokens}
            compact={compact}
          />
          <StatCard
            label="冲突"
            value={stats.withConflicts}
            tokens={tokens}
            compact={compact}
          />
        </View>

        {loading && projects.length === 0 ? <Spinner tokens={tokens} /> : null}
        {!loading && projects.length === 0 ? (
          <View style={{ paddingVertical: 48, gap: 8 }}>
            <Text
              style={{
                color: tokens.colors.foreground,
                fontSize: tokens.fontSize["2xl"],
                fontWeight: "600",
              }}
            >
              还没有项目
            </Text>
            <Muted tokens={tokens}>
              先在侧边栏添加一个项目，再为它连接团队共享 Git 仓库。
            </Muted>
          </View>
        ) : null}

        {projects.map((project) => {
          const attention = project.attention.items.filter(
            (item) => !item.ignored,
          );
          const ignored = project.attention.items.filter(
            (item) => item.ignored,
          );
          const ready = project.bound && project.workspaceId;
          return (
            <View
              key={project.projectId}
              style={{
                flexDirection: "row",
                alignItems: compact ? "flex-start" : "center",
                gap: compact ? tokens.spacing[2] : tokens.spacing[3],
                borderWidth: 1,
                borderColor: tokens.colors.border,
                backgroundColor: tokens.colors.surface1,
                borderRadius: tokens.radius.xl,
                padding: compact ? tokens.spacing[2] : tokens.spacing[3],
              }}
              testID={`shared-assets-project-${project.projectId}`}
            >
              <View
                style={{
                  width: compact ? 28 : 36,
                  height: compact ? 28 : 36,
                  borderRadius: tokens.radius.lg,
                  backgroundColor: tokens.colors.surface2,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon
                  name="LibraryBig"
                  size={compact ? 16 : 18}
                  color={tokens.colors.accent}
                />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: tokens.spacing[1] }}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <Text
                    style={{
                      color: tokens.colors.foreground,
                      fontSize: tokens.fontSize.base,
                      fontWeight: tokens.fontWeight.medium,
                    }}
                  >
                    {project.displayName}
                  </Text>
                  <Text
                    style={{
                      color: tokens.colors.foreground,
                      fontSize: tokens.fontSize.base,
                    }}
                  >
                    {host.label}
                  </Text>
                  {attention.length > 0 ? (
                    <View
                      style={{
                        minWidth: 20,
                        height: 20,
                        paddingHorizontal: 6,
                        borderRadius: 10,
                        backgroundColor: attention.some(
                          (item) => item.reason === "diverged",
                        )
                          ? tokens.colors.statusDotDanger
                          : tokens.colors.statusDotWarning,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                      accessibilityLabel={`${attention.length} 项需要处理`}
                      testID={`shared-assets-attention-${project.projectId}`}
                    >
                      <Text
                        style={{
                          color: tokens.colors.accentForeground,
                          fontSize: tokens.fontSize.sm,
                          fontWeight: tokens.fontWeight.medium,
                        }}
                      >
                        {attention.length}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text
                  style={{
                    color: tokens.colors.foregroundMuted,
                    fontSize: tokens.fontSize.sm,
                  }}
                >
                  {project.rootPath}
                </Text>
                <Text
                  style={{
                    color: tokens.colors.foregroundMuted,
                    fontSize: tokens.fontSize.sm,
                  }}
                >
                  {syncSummary(project)}
                  {project.repoUrl ? ` · ${project.repoUrl}` : ""}
                </Text>
                <View
                  style={{
                    flexDirection: "row",
                    gap: tokens.spacing[3],
                    flexWrap: "wrap",
                  }}
                >
                  {attention.length > 0 ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        setExpanded((value) => ({
                          ...value,
                          [project.projectId]: !value[project.projectId],
                        }))
                      }
                      testID={`shared-assets-attention-toggle-${project.projectId}`}
                    >
                      <Text
                        style={{
                          color: tokens.colors.accent,
                          fontSize: tokens.fontSize.sm,
                        }}
                      >
                        {expanded[project.projectId] ? "收起明细" : "查看明细"}
                      </Text>
                    </Pressable>
                  ) : null}
                  {ignored.length > 0 ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        setIgnoredOpen((value) => ({
                          ...value,
                          [project.projectId]: !value[project.projectId],
                        }))
                      }
                      testID={`shared-assets-ignored-toggle-${project.projectId}`}
                    >
                      <Text
                        style={{
                          color: tokens.colors.accent,
                          fontSize: tokens.fontSize.sm,
                        }}
                      >
                        {ignoredOpen[project.projectId]
                          ? "收起已忽略"
                          : `已忽略 ${ignored.length}`}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
                {expanded[project.projectId] ? (
                  <AttentionList
                    items={attention}
                    tokens={tokens}
                    compact={compact}
                    busyKey={busyKey}
                    onToggle={(item) => void setIgnored(project, item, true)}
                  />
                ) : null}
                {ignoredOpen[project.projectId] ? (
                  <AttentionList
                    items={ignored}
                    tokens={tokens}
                    compact={compact}
                    restore
                    busyKey={busyKey}
                    onToggle={(item) => void setIgnored(project, item, false)}
                  />
                ) : null}
                {!project.workspaceId ? (
                  <Text
                    style={{
                      color: tokens.colors.warning,
                      fontSize: tokens.fontSize.sm,
                    }}
                  >
                    该项目还没有工作区，先创建一个工作区再配置共享资产
                  </Text>
                ) : null}
              </View>
              <Button
                tokens={tokens}
                size={compact ? "md" : "sm"}
                variant={ready ? "ghost" : "default"}
                disabled={!project.workspaceId}
                onPress={() => setSelectedId(project.projectId)}
                accessibilityLabel={`${ready ? "管理" : "配置"} ${project.displayName} 的共享资产`}
              >
                {ready ? "管理" : "配置"}
              </Button>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function AttentionList({
  items,
  tokens,
  compact,
  restore,
  busyKey,
  onToggle,
}: {
  items: ProjectAttentionItem[];
  tokens: Tokens;
  compact: boolean;
  restore?: boolean;
  busyKey: string | null;
  onToggle: (item: ProjectAttentionItem) => void;
}) {
  return (
    <View style={{ gap: tokens.spacing[1], paddingTop: tokens.spacing[1] }}>
      {items.map((item) => {
        const key = attentionKey(item);
        const dotColor =
          item.reason === "diverged"
            ? tokens.colors.statusDotDanger
            : item.reason === "local-update"
              ? tokens.colors.statusDotWarning
              : item.reason === "unpublished-local"
                ? tokens.colors.foregroundExtraMuted
                : tokens.colors.statusDotSuccess;
        const action = (
          <Pressable
            accessibilityRole="button"
            disabled={busyKey === key}
            onPress={() => onToggle(item)}
            testID={`shared-assets-attention-ignore-${key}`}
            style={{ paddingVertical: 2, paddingHorizontal: 4 }}
          >
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
              }}
            >
              {restore ? "恢复" : "忽略"}
            </Text>
          </Pressable>
        );
        if (compact) {
          return (
            <View
              key={key}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: tokens.spacing[2],
                paddingVertical: 2,
              }}
            >
              <View
                style={{
                  width: 6,
                  height: 6,
                  marginTop: 6,
                  borderRadius: 3,
                  backgroundColor: dotColor,
                }}
              />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: tokens.spacing[2],
                  }}
                >
                  <Text
                    style={{
                      color: tokens.colors.foreground,
                      fontSize: tokens.fontSize.sm,
                      flexShrink: 1,
                    }}
                    numberOfLines={1}
                    ellipsizeMode="middle"
                  >
                    {item.name}
                  </Text>
                  <Text
                    style={{
                      color: tokens.colors.foregroundMuted,
                      fontSize: tokens.fontSize.sm,
                    }}
                    numberOfLines={1}
                    ellipsizeMode="middle"
                  >
                    {ATTENTION_LABELS[item.reason]}
                  </Text>
                </View>
                <Text
                  style={{
                    color: tokens.colors.foregroundMuted,
                    fontSize: tokens.fontSize.sm,
                  }}
                  numberOfLines={1}
                >
                  {KIND_LABELS[item.kind]}
                  {item.provider ? ` · ${item.provider}` : ""}
                </Text>
              </View>
              {action}
            </View>
          );
        }
        return (
          <View
            key={key}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: tokens.spacing[2],
            }}
          >
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: dotColor,
              }}
            />
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
                width: 88,
              }}
              numberOfLines={1}
            >
              {KIND_LABELS[item.kind]}
            </Text>
            {item.provider ? (
              <Text
                style={{
                  color: tokens.colors.foregroundExtraMuted,
                  fontSize: tokens.fontSize.sm,
                  width: 104,
                }}
                numberOfLines={1}
              >
                {item.provider}
              </Text>
            ) : null}
            <Text
              style={{
                color: tokens.colors.foreground,
                fontSize: tokens.fontSize.sm,
                flexShrink: 1,
              }}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {item.name}
            </Text>
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
                marginLeft: "auto",
              }}
            >
              {ATTENTION_LABELS[item.reason]}
            </Text>
            {action}
          </View>
        );
      })}
    </View>
  );
}

function ProjectDetail({
  project,
  tokens,
  compact,
  onBack,
  onChanged,
}: {
  project: ProjectSummary;
  tokens: Tokens;
  compact: boolean;
  onBack: () => void;
  onChanged: () => void;
}) {
  const statusCall = useRpc(statusRpc);
  const syncCall = useRpc(syncRpc);
  const unbindCall = useRpc(unbindRpc);
  const configureCall = useRpc(configureRpc);
  const driftCall = useRpc(driftListRpc);
  const driftIgnoreCall = useRpc(driftIgnoreRpc);
  const driftUnignoreCall = useRpc(driftUnignoreRpc);
  const driftResolveCall = useRpc(driftResolveRpc);
  const providersCall = useRpc(providersListRpc);
  const relationshipsCall = useRpc(relationshipsListRpc);
  const relationshipsAdoptCall = useRpc(relationshipsAdoptRpc);
  const relationshipsUnlinkCall = useRpc(relationshipsUnlinkRpc);
  const relationshipsBatchUnlinkCall = useRpc(relationshipsBatchUnlinkRpc);
  const skillsSetEnabledCall = useRpc(skillsSetEnabledRpc);
  const instructionsSetCall = useRpc(instructionsSetEnabledRpc);
  const diffCall = useRpc(diffRpc);
  const mergePreviewCall = useRpc(mergePreviewRpc);
  const mergeApplyCall = useRpc(mergeApplyRpc);
  const batchPreviewCall = useRpc(batchPublishPreviewRpc);
  const batchCommitCall = useRpc(batchPublishCommitRpc);
  const workspacePullCall = useRpc(workspacePullRpc);
  const [status, setStatus] = useState<Binding | null>(null);
  const [drift, setDrift] = useState<DriftItem[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [tab, setTab] = useState<Tab>("skills");
  const [provider, setProvider] = useState("codex");
  const [relationships, setRelationships] =
    useState<RelationshipListResult | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState(!project.bound);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [forceUnbind, setForceUnbind] = useState<string | null>(null);
  const [selectedLocalIds, setSelectedLocalIds] = useState<Set<string>>(
    new Set(),
  );
  const [batchMode, setBatchMode] = useState(false);
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set());
  const [showIgnored, setShowIgnored] = useState(false);
  const [ignoreDialog, setIgnoreDialog] = useState(false);
  const [association, setAssociation] = useState<AssetRelationshipRow | null>(
    null,
  );
  const [unlink, setUnlink] = useState<AssetRelationshipRow | null>(null);
  const [batchUnlink, setBatchUnlink] = useState<AssetRelationshipRow[] | null>(
    null,
  );
  const [preview, setPreview] = useState<BatchPublishPreview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [diffDialog, setDiffDialog] = useState<{
    title: string;
    result: AssetDiffResult | null;
  } | null>(null);
  const [mergeDialog, setMergeDialog] = useState<{
    assetId: string;
    path?: string;
    provider?: string;
    preview: MergePreviewResult | null;
  } | null>(null);
  const [batchOutcome, setBatchOutcome] = useState<{
    title: string;
    succeeded: number;
    failed: number;
    failures?: BatchAssociateFailure[];
  } | null>(null);

  const workspaceId = project.workspaceId;
  const { height: windowHeight } = useWindowDimensions();
  const isShort = windowHeight > 0 && windowHeight < 640;
  const reload = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    void providersCall({})
      .then(unwrap)
      .then((value) => {
        if (cancelled) return;
        const list = value as ProviderStatus[];
        setProviders(list);
        if (!list.some((entry) => entry.id === provider)) {
          setProvider(list.find((entry) => entry.skillRoot)?.id ?? "codex");
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [provider, providersCall]);

  useEffect(() => {
    if (!project.bound) {
      setStatus(null);
      setDrift([]);
      return;
    }
    let cancelled = false;
    void Promise.all([
      statusCall({ projectId: project.projectId }).then(unwrap),
      workspaceId
        ? driftCall({
            projectId: project.projectId,
            workspaceId,
            includeIgnored: true,
          }).then(unwrap)
        : Promise.resolve([]),
    ])
      .then(([nextStatus, nextDrift]) => {
        if (cancelled) return;
        const value = nextStatus as { binding: Binding };
        setStatus(value.binding);
        setDrift(nextDrift as DriftItem[]);
        setError(null);
      })
      .catch((value) => {
        if (!cancelled) setError(messageOf(value));
      });
    return () => {
      cancelled = true;
    };
  }, [
    driftCall,
    project.bound,
    project.projectId,
    refreshKey,
    statusCall,
    workspaceId,
  ]);

  const kind: AssetKind | null =
    tab === "skills"
      ? "skill"
      : tab === "prompt"
        ? "prompt"
        : tab === "knowledge"
          ? "knowledge"
          : tab === "docs"
            ? "doc"
            : null;

  useEffect(() => {
    if (!workspaceId || !kind || !project.bound) {
      setRelationships(null);
      return;
    }
    let cancelled = false;
    const providerForKind =
      kind === "skill" || kind === "prompt" ? provider : null;
    void relationshipsCall({
      projectId: project.projectId,
      workspaceId,
      kind,
      provider: providerForKind,
    })
      .then(unwrap)
      .then((value) => {
        if (!cancelled) setRelationships(value as RelationshipListResult);
      })
      .catch((value) => {
        if (!cancelled) setError(messageOf(value));
      });
    return () => {
      cancelled = true;
    };
  }, [
    kind,
    project.bound,
    project.projectId,
    provider,
    refreshKey,
    relationshipsCall,
    workspaceId,
  ]);

  useEffect(() => {
    setSelectedLocalIds(new Set());
    setBatchMode(false);
    setBatchSelected(new Set());
    setShowIgnored(false);
  }, [project.projectId, provider, tab]);

  const run = useCallback(
    async (label: string, work: () => Promise<void>, keepNotice = false) => {
      setBusy(label);
      setError(null);
      if (!keepNotice) setNotice(null);
      try {
        await work();
        reload();
        onChanged();
      } catch (value) {
        setError(messageOf(value));
      } finally {
        setBusy(null);
      }
    },
    [onChanged, reload],
  );

  const ignoreItem = async (item: DriftItem, ignored: boolean) => {
    if (!workspaceId) return;
    setBusy(`ignore:${item.assetId}`);
    setError(null);
    try {
      if (ignored) {
        unwrap(
          await driftIgnoreCall({
            projectId: project.projectId,
            workspaceId,
            assetId: item.assetId,
            path: null,
            provider: item.provider ?? undefined,
            reason: ATTENTION_LABELS[item.status],
          }),
        );
      } else {
        unwrap(
          await driftUnignoreCall({
            projectId: project.projectId,
            workspaceId,
            assetId: item.assetId,
            path: null,
            provider: item.provider ?? undefined,
          }),
        );
      }
      reload();
      onChanged();
    } catch (value) {
      setError(messageOf(value));
    } finally {
      setBusy(null);
    }
  };

  const openDiff = async (row: AssetRelationshipRow) => {
    if (!workspaceId || !row.shared) return;
    const providerValue =
      row.shared.kind === "skill" || row.shared.kind === "prompt"
        ? (row.local?.provider ?? provider)
        : undefined;
    setDiffDialog({
      title: `${row.shared.name} · 共享与本地差异`,
      result: null,
    });
    try {
      const result = unwrap(
        await diffCall({
          projectId: project.projectId,
          workspaceId,
          assetId: row.shared.assetId,
          path: undefined,
          provider: providerValue,
        }),
      ) as AssetDiffResult;
      setDiffDialog({ title: `${row.shared.name} · 共享与本地差异`, result });
    } catch (value) {
      setDiffDialog(null);
      setError(messageOf(value));
    }
  };

  const openMerge = async (row: AssetRelationshipRow) => {
    if (!workspaceId || !row.shared) return;
    const providerValue =
      row.shared.kind === "skill" || row.shared.kind === "prompt"
        ? (row.local?.provider ?? provider)
        : undefined;
    const driftItem = drift.find(
      (item) =>
        item.assetId === row.shared!.assetId &&
        (item.provider ?? undefined) === providerValue,
    );
    const path =
      driftItem?.files.find((file) => file.status !== "synced")?.path ??
      driftItem?.files[0]?.path;
    setMergeDialog({
      assetId: row.shared.assetId,
      provider: providerValue,
      preview: null,
    });
    try {
      const result = unwrap(
        await mergePreviewCall({
          projectId: project.projectId,
          workspaceId,
          assetId: row.shared.assetId,
          path,
          provider: providerValue,
        }),
      ) as MergePreviewResult;
      setMergeDialog({
        assetId: row.shared.assetId,
        path,
        provider: providerValue,
        preview: result,
      });
    } catch (value) {
      setMergeDialog(null);
      setError(messageOf(value));
    }
  };

  const setEnabled = async (row: AssetRelationshipRow, enabled: boolean) => {
    if (!workspaceId) return;
    if (row.shared?.kind === "skill") {
      const result = unwrap(
        await skillsSetEnabledCall({
          projectId: project.projectId,
          workspaceId,
          assetId: row.shared.assetId,
          provider: row.local?.provider ?? provider,
          enabled,
        }),
      ) as {
        errors: Array<{ provider: string; message: string }>;
        kept: Array<{ targetPath: string; reason: string }>;
        projections?: Array<{ mode: "symlink" | "copy" }>;
      };
      if (result.errors.length > 0) {
        setError(result.errors.map((entry) => entry.message).join("；"));
      }
      setNotice(
        result.kept.length > 0
          ? `已保留本地内容：${result.kept.map((entry) => entry.targetPath).join("，")}`
          : enabled
            ? result.projections?.some((entry) => entry.mode === "copy")
              ? "已复制（当前平台不支持软链）"
              : "已创建软链"
            : "已移除该 Provider 的软链",
      );
    } else if (row.shared?.kind === "prompt") {
      const result = unwrap(
        await instructionsSetCall({
          projectId: project.projectId,
          workspaceId,
          provider: row.local?.provider ?? provider,
          enabled,
        }),
      ) as { kept: Array<{ targetPath: string; reason: string }> };
      setNotice(
        result.kept.length > 0
          ? `已保留：${result.kept.map((entry) => entry.targetPath).join("，")}`
          : enabled
            ? "已投影到本地"
            : "已移除投影",
      );
    } else {
      unwrap(
        await workspacePullCall({ projectId: project.projectId, workspaceId }),
      );
      setNotice("已把共享资产添加到本地");
    }
  };

  const adopt = async (
    row: AssetRelationshipRow,
    mode: "preserve-local" | "use-remote",
  ) => {
    if (!workspaceId || !row.shared || !row.local) return;
    await run("adopt", async () => {
      const adopted = unwrap(
        await relationshipsAdoptCall({
          projectId: project.projectId,
          workspaceId,
          kind: row.shared!.kind,
          provider: row.local!.provider,
          assetId: row.shared!.assetId,
          localAssetId: row.local!.assetId,
          mode,
        }),
      ) as { projections?: Array<{ mode: "symlink" | "copy" }> };
      setAssociation(null);
      setNotice(
        adopted.projections?.some((entry) => entry.mode === "copy")
          ? `${row.shared!.name} 已复制（当前平台不支持软链）`
          : mode === "preserve-local"
            ? `${row.shared!.name} 已关联，保留本地版本`
            : `${row.shared!.name} 已关联并使用共享版本`,
      );
    });
  };

  const associateRows = async (rows: AssetRelationshipRow[], title: string) => {
    if (!workspaceId) return;
    const outcome = await batchAssociateRows(rows, async (row) => {
      if (!row.shared || !row.local) {
        throw new Error("资产缺少共享或本地来源");
      }
      unwrap(
        await relationshipsAdoptCall({
          projectId: project.projectId,
          workspaceId,
          kind: row.shared.kind,
          provider: row.local.provider,
          assetId: row.shared.assetId,
          localAssetId: row.local.assetId,
          mode: "preserve-local",
        }),
      );
    });
    setBatchOutcome({
      title,
      succeeded: outcome.succeeded,
      failed: outcome.failed.length,
      failures: outcome.failed,
    });
  };

  const confirmUnlink = async (
    row: AssetRelationshipRow,
    deleteLocal: boolean,
  ) => {
    if (!workspaceId || !row.shared) return;
    setBusy("unlink");
    setError(null);
    try {
      const result = unwrap(
        await relationshipsUnlinkCall({
          projectId: project.projectId,
          workspaceId,
          kind: row.shared.kind,
          provider: row.local?.provider ?? null,
          assetId: row.shared.assetId,
          deleteLocal,
        }),
      ) as UnlinkResult;
      setUnlink(null);
      setNotice(
        deleteLocal
          ? `${row.shared.name} 已解除关联并删除本地资产`
          : `${row.shared.name} 已解除关联，本地资产已保留${
              result.hadLocalChanges ? "（包含未发布的本地修改）" : ""
            }`,
      );
      reload();
      onChanged();
    } catch (value) {
      setError(messageOf(value));
    } finally {
      setBusy(null);
    }
  };

  const confirmBatchUnlink = async (
    rows: AssetRelationshipRow[],
    deleteLocal: boolean,
  ) => {
    if (!workspaceId) return;
    setBusy("batch-unlink");
    setError(null);
    try {
      const assetIds = rows
        .map((row) => row.shared?.assetId)
        .filter((value): value is string => Boolean(value));
      const result = unwrap(
        await relationshipsBatchUnlinkCall({
          projectId: project.projectId,
          workspaceId,
          kind: rows[0]?.shared?.kind ?? "skill",
          provider: rows[0]?.local?.provider ?? null,
          assetIds,
          deleteLocal,
        }),
      ) as {
        items: UnlinkResult[];
        failed: Array<{ assetId: string; message: string }>;
      };
      setBatchUnlink(null);
      setBatchOutcome({
        title: "批量移除关联",
        succeeded: result.items.length,
        failed: result.failed.length,
      });
      reload();
      onChanged();
    } catch (value) {
      setError(messageOf(value));
    } finally {
      setBusy(null);
    }
  };

  const publishableRows = (relationships?.rows ?? []).filter(
    (row) => row.local !== null,
  );
  const publishItems: PublishItem[] = publishableRows
    .filter(
      (row) => row.local !== null && selectedLocalIds.has(row.local.assetId),
    )
    .map((row) => ({
      assetId: row.shared?.assetId ?? assetIdForLocal(row.local!),
      kind: row.local!.kind,
      provider: row.local!.provider ?? undefined,
      create: row.shared === null,
      localAssetId: row.local!.assetId,
    }));
  const selectedCount = publishItems.length;

  const toggleSelected = (row: AssetRelationshipRow) => {
    if (!row.local) return;
    const localId = row.local.assetId;
    setSelectedLocalIds((current) => {
      const next = new Set(current);
      if (next.has(localId)) next.delete(localId);
      else next.add(localId);
      return next;
    });
  };

  const selectAllPublishable = () => {
    setSelectedLocalIds(
      new Set(
        publishableRows
          .filter((row) => row.local !== null)
          .map((row) => row.local!.assetId),
      ),
    );
  };

  const selectForPublish = (row: AssetRelationshipRow) => {
    if (!row.local) return;
    setSelectedLocalIds((current) => {
      const next = new Set(current);
      next.add(row.local!.assetId);
      return next;
    });
  };

  const previewPublish = async (items: PublishItem[] = publishItems) => {
    if (!workspaceId || items.length === 0) return;
    setBusy("preview");
    setError(null);
    try {
      const result = unwrap(
        await batchPreviewCall({
          projectId: project.projectId,
          workspaceId,
          items: items.map((entry) => ({
            assetId: entry.assetId,
            provider: entry.provider,
            create: entry.create,
            kind: entry.kind,
          })),
        }),
      ) as BatchPublishPreview;
      setPreview(result);
      setPreviewOpen(true);
    } catch (value) {
      setError(messageOf(value));
    } finally {
      setBusy(null);
    }
  };

  const commitPublish = async () => {
    if (!workspaceId || !preview) return;
    setBusy("publish");
    setError(null);
    try {
      const result = unwrap(
        await batchCommitCall({
          projectId: project.projectId,
          workspaceId,
          items: publishItems.map((entry) => ({
            assetId: entry.assetId,
            provider: entry.provider,
            create: entry.create,
            kind: entry.kind,
          })),
          expectedRevision: preview.expectedRevision,
        }),
      ) as BatchPublishResult;
      setPreview(null);
      setPreviewOpen(false);
      setNotice(
        result.commit
          ? `已发布 ${result.published.length} 项 · ${result.commit.slice(0, 8)}`
          : "没有写入提交",
      );
      setSelectedLocalIds(new Set());
      reload();
      onChanged();
    } catch (value) {
      if (isRevisionConflict(value)) {
        try {
          unwrap(await syncCall({ projectId: project.projectId }));
          const refreshed = unwrap(
            await batchPreviewCall({
              projectId: project.projectId,
              workspaceId,
              items: publishItems.map((entry) => ({
                assetId: entry.assetId,
                provider: entry.provider,
                create: entry.create,
                kind: entry.kind,
              })),
            }),
          ) as BatchPublishPreview;
          setPreview(refreshed);
          setPreviewOpen(true);
          setNotice(
            "共享仓库已有新提交，发布预览已按最新版本重新生成，请检查后再次确认发布",
          );
          setError(null);
        } catch (refreshError) {
          setPreview(null);
          setPreviewOpen(false);
          setError(messageOf(refreshError));
        }
      } else {
        setError(messageOf(value));
      }
    } finally {
      setBusy(null);
    }
  };

  const providerRank = (entry: ProviderStatus) => {
    const index = PROVIDER_ORDER.indexOf(entry.id);
    return index === -1 ? PROVIDER_ORDER.length : index;
  };
  const skillProviders = providers
    .filter((entry) => entry.installed && entry.skillRoot)
    .sort((a, b) => providerRank(a) - providerRank(b));
  const promptProviders = providers
    .filter((entry) => entry.installed && entry.instructionEntrypoint)
    .sort((a, b) => providerRank(a) - providerRank(b));
  const activeProviders =
    kind === "prompt"
      ? promptProviders
      : kind === "skill"
        ? skillProviders
        : [];
  const { byKind: driftByKind, byProvider: driftByProvider } = countDrift(
    drift,
    kind,
  );
  const allRows = relationships?.rows ?? [];
  const batchRows = allRows.filter((row) => batchSelected.has(row.id));
  const batchAddable = batchRows.filter(
    (row) => row.relationship === "shared-only",
  );
  const batchCandidates = batchRows.filter(
    (row) => row.relationship === "candidate",
  );
  const batchSyncable = batchRows.filter(
    (row) =>
      row.relationship === "linked" && row.syncStatus === "remote-update",
  );
  const batchUnlinkable = batchRows.filter(
    (row) => row.relationship === "linked",
  );
  const batchPublishRows = batchRows.filter((row) => row.local !== null);
  const batchSelectableCount = allRows.filter(
    (row) =>
      row.relationship === "candidate" ||
      row.relationship === "shared-only" ||
      row.relationship === "linked",
  ).length;
  const ignoredForView = drift.filter(
    (item) =>
      item.ignored &&
      item.kind === kind &&
      (item.provider === null || item.provider === provider),
  );

  const batchPublishItems = batchPublishRows.map((row) => ({
    assetId: row.shared?.assetId ?? assetIdForLocal(row.local!),
    kind: row.local!.kind,
    provider: row.local!.provider ?? undefined,
    create: row.shared === null,
    localAssetId: row.local!.assetId,
  }));

  const syncAllRemote = () =>
    run("sync-all", async () => {
      const rows = (relationships?.rows ?? []).filter(
        (row) =>
          row.relationship === "linked" && row.syncStatus === "remote-update",
      );
      for (const row of rows) {
        await setEnabled(row, true);
      }
      setNotice(
        rows.length > 0
          ? `已同步 ${rows.length} 项到本地`
          : "没有可同步的共享更新",
      );
    });

  return (
    <View
      style={{ flex: 1, backgroundColor: tokens.colors.surfaceWorkspace }}
      testID="shared-assets-detail"
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: compact ? "nowrap" : "wrap",
          gap: tokens.spacing[2],
          paddingHorizontal: compact ? tokens.spacing[2] : tokens.spacing[4],
          paddingVertical: compact ? tokens.spacing[1] : tokens.spacing[2],
          borderBottomWidth: 1,
          borderBottomColor: tokens.colors.border,
        }}
      >
        <Button
          tokens={tokens}
          size="sm"
          variant="ghost"
          onPress={onBack}
          testID="shared-assets-back"
        >
          ← 返回项目列表
        </Button>
        <Text
          style={{
            color: tokens.colors.foregroundMuted,
            fontSize: tokens.fontSize.sm,
            flexShrink: 1,
            minWidth: 0,
          }}
          numberOfLines={compact ? 1 : undefined}
          ellipsizeMode="middle"
        >
          {project.rootPath}
          {project.workspaceName
            ? ` · 作用域工作区：${project.workspaceName}`
            : " · 该项目暂无工作区"}
        </Text>
        {workspaceId ? (
          <Button
            tokens={tokens}
            size="xs"
            variant="ghost"
            onPress={() => setIgnoreDialog(true)}
            testID="shared-assets-ignore-rules-open"
          >
            忽略规则
          </Button>
        ) : null}
      </View>

      <View style={{ flex: 1, minHeight: 0 }}>
        {error ? (
          <Alert
            tone="danger"
            title="共享资产操作失败"
            description={error}
            tokens={tokens}
          />
        ) : null}
        {notice ? (
          <Alert tone="success" title={notice} tokens={tokens} />
        ) : null}
        {relationships?.warnings.some((warning) =>
          warning.includes("旧版 Skill 投影"),
        ) ? (
          <Alert
            tone="warning"
            title="检测到旧版 Skill 投影"
            description="检测到旧版 Skill 投影，需要运行迁移脚本。当前只读兼容，不会自动改写文件。"
            tokens={tokens}
          />
        ) : null}

        {compact ? null : (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: tokens.spacing[3],
              borderBottomWidth: 1,
              borderBottomColor: tokens.colors.border,
              backgroundColor: tokens.colors.surface1,
              paddingHorizontal: tokens.spacing[4],
              paddingVertical: tokens.spacing[3],
            }}
          >
            <View
              style={{
                flex: 1,
                minWidth: 0,
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
              }}
            >
              <View
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: tokens.radius.lg,
                  backgroundColor: tokens.colors.surface3,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon
                  name="LibraryBig"
                  size={20}
                  color={tokens.colors.accent}
                />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text
                  style={{
                    color: tokens.colors.foreground,
                    fontSize: tokens.fontSize.base,
                    fontWeight: tokens.fontWeight.medium,
                  }}
                >
                  共享资产库
                </Text>
                {isShort ? null : (
                  <Text
                    style={{
                      color: tokens.colors.foregroundMuted,
                      fontSize: tokens.fontSize.sm,
                    }}
                  >
                    使用团队共享 Skill、Provider SYSTEM Prompt
                    与经验库，也可选择本地资产发布给团队
                  </Text>
                )}
              </View>
            </View>
          </View>
        )}

        {configuring || !project.bound ? (
          <ScrollView
            style={{ flex: 1, minHeight: 0 }}
            contentContainerStyle={{
              padding: compact ? tokens.spacing[3] : 32,
              alignItems: "center",
              justifyContent: compact ? "flex-start" : "center",
            }}
          >
            <ConfigureForm
              tokens={tokens}
              project={project}
              initialRepoUrl={project.repoUrl ?? ""}
              initialBranch={project.branch ?? "main"}
              busy={busy === "configure"}
              onCancel={project.bound ? () => setConfiguring(false) : undefined}
              onSubmit={(repoUrl, branch, syncMode) =>
                run("configure", async () => {
                  unwrap(
                    await configureCall({
                      projectId: project.projectId,
                      repoUrl,
                      branch: branch.trim() ? branch.trim() : null,
                      syncMode,
                      trustConfirmed: true,
                    }),
                  );
                  setConfiguring(false);
                  setNotice(
                    project.bound ? "共享仓库已切换" : "团队共享库已连接",
                  );
                })
              }
            />
          </ScrollView>
        ) : null}

        {configuring || !project.bound || previewOpen ? null : (
          <RepoOverview
            tokens={tokens}
            compact={compact}
            project={project}
            binding={status}
            busy={busy}
            onSync={() =>
              run("sync", async () => {
                const result = unwrap(
                  await syncCall({ projectId: project.projectId }),
                ) as { changed: boolean };
                setNotice(
                  result.changed
                    ? "已同步到远端最新提交"
                    : "已是最新，无需更新",
                );
              })
            }
            onRebind={() => setConfiguring(true)}
            onRequestUnbind={() => setConfirmUnbind(true)}
          />
        )}

        {configuring || !project.bound ? null : previewOpen && preview ? (
          <PublishPreviewDialog
            preview={preview}
            tokens={tokens}
            busy={busy === "publish"}
            onClose={() => setPreviewOpen(false)}
            onCommit={() => void commitPublish()}
          />
        ) : (
          <View style={{ flex: 1, minHeight: 0 }}>
            {!workspaceId ? (
              <Alert
                tone="warning"
                title="该项目还没有 Workspace"
                description="绑定可用，但投影、同步与发布需要至少一个 Workspace。请先在侧边栏创建一个工作区。"
                tokens={tokens}
              />
            ) : null}
            <TabRail tokens={tokens}>
              {TABS.map((entry) => {
                const countKey: AssetKind | null =
                  entry.id === "skills"
                    ? "skill"
                    : entry.id === "prompt"
                      ? "prompt"
                      : entry.id === "knowledge"
                        ? "knowledge"
                        : entry.id === "docs"
                          ? "doc"
                          : null;
                return (
                  <TabButton
                    key={entry.id}
                    active={tab === entry.id}
                    label={entry.label}
                    count={countKey ? (driftByKind.get(countKey) ?? 0) : 0}
                    onPress={() => setTab(entry.id)}
                    tokens={tokens}
                    testID={`shared-assets-tab-${entry.id}`}
                  />
                );
              })}
            </TabRail>

            {ignoredForView.length > 0 ? (
              <View>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setShowIgnored((value) => !value)}
                  style={{
                    alignSelf: "flex-start",
                    paddingVertical: tokens.spacing[1],
                  }}
                  testID="shared-assets-ignored-view-toggle"
                >
                  <Text
                    style={{
                      color: tokens.colors.foregroundMuted,
                      fontSize: tokens.fontSize.sm,
                    }}
                  >
                    {showIgnored
                      ? "收起已忽略的提醒"
                      : `已忽略 ${ignoredForView.length} 项提醒`}
                  </Text>
                </Pressable>
                {showIgnored ? (
                  <View
                    style={{
                      gap: tokens.spacing[1],
                      paddingVertical: tokens.spacing[1],
                      paddingHorizontal: tokens.spacing[3],
                    }}
                  >
                    {ignoredForView.map((item) => (
                      <View
                        key={`${item.assetId}/${item.provider ?? ""}`}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: tokens.spacing[2],
                        }}
                      >
                        <Text
                          style={{
                            color: tokens.colors.foreground,
                            fontSize: tokens.fontSize.sm,
                            flexShrink: 1,
                          }}
                          numberOfLines={1}
                          ellipsizeMode="middle"
                        >
                          {item.name}
                        </Text>
                        <Text
                          style={{
                            color: tokens.colors.foregroundMuted,
                            fontSize: tokens.fontSize.sm,
                          }}
                          numberOfLines={1}
                        >
                          {KIND_LABELS[item.kind]}
                          {item.provider ? ` · ${item.provider}` : ""}
                        </Text>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => void ignoreItem(item, false)}
                          style={{ paddingVertical: 2 }}
                        >
                          <Text
                            style={{
                              color: tokens.colors.accent,
                              fontSize: tokens.fontSize.sm,
                            }}
                          >
                            恢复提醒
                          </Text>
                        </Pressable>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}

            {kind && activeProviders.length > 0 ? (
              <TabRail tokens={tokens}>
                {activeProviders.map((entry) => (
                  <TabButton
                    key={entry.id}
                    active={provider === entry.id}
                    label={entry.label}
                    count={driftByProvider.get(entry.id) ?? 0}
                    onPress={() => setProvider(entry.id)}
                    tokens={tokens}
                    testID={`shared-assets-provider-${entry.id}`}
                  />
                ))}
              </TabRail>
            ) : null}

            <View
              style={
                compact || isShort
                  ? {
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: tokens.spacing[2],
                      borderBottomWidth: 1,
                      borderBottomColor: tokens.colors.border,
                      backgroundColor: tokens.colors.surface2,
                      paddingHorizontal: tokens.spacing[3],
                      paddingVertical: tokens.spacing[2],
                    }
                  : {
                      flexDirection: "row",
                      alignItems: "center",
                      gap: tokens.spacing[3],
                      minWidth: 1000,
                      borderBottomWidth: 1,
                      borderBottomColor: tokens.colors.border,
                      backgroundColor: tokens.colors.surface2,
                      paddingHorizontal: tokens.spacing[4],
                      paddingVertical: tokens.spacing[3],
                      paddingLeft: batchMode
                        ? tokens.spacing[4] + 28
                        : tokens.spacing[4],
                    }
              }
            >
              {compact || isShort ? (
                <>
                  <Text
                    style={{
                      color: tokens.colors.foreground,
                      fontSize: tokens.fontSize.lg,
                      fontWeight: tokens.fontWeight.semibold,
                    }}
                  >
                    {KIND_LABELS[kind ?? "skill"]} ·{" "}
                    {(relationships?.rows ?? []).length} 项
                  </Text>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: tokens.spacing[2],
                    }}
                  >
                    {kind === "skill" ? (
                      <Button
                        tokens={tokens}
                        size="xs"
                        variant="secondary"
                        icon="RefreshCw"
                        onPress={() => void syncAllRemote()}
                        disabled={busy !== null}
                      >
                        一键同步
                      </Button>
                    ) : null}
                    {kind === "prompt" ? null : (
                      <Button
                        tokens={tokens}
                        size="xs"
                        variant={batchMode ? "default" : "secondary"}
                        onPress={() => {
                          setBatchMode((value) => !value);
                          setBatchSelected(new Set());
                        }}
                        testID="shared-assets-batch-toggle"
                      >
                        {batchMode ? "退出批量" : "批量操作"}
                      </Button>
                    )}
                  </View>
                </>
              ) : (
                <>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={{
                        color: tokens.colors.foreground,
                        fontSize: tokens.fontSize.lg,
                        fontWeight: tokens.fontWeight.semibold,
                      }}
                    >
                      共享仓库
                    </Text>
                    <Text
                      style={{
                        color: tokens.colors.foregroundMuted,
                        fontSize: tokens.fontSize.sm,
                      }}
                    >
                      团队可用的 {KIND_LABELS[kind ?? "skill"]}
                    </Text>
                  </View>
                  <View
                    style={{
                      width: 150,
                      alignItems: "center",
                      gap: tokens.spacing[2],
                    }}
                  >
                    <Text
                      style={{
                        color: tokens.colors.foregroundMuted,
                        fontSize: tokens.fontSize.sm,
                        fontWeight: tokens.fontWeight.semibold,
                      }}
                    >
                      同步与关联
                    </Text>
                    {kind === "skill" ? (
                      <Button
                        tokens={tokens}
                        size="xs"
                        variant="secondary"
                        icon="RefreshCw"
                        onPress={() => void syncAllRemote()}
                        disabled={busy !== null}
                      >
                        一键同步
                      </Button>
                    ) : null}
                    {kind === "prompt" ? null : (
                      <Button
                        tokens={tokens}
                        size="xs"
                        variant={batchMode ? "default" : "secondary"}
                        onPress={() => {
                          setBatchMode((value) => !value);
                          setBatchSelected(new Set());
                        }}
                        testID="shared-assets-batch-toggle"
                      >
                        {batchMode ? "退出批量" : "批量操作"}
                      </Button>
                    )}
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={{
                        color: tokens.colors.foreground,
                        fontSize: tokens.fontSize.lg,
                        fontWeight: tokens.fontWeight.semibold,
                      }}
                    >
                      本地 {KIND_LABELS[kind ?? "skill"]}
                    </Text>
                    <Text
                      style={{
                        color: tokens.colors.foregroundMuted,
                        fontSize: tokens.fontSize.sm,
                      }}
                    >
                      {kind === "skill"
                        ? "当前 Provider 实际可用"
                        : kind === "prompt"
                          ? "项目唯一 AGENTS.md 与当前 Provider 链接"
                          : "当前项目中的可用资产"}
                    </Text>
                  </View>
                </>
              )}
            </View>

            <RelationshipView
              tokens={tokens}
              compact={compact}
              kind={kind ?? "skill"}
              provider={provider}
              result={relationships}
              busy={busy}
              workspaceId={workspaceId}
              selectedIds={selectedLocalIds}
              batchMode={batchMode}
              batchSelected={batchSelected}
              batchOutcome={batchOutcome}
              onDismissBatchOutcome={() => setBatchOutcome(null)}
              onToggleBatch={(row) => {
                setBatchSelected((current) => {
                  const next = new Set(current);
                  if (next.has(row.id)) next.delete(row.id);
                  else next.add(row.id);
                  return next;
                });
              }}
              onToggleSelected={toggleSelected}
              onSelectForPublish={selectForPublish}
              onEnable={(row) =>
                void run("enable", () => setEnabled(row, true))
              }
              onAssociate={(row) => setAssociation(row)}
              onAssociateAll={(rows) =>
                run("batch-associate", () =>
                  associateRows(rows, "一键关联全部"),
                )
              }
              onUnlink={(row) => setUnlink(row)}
              onDiff={(row) => void openDiff(row)}
              onMerge={(row) => void openMerge(row)}
              onDiscard={(row) =>
                run("discard", async () => {
                  if (!workspaceId || !row.shared) return;
                  unwrap(
                    await driftResolveCall({
                      projectId: project.projectId,
                      workspaceId,
                      assetId: row.shared.assetId,
                      path: null,
                      provider: row.local?.provider ?? undefined,
                      action: "overwrite",
                    }),
                  );
                  setNotice(`${row.shared.name} 已恢复为共享仓库的版本`);
                })
              }
              onIgnore={(row, ignored) =>
                run("ignore-row", async () => {
                  if (!workspaceId) return;
                  const assetId =
                    row.shared?.assetId ??
                    (row.local ? assetIdForLocal(row.local) : null);
                  if (!assetId) return;
                  if (ignored) {
                    unwrap(
                      await driftIgnoreCall({
                        projectId: project.projectId,
                        workspaceId,
                        assetId,
                        path: null,
                        provider: row.local?.provider ?? undefined,
                        reason: "未同步远端",
                      }),
                    );
                  } else {
                    unwrap(
                      await driftUnignoreCall({
                        projectId: project.projectId,
                        workspaceId,
                        assetId,
                        path: null,
                        provider: row.local?.provider ?? undefined,
                      }),
                    );
                  }
                })
              }
            />
          </View>
        )}
      </View>

      {project.bound && kind && !(previewOpen && preview) ? (
        <PublishFooter
          tokens={tokens}
          compact={compact}
          kind={kind}
          selectedCount={selectedCount}
          publishableCount={publishableRows.length}
          batchMode={batchMode}
          batchSelectedCount={batchSelected.size}
          batchSelectableCount={batchSelectableCount}
          batchAddable={batchAddable.length}
          batchCandidates={batchCandidates.length}
          batchSyncable={batchSyncable.length}
          batchPublishable={batchPublishRows.length}
          batchUnlinkable={batchUnlinkable.length}
          busy={busy !== null}
          onSelectAllPublishable={selectAllPublishable}
          onPreview={() => void previewPublish()}
          onSelectAllBatch={() =>
            setBatchSelected(
              new Set(
                allRows
                  .filter(
                    (row) =>
                      row.relationship === "candidate" ||
                      row.relationship === "shared-only" ||
                      row.relationship === "linked",
                  )
                  .map((row) => row.id),
              ),
            )
          }
          onClearBatch={() => setBatchSelected(new Set())}
          onBatchAddLocal={() =>
            run("batch-add", async () => {
              let done = 0;
              let failed = 0;
              for (const row of batchAddable) {
                try {
                  await setEnabled(row, true);
                  done += 1;
                } catch {
                  failed += 1;
                }
              }
              setBatchOutcome({
                title: "批量添加到本地",
                succeeded: done,
                failed,
              });
            })
          }
          onBatchAssociate={() =>
            run("batch-associate", () =>
              associateRows(batchCandidates, "批量关联"),
            )
          }
          onBatchSync={() =>
            run("batch-sync", async () => {
              let done = 0;
              let failed = 0;
              for (const row of batchSyncable) {
                try {
                  await setEnabled(row, true);
                  done += 1;
                } catch {
                  failed += 1;
                }
              }
              setBatchOutcome({ title: "批量同步", succeeded: done, failed });
            })
          }
          onBatchPublish={() => {
            setSelectedLocalIds(
              new Set(batchPublishRows.map((row) => row.local!.assetId)),
            );
            void previewPublish(batchPublishItems);
          }}
          onBatchUnlink={() => setBatchUnlink(batchUnlinkable)}
        />
      ) : null}

      <AssociationDialog
        row={association}
        tokens={tokens}
        busy={busy === "adopt"}
        onClose={() => setAssociation(null)}
        onAdopt={(mode) => {
          if (association) void adopt(association, mode);
        }}
      />
      <UnlinkDialog
        rows={unlink ? [unlink] : []}
        tokens={tokens}
        busy={busy === "unlink"}
        onClose={() => setUnlink(null)}
        onConfirm={(deleteLocal) => {
          if (unlink) void confirmUnlink(unlink, deleteLocal);
        }}
      />
      <BatchUnlinkDialog
        rows={batchUnlink ?? []}
        tokens={tokens}
        busy={busy === "batch-unlink"}
        onClose={() => setBatchUnlink(null)}
        onConfirm={(deleteLocal) => {
          if (batchUnlink) void confirmBatchUnlink(batchUnlink, deleteLocal);
        }}
      />
      <UnbindDialog
        open={confirmUnbind || forceUnbind !== null}
        tokens={tokens}
        repoName={repositoryDisplayName(project.repoUrl)}
        forceMessage={forceUnbind}
        busy={busy === "unbind"}
        onClose={() => {
          setConfirmUnbind(false);
          setForceUnbind(null);
        }}
        onConfirm={(force) =>
          run("unbind", async () => {
            try {
              unwrap(await unbindCall({ projectId: project.projectId, force }));
              setConfirmUnbind(false);
              setForceUnbind(null);
              setNotice("已解绑共享仓库，本地资产均已保留");
            } catch (value) {
              if (messageOf(value).includes("E_LOCAL_CHANGES")) {
                setConfirmUnbind(false);
                setForceUnbind(messageOf(value));
                return;
              }
              throw value;
            }
          })
        }
      />
      <DiffDialog
        dialog={diffDialog}
        tokens={tokens}
        onClose={() => setDiffDialog(null)}
      />
      <MergeDialog
        dialog={mergeDialog}
        tokens={tokens}
        busy={busy === "merge"}
        onClose={() => setMergeDialog(null)}
        onApply={(resolutions) =>
          run("merge", async () => {
            if (!mergeDialog?.preview || !workspaceId) return;
            unwrap(
              await mergeApplyCall({
                projectId: project.projectId,
                workspaceId,
                assetId: mergeDialog.assetId,
                path: mergeDialog.path,
                provider: mergeDialog.provider,
                resolutions,
                expectedLocalDigest: mergeDialog.preview.expectedLocalDigest,
                expectedRemoteDigest: mergeDialog.preview.expectedRemoteDigest,
              }),
            );
            setMergeDialog(null);
            setNotice("已合并到本地，请确认后再发布");
          })
        }
      />
      <IgnoreRulesDialog
        open={ignoreDialog}
        tokens={tokens}
        projectId={project.projectId}
        drift={drift}
        busy={busy === "ignore-rules"}
        onClose={() => setIgnoreDialog(false)}
      />
    </View>
  );
}

function ConfigureForm({
  tokens,
  project,
  initialRepoUrl,
  initialBranch,
  busy,
  onCancel,
  onSubmit,
}: {
  tokens: Tokens;
  project: ProjectSummary;
  initialRepoUrl: string;
  initialBranch: string;
  busy: boolean;
  onCancel?: () => void;
  onSubmit: (
    repoUrl: string,
    branch: string,
    syncMode: "auto" | "manual",
  ) => void;
}) {
  const [repoUrl, setRepoUrl] = useState(initialRepoUrl);
  const [branch, setBranch] = useState(initialBranch);
  const [syncMode, setSyncMode] = useState<"auto" | "manual">(
    project.syncMode ?? "manual",
  );
  return (
    <Panel
      tokens={tokens}
      style={{
        width: "100%",
        maxWidth: 720,
        alignSelf: "center",
        marginTop: project.bound ? 0 : 56,
      }}
    >
      <SectionTitle tokens={tokens}>
        {project.bound ? "切换共享 Git 仓库" : "连接团队 Git 仓库"}
      </SectionTitle>
      <Muted tokens={tokens}>
        {project.bound
          ? "新仓库验证成功后才会完成切换；原仓库关联会解除，本地资产不会被删除。"
          : "当前项目只绑定一个仓库。项目身份自动管理，无需再填写项目名称。"}
      </Muted>
      <Field
        label="Git 仓库地址"
        hint="仓库名称会根据地址自动识别；不同项目可绑定不同仓库。"
        tokens={tokens}
      >
        <TextField
          value={repoUrl}
          onChangeText={setRepoUrl}
          placeholder="https://github.com/team/assets.git"
          tokens={tokens}
          editable={!busy}
          testID="shared-assets-repo-url"
        />
      </Field>
      <Field
        label="分支"
        hint="daemon 会自动更新共享仓库；是否同步或合并到项目本地由你逐项决定。"
        tokens={tokens}
      >
        <TextField
          value={branch}
          onChangeText={setBranch}
          placeholder="main"
          tokens={tokens}
          editable={!busy}
          testID="shared-assets-branch"
        />
      </Field>
      {project.bound ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button
            tokens={tokens}
            size="xs"
            variant={syncMode === "manual" ? "default" : "secondary"}
            onPress={() => setSyncMode("manual")}
          >
            手动同步
          </Button>
          <Button
            tokens={tokens}
            size="xs"
            variant={syncMode === "auto" ? "default" : "secondary"}
            onPress={() => setSyncMode("auto")}
          >
            自动同步
          </Button>
        </View>
      ) : null}
      <View
        style={{
          flexDirection: "row",
          justifyContent: "flex-end",
          gap: 8,
        }}
      >
        {onCancel ? (
          <Button
            tokens={tokens}
            variant="ghost"
            disabled={busy}
            onPress={onCancel}
          >
            取消
          </Button>
        ) : null}
        <Button
          tokens={tokens}
          variant="default"
          disabled={busy || !repoUrl.trim()}
          onPress={() => onSubmit(repoUrl, branch, syncMode)}
          testID="shared-assets-configure-submit"
        >
          {busy ? "验证中…" : project.bound ? "验证并切换" : "连接共享库"}
        </Button>
      </View>
    </Panel>
  );
}

function RepoOverview({
  tokens,
  compact,
  project,
  binding,
  busy,
  onSync,
  onRebind,
  onRequestUnbind,
}: {
  tokens: Tokens;
  compact: boolean;
  project: ProjectSummary;
  binding: Binding | null;
  busy: string | null;
  onSync: () => void;
  onRebind: () => void;
  onRequestUnbind: () => void;
}) {
  const state = binding?.state ?? project.state;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexWrap: compact ? "wrap" : "nowrap",
        gap: tokens.spacing[3],
        borderBottomWidth: 1,
        borderBottomColor: tokens.colors.border,
        backgroundColor: tokens.colors.surface1,
        paddingHorizontal: compact ? tokens.spacing[3] : tokens.spacing[4],
        paddingVertical: tokens.spacing[3],
      }}
    >
      <View
        style={{
          flex: 1,
          minWidth: 0,
          flexBasis: compact ? "100%" : undefined,
        }}
      >
        <Text
          style={{
            color: tokens.colors.foreground,
            fontSize: tokens.fontSize.base,
            fontWeight: tokens.fontWeight.semibold,
          }}
        >
          {binding?.displayName ?? repositoryDisplayName(project.repoUrl)}
        </Text>
        <Text
          style={{
            color: tokens.colors.foregroundMuted,
            fontSize: tokens.fontSize.sm,
            fontFamily: tokens.fontFamily,
          }}
          numberOfLines={1}
        >
          {project.repoUrl ?? ""}
        </Text>
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: compact ? "wrap" : "nowrap",
          gap: compact ? tokens.spacing[2] : tokens.spacing[3],
        }}
      >
        <View style={{ alignItems: "flex-end" }}>
          <Text
            style={{
              color: tokens.colors.foregroundMuted,
              fontSize: tokens.fontSize.sm,
            }}
          >
            当前版本
          </Text>
          <Text
            style={{
              color: tokens.colors.foreground,
              fontSize: tokens.fontSize.sm,
              fontFamily: tokens.fontFamily,
            }}
            testID="shared-assets-local-revision"
          >
            {state?.localRevision ? state.localRevision.slice(0, 8) : "空仓库"}
          </Text>
        </View>
        <Button
          tokens={tokens}
          size="xs"
          variant="ghost"
          icon="RefreshCw"
          disabled={busy !== null}
          onPress={onSync}
          testID="shared-assets-sync"
        >
          立即检查更新
        </Button>
        <Button
          tokens={tokens}
          size="xs"
          variant="ghost"
          disabled={busy !== null}
          onPress={onRebind}
        >
          切换仓库
        </Button>
        <Button
          tokens={tokens}
          size="xs"
          variant="ghost"
          disabled={busy !== null}
          onPress={onRequestUnbind}
        >
          解绑
        </Button>
      </View>
    </View>
  );
}

function PublishFooter({
  tokens,
  compact,
  kind,
  selectedCount,
  publishableCount,
  batchMode,
  batchSelectedCount,
  batchSelectableCount,
  batchAddable,
  batchCandidates,
  batchSyncable,
  batchPublishable,
  batchUnlinkable,
  busy,
  onSelectAllPublishable,
  onPreview,
  onSelectAllBatch,
  onClearBatch,
  onBatchAddLocal,
  onBatchAssociate,
  onBatchSync,
  onBatchPublish,
  onBatchUnlink,
}: {
  tokens: Tokens;
  compact: boolean;
  kind: AssetKind;
  selectedCount: number;
  publishableCount: number;
  batchMode: boolean;
  batchSelectedCount: number;
  batchSelectableCount: number;
  batchAddable: number;
  batchCandidates: number;
  batchSyncable: number;
  batchPublishable: number;
  batchUnlinkable: number;
  busy: boolean;
  onSelectAllPublishable: () => void;
  onPreview: () => void;
  onSelectAllBatch: () => void;
  onClearBatch: () => void;
  onBatchAddLocal: () => void;
  onBatchAssociate: () => void;
  onBatchSync: () => void;
  onBatchPublish: () => void;
  onBatchUnlink: () => void;
}) {
  return (
    <View
      style={{
        minHeight: 64,
        flexDirection: batchMode ? "column" : "row",
        alignItems: batchMode ? "stretch" : "center",
        justifyContent: "space-between",
        flexWrap: compact && !batchMode ? "wrap" : "nowrap",
        gap: tokens.spacing[2],
        borderTopWidth: 1,
        borderTopColor: tokens.colors.border,
        backgroundColor: tokens.colors.surface1,
        paddingHorizontal: compact ? tokens.spacing[3] : tokens.spacing[4],
        paddingVertical: compact ? tokens.spacing[2] : tokens.spacing[3],
      }}
      testID="shared-assets-publish-footer"
    >
      {batchMode ? (
        <>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              flexWrap: "wrap",
              gap: tokens.spacing[2],
            }}
          >
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
              }}
            >
              已选择 {batchSelectedCount} 项
            </Text>
            <Button
              tokens={tokens}
              size="sm"
              variant="ghost"
              disabled={busy || batchSelectableCount === 0}
              onPress={onSelectAllBatch}
            >
              全选可操作项
            </Button>
            <Button
              tokens={tokens}
              size="xs"
              variant="ghost"
              disabled={busy || batchSelectedCount === 0}
              onPress={onClearBatch}
            >
              清空
            </Button>
          </View>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: tokens.spacing[2],
            }}
          >
            <Button
              tokens={tokens}
              size="xs"
              variant="secondary"
              disabled={busy || batchAddable === 0}
              onPress={onBatchAddLocal}
            >
              添加到本地 · {batchAddable}
            </Button>
            <Button
              tokens={tokens}
              size="xs"
              variant="secondary"
              disabled={busy || batchCandidates === 0}
              onPress={onBatchAssociate}
            >
              关联已有本地 · {batchCandidates}
            </Button>
            <Button
              tokens={tokens}
              size="xs"
              variant="secondary"
              disabled={busy || batchSyncable === 0}
              onPress={onBatchSync}
            >
              同步到本地 · {batchSyncable}
            </Button>
            <Button
              tokens={tokens}
              size="xs"
              variant="secondary"
              disabled={busy || batchPublishable === 0}
              onPress={onBatchPublish}
            >
              发布 · {batchPublishable}
            </Button>
            <Button
              tokens={tokens}
              size="xs"
              variant="ghost"
              disabled={busy || batchUnlinkable === 0}
              onPress={onBatchUnlink}
            >
              移除关联 · {batchUnlinkable}
            </Button>
          </View>
          <Text
            style={{
              color: tokens.colors.foregroundMuted,
              fontSize: tokens.fontSize.sm,
            }}
          >
            {batchSelectedCount === 0
              ? "勾选要处理的资产；灰显行是同名冲突或仅本地资产，需逐项处理。范围限于当前标签页。"
              : "「关联已有本地」固定保留本地内容，不发布；逐项执行，失败项保持原状。"}
          </Text>
        </>
      ) : (
        <>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              flexWrap: "wrap",
              gap: tokens.spacing[2],
              flexBasis: compact ? "100%" : undefined,
            }}
          >
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
              }}
            >
              已选择 {selectedCount} 项本地 {KIND_LABELS[kind]}
            </Text>
            <Button
              tokens={tokens}
              size="xs"
              variant="ghost"
              disabled={busy || publishableCount === 0}
              onPress={onSelectAllPublishable}
            >
              全选可发布项
            </Button>
          </View>
          <Button
            tokens={tokens}
            size="md"
            variant="secondary"
            icon="UploadCloud"
            disabled={busy || selectedCount === 0}
            onPress={onPreview}
            testID="shared-assets-preview-publish"
          >
            预览并发布
          </Button>
        </>
      )}
    </View>
  );
}

function RelationshipView({
  tokens,
  compact,
  kind,
  provider,
  result,
  busy,
  workspaceId,
  selectedIds,
  batchMode,
  batchSelected,
  batchOutcome,
  onDismissBatchOutcome,
  onToggleBatch,
  onToggleSelected,
  onSelectForPublish,
  onEnable,
  onAssociate,
  onAssociateAll,
  onUnlink,
  onDiff,
  onMerge,
  onDiscard,
  onIgnore,
}: {
  tokens: Tokens;
  compact: boolean;
  kind: AssetKind;
  provider: string;
  result: RelationshipListResult | null;
  busy: string | null;
  workspaceId: string | null;
  selectedIds: ReadonlySet<string>;
  batchMode: boolean;
  batchSelected: ReadonlySet<string>;
  batchOutcome: {
    title: string;
    succeeded: number;
    failed: number;
    failures?: BatchAssociateFailure[];
  } | null;
  onDismissBatchOutcome: () => void;
  onToggleBatch: (row: AssetRelationshipRow) => void;
  onToggleSelected: (row: AssetRelationshipRow) => void;
  onSelectForPublish: (row: AssetRelationshipRow) => void;
  onEnable: (row: AssetRelationshipRow) => void;
  onAssociate: (row: AssetRelationshipRow) => void;
  onAssociateAll: (rows: AssetRelationshipRow[]) => void;
  onUnlink: (row: AssetRelationshipRow) => void;
  onDiff: (row: AssetRelationshipRow) => void;
  onMerge: (row: AssetRelationshipRow) => void;
  onDiscard: (row: AssetRelationshipRow) => void;
  onIgnore: (row: AssetRelationshipRow, ignored: boolean) => void;
}) {
  const rows = sortRelationshipRows(result?.rows ?? []);
  const candidates = rows.filter((row) => row.relationship === "candidate");
  if (!workspaceId) {
    return <Empty tokens={tokens}>该项目还没有 Workspace。</Empty>;
  }
  if (!result) return <Spinner tokens={tokens} />;

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      {candidates.length > 0 ? (
        <View
          style={{
            flexDirection: compact ? "column" : "row",
            alignItems: compact ? "stretch" : "center",
            gap: tokens.spacing[3],
            borderBottomWidth: 1,
            borderBottomColor: tokens.colors.border,
            backgroundColor: tokens.colors.surface1,
            paddingHorizontal: tokens.spacing[4],
            paddingVertical: tokens.spacing[2],
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: tokens.spacing[1] }}>
            <Text
              style={{
                color: tokens.colors.foreground,
                fontSize: tokens.fontSize.lg,
                fontWeight: tokens.fontWeight.semibold,
              }}
            >
              {candidates.length} 项同名资产尚未关联
            </Text>
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
              }}
            >
              一键关联按「保留本地」处理：不改动本地文件，不自动发布；与共享版本不同时显示为本地未发布。
            </Text>
          </View>
          <Button
            tokens={tokens}
            size="xs"
            icon="Link2"
            variant="secondary"
            style={compact ? { alignSelf: "flex-start" } : undefined}
            disabled={busy !== null}
            onPress={() => onAssociateAll(candidates)}
          >
            一键关联全部
          </Button>
        </View>
      ) : null}

      {batchOutcome ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: tokens.spacing[3],
            borderBottomWidth: 1,
            borderBottomColor: tokens.colors.border,
            backgroundColor: tokens.colors.surface1,
            paddingHorizontal: tokens.spacing[4],
            paddingVertical: tokens.spacing[2],
          }}
        >
          <Text
            style={{
              color: tokens.colors.foreground,
              fontSize: tokens.fontSize.sm,
              fontWeight: tokens.fontWeight.semibold,
            }}
          >
            {batchOutcome.title}
          </Text>
          <Text
            style={{
              color: tokens.colors.success,
              fontSize: tokens.fontSize.sm,
            }}
          >
            成功 {batchOutcome.succeeded} 项
          </Text>
          {batchOutcome.failed > 0 ? (
            <Text
              style={{
                color: tokens.colors.danger,
                fontSize: tokens.fontSize.sm,
              }}
            >
              失败 {batchOutcome.failed} 项
            </Text>
          ) : null}
          {batchOutcome.failures && batchOutcome.failures.length > 0 ? (
            <Text
              style={{
                flexShrink: 1,
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
              }}
              numberOfLines={2}
            >
              {batchOutcome.failures
                .slice(0, 3)
                .map((entry) => `${entry.name}: ${entry.message}`)
                .join("；")}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={onDismissBatchOutcome}
            style={{ marginLeft: "auto", paddingVertical: 2 }}
          >
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
              }}
            >
              关闭
            </Text>
          </Pressable>
        </View>
      ) : null}

      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{
          gap: tokens.spacing[3],
          paddingHorizontal: compact ? tokens.spacing[3] : tokens.spacing[4],
          paddingVertical: compact ? tokens.spacing[3] : tokens.spacing[4],
        }}
      >
        {rows.length === 0 ? (
          <Text
            style={{
              color: tokens.colors.foregroundMuted,
              textAlign: "center",
              paddingVertical: 48,
            }}
          >
            共享仓库和本地都没有发现 {KIND_LABELS[kind]}
          </Text>
        ) : null}

        {rows.map((row) => {
          const isSelected = row.local
            ? selectedIds.has(row.local.assetId)
            : false;
          const batchChecked = batchSelected.has(row.id);
          return (
            <View
              key={row.id}
              style={{
                flexDirection: "row",
                alignItems: "stretch",
                gap: tokens.spacing[2],
              }}
              testID={`shared-assets-row-${row.shared?.name ?? row.local?.name}`}
            >
              {batchMode ? (
                <View
                  style={{
                    width: 28,
                    marginTop: tokens.spacing[3],
                    alignItems: "center",
                  }}
                >
                  <Checkbox
                    tokens={tokens}
                    checked={batchChecked}
                    onPress={() => onToggleBatch(row)}
                    accessibilityLabel={`选择 ${row.shared?.name ?? row.local?.name}`}
                    testID={`shared-batch-select-${row.id}`}
                  />
                </View>
              ) : null}
              <View style={{ flex: 1, minWidth: 0 }}>
                <RelationshipRow
                  row={row}
                  tokens={tokens}
                  compact={compact}
                  provider={provider}
                  selected={isSelected}
                  showSelection={row.local !== null && !batchMode}
                  busy={busy}
                  onToggleSelected={() => onToggleSelected(row)}
                  onEnable={() => onEnable(row)}
                  onAssociate={() => onAssociate(row)}
                  onUnlink={() => onUnlink(row)}
                  onSelectForPublish={() => onSelectForPublish(row)}
                  onDiff={() => onDiff(row)}
                  onMerge={() => onMerge(row)}
                  onDiscard={() => onDiscard(row)}
                  onIgnore={(ignored) => onIgnore(row, ignored)}
                />
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function SyncStatusPill({
  status,
  tokens,
}: {
  status: AssetRelationshipRow["syncStatus"];
  tokens: Tokens;
}) {
  if (!status || status === "synced" || status === "missing") {
    return null;
  }
  const style =
    status === "remote-update"
      ? {
          borderColor: "rgba(56, 139, 253, 0.36)",
          backgroundColor: "rgba(56, 139, 253, 0.1)",
          color: tokens.colors.accent,
          icon: "RefreshCw",
          label: "共享端有新版本，本地尚未同步",
        }
      : status === "local-update"
        ? {
            borderColor: "rgba(210, 153, 34, 0.4)",
            backgroundColor: "rgba(210, 153, 34, 0.12)",
            color: tokens.colors.warning,
            icon: "UploadCloud",
            label: "本地有未发布修改",
          }
        : status === "unpublished-local"
          ? {
              borderColor: "rgba(210, 153, 34, 0.4)",
              backgroundColor: "rgba(210, 153, 34, 0.12)",
              color: tokens.colors.warning,
              icon: "UploadCloud",
              label: "本地有未发布内容",
            }
          : status === "diverged"
            ? {
                borderColor: "rgba(248, 81, 73, 0.4)",
                backgroundColor: "rgba(248, 81, 73, 0.1)",
                color: tokens.colors.danger,
                icon: "X",
                label: "共享端与本地均有修改",
              }
            : {
                borderColor: "rgba(248, 81, 73, 0.4)",
                backgroundColor: "rgba(248, 81, 73, 0.1)",
                color: tokens.colors.danger,
                icon: "X",
                label: "共享仓库已删除，本地副本仍保留",
              };
  return (
    <View
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: tokens.spacing[1],
        borderRadius: tokens.radius.full,
        borderWidth: 1,
        borderColor: style.borderColor,
        backgroundColor: style.backgroundColor,
        paddingHorizontal: tokens.spacing[2],
        paddingVertical: 3,
      }}
    >
      <Icon name={style.icon} size={12} color={style.color} />
      <Text style={{ color: style.color, fontSize: tokens.fontSize.sm }}>
        {style.label}
      </Text>
    </View>
  );
}

function RelationPill({
  tokens,
  label,
  icon,
  tone,
}: {
  tokens: Tokens;
  label: string;
  icon: string;
  tone: "remote" | "local" | "diverged";
}) {
  const style =
    tone === "remote"
      ? {
          borderColor: "rgba(56, 139, 253, 0.42)",
          backgroundColor: "rgba(56, 139, 253, 0.12)",
          color: tokens.colors.accent,
        }
      : tone === "local"
        ? {
            borderColor: "rgba(210, 153, 34, 0.48)",
            backgroundColor: "rgba(210, 153, 34, 0.14)",
            color: tokens.colors.warning,
          }
        : {
            borderColor: "rgba(248, 81, 73, 0.46)",
            backgroundColor: "rgba(248, 81, 73, 0.12)",
            color: tokens.colors.danger,
          };
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: tokens.spacing[1],
        borderRadius: tokens.radius.full,
        borderWidth: 1,
        borderColor: style.borderColor,
        backgroundColor: style.backgroundColor,
        paddingHorizontal: tokens.spacing[2],
        paddingVertical: tokens.spacing[1],
      }}
    >
      <Icon name={icon} size={13} color={style.color} />
      <Text style={{ color: style.color, fontSize: tokens.fontSize.sm }}>
        {label}
      </Text>
    </View>
  );
}

/**
 * The shared-assets relationship order: what needs attention first, then linked,
 * same-name candidates, shared-only, and finally local-only assets.
 */
function sortRelationshipRows(
  rows: AssetRelationshipRow[],
): AssetRelationshipRow[] {
  const driftRank: Record<string, number> = {
    diverged: 0,
    "local-update": 1,
    "remote-update": 2,
    "remote-deleted": 3,
    "unpublished-local": 4,
  };
  const group = (row: AssetRelationshipRow): number => {
    const rank = row.syncStatus ? driftRank[row.syncStatus] : undefined;
    if (rank !== undefined) return rank;
    if (row.relationship === "linked") return 10;
    if (row.relationship === "candidate" || row.relationship === "conflict")
      return 20;
    if (row.relationship === "private") return 40;
    return 30;
  };
  return [...rows].sort((left, right) => {
    const delta = group(left) - group(right);
    if (delta !== 0) return delta;
    const leftName = left.shared?.name ?? left.local?.name ?? "";
    const rightName = right.shared?.name ?? right.local?.name ?? "";
    return leftName.localeCompare(rightName);
  });
}

function RelationshipRow({
  row,
  tokens,
  compact,
  provider,
  selected,
  showSelection,
  busy,
  onToggleSelected,
  onEnable,
  onAssociate,
  onUnlink,
  onSelectForPublish,
  onDiff,
  onMerge,
  onDiscard,
  onIgnore,
}: {
  row: AssetRelationshipRow;
  tokens: Tokens;
  compact: boolean;
  provider: string;
  selected: boolean;
  showSelection: boolean;
  busy: string | null;
  onToggleSelected: () => void;
  onEnable: () => void;
  onAssociate: () => void;
  onUnlink: () => void;
  onSelectForPublish: () => void;
  onDiff: () => void;
  onMerge: () => void;
  onDiscard: () => void;
  onIgnore: (ignored: boolean) => void;
}) {
  const shared = row.shared;
  const local = row.local;
  const syncStatus = row.syncStatus;
  const isRemoteUpdate =
    row.relationship === "linked" && syncStatus === "remote-update";
  const isDiverged = row.relationship === "linked" && syncStatus === "diverged";
  const isLocalUpdate =
    row.relationship === "linked" && syncStatus === "local-update";
  const isRemoteDeleted =
    row.relationship === "linked" && syncStatus === "remote-deleted";
  const isUnpublishedLocal =
    row.relationship === "linked" && syncStatus === "unpublished-local";
  const isPrivate = row.relationship === "private";
  const isCandidate = row.relationship === "candidate";
  const isSharedOnly = row.relationship === "shared-only";
  const isConflict = row.relationship === "conflict";
  const isSynced =
    row.relationship === "linked" &&
    !isRemoteUpdate &&
    !isDiverged &&
    !isLocalUpdate &&
    !isRemoteDeleted &&
    !isUnpublishedLocal;
  const localDetail = !local
    ? ""
    : isPrivate
      ? `将创建新的共享 ${KIND_LABELS[local.kind]}`
      : isCandidate
        ? `将更新同名共享 ${KIND_LABELS[local.kind]}`
        : row.relationship === "linked"
          ? isUnpublishedLocal
            ? "尚未同步到共享库"
            : `将更新已关联的共享 ${KIND_LABELS[local.kind]}`
          : "";

  const sharedCard = shared ? (
    <View
      style={{
        minWidth: 0,
        minHeight: compact ? undefined : 112,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: tokens.spacing[3],
        borderWidth: 1,
        borderColor:
          isRemoteDeleted || isDiverged
            ? "rgba(248, 81, 73, 0.62)"
            : isRemoteUpdate
              ? "rgba(56, 139, 253, 0.58)"
              : isLocalUpdate
                ? "rgba(210, 153, 34, 0.62)"
                : isSynced
                  ? tokens.colors.accent
                  : tokens.colors.border,
        backgroundColor:
          isRemoteDeleted || isDiverged
            ? "rgba(248, 81, 73, 0.07)"
            : isRemoteUpdate
              ? "rgba(56, 139, 253, 0.07)"
              : isLocalUpdate
                ? "rgba(210, 153, 34, 0.08)"
                : isSynced
                  ? tokens.colors.surface2
                  : tokens.colors.surface1,
        borderRadius: tokens.radius.lg,
        padding: tokens.spacing[3],
      }}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: tokens.radius.md,
          backgroundColor: tokens.colors.surface3,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon
          name={
            isRemoteDeleted || isDiverged
              ? "X"
              : row.relationship === "linked"
                ? "Check"
                : "LibraryBig"
          }
          size={14}
          color={
            isRemoteDeleted || isDiverged
              ? tokens.colors.danger
              : tokens.colors.accent
          }
        />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: tokens.spacing[1] }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: tokens.spacing[2],
          }}
        >
          <Text
            style={{
              color: tokens.colors.foreground,
              fontSize: tokens.fontSize.base,
              fontWeight: tokens.fontWeight.semibold,
              flexShrink: 1,
            }}
            numberOfLines={1}
          >
            {shared.name}
          </Text>
          <Text
            style={{
              color: tokens.colors.accent,
              fontSize: tokens.fontSize.sm,
              borderRadius: tokens.radius.full,
              backgroundColor: tokens.colors.surface3,
              paddingHorizontal: tokens.spacing[2],
              paddingVertical: 2,
            }}
          >
            {shared.kind === "prompt" ? provider : "项目级"}
          </Text>
        </View>
        <Text
          style={{
            color: tokens.colors.foregroundMuted,
            fontSize: tokens.fontSize.sm,
          }}
          numberOfLines={2}
        >
          {shared.description || "无描述"}
        </Text>
        <SyncStatusPill status={syncStatus} tokens={tokens} />
      </View>
    </View>
  ) : (
    <View
      style={{
        flex: compact ? undefined : 1,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: tokens.colors.border,
        borderRadius: tokens.radius.lg,
        minHeight: compact ? 0 : 112,
        backgroundColor: tokens.colors.surface2,
        alignItems: "center",
        justifyContent: "center",
        padding: tokens.spacing[2],
      }}
    >
      {isPrivate ? null : (
        <Text
          style={{
            color: tokens.colors.foregroundMuted,
            fontSize: tokens.fontSize.sm,
          }}
        >
          尚未添加到本地
        </Text>
      )}
    </View>
  );

  const localCard = local ? (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled: !showSelection }}
      disabled={!showSelection}
      onPress={onToggleSelected}
      style={{
        minWidth: 0,
        minHeight: compact ? undefined : 112,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: tokens.spacing[3],
        borderWidth: 1,
        borderColor: selected
          ? tokens.colors.accent
          : isDiverged || isRemoteDeleted
            ? "rgba(248, 81, 73, 0.62)"
            : isLocalUpdate
              ? "rgba(210, 153, 34, 0.62)"
              : isUnpublishedLocal
                ? "rgba(210, 153, 34, 0.42)"
                : tokens.colors.border,
        backgroundColor: selected
          ? tokens.colors.surface2
          : isDiverged || isRemoteDeleted
            ? "rgba(248, 81, 73, 0.07)"
            : isLocalUpdate
              ? "rgba(210, 153, 34, 0.08)"
              : isUnpublishedLocal
                ? "rgba(210, 153, 34, 0.05)"
                : tokens.colors.surface1,
        borderRadius: tokens.radius.lg,
        padding: tokens.spacing[3],
      }}
    >
      <View pointerEvents="none" style={{ opacity: showSelection ? 1 : 0 }}>
        <Checkbox
          tokens={tokens}
          checked={selected}
          onPress={onToggleSelected}
          size={20}
          accessibilityLabel={`选择发布 ${local.name}`}
          testID={`shared-assets-publish-select-${local.name}`}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: tokens.spacing[1] }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: tokens.spacing[2],
            flexWrap: compact ? "wrap" : "nowrap",
          }}
        >
          <Text
            style={{
              color: tokens.colors.foreground,
              fontSize: tokens.fontSize.base,
              fontWeight: tokens.fontWeight.semibold,
              flexShrink: 1,
            }}
            numberOfLines={1}
          >
            {local.name}
          </Text>
          <Text
            style={{
              color: tokens.colors.foregroundMuted,
              fontSize: tokens.fontSize.sm,
              borderRadius: tokens.radius.full,
              backgroundColor: tokens.colors.surface3,
              paddingHorizontal: tokens.spacing[2],
              paddingVertical: 2,
            }}
          >
            {local.kind === "skill" ? "项目级" : "本地"}
          </Text>
          {isPrivate ? (
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
                borderRadius: tokens.radius.full,
                borderWidth: 1,
                borderColor: tokens.colors.border,
                paddingHorizontal: tokens.spacing[2],
                paddingVertical: 2,
              }}
            >
              私有
            </Text>
          ) : null}
        </View>
        <Text
          style={{
            color: tokens.colors.foregroundMuted,
            fontSize: tokens.fontSize.sm,
          }}
          numberOfLines={2}
        >
          {local.description || "无描述"}
        </Text>
        {localDetail ? (
          <Text
            style={{
              color: tokens.colors.foregroundMuted,
              fontSize: tokens.fontSize.sm,
            }}
          >
            {localDetail}
          </Text>
        ) : null}
        <SyncStatusPill
          status={
            isLocalUpdate || isDiverged || isRemoteDeleted || isUnpublishedLocal
              ? syncStatus
              : null
          }
          tokens={tokens}
        />
        {isPrivate ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: tokens.spacing[2],
            }}
          >
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
              }}
            >
              尚未同步到共享库
            </Text>
            {row.syncStatus === "unpublished-local" ? (
              <Pressable
                accessibilityRole="button"
                onPress={(event) => {
                  event.stopPropagation();
                  onIgnore(true);
                }}
                style={{ paddingVertical: 2 }}
                testID={`shared-asset-ignore-${local.assetId}`}
              >
                <Text
                  style={{
                    color: tokens.colors.accent,
                    fontSize: tokens.fontSize.sm,
                  }}
                >
                  忽略提醒
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  ) : (
    <View
      style={{
        flex: compact ? undefined : 1,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: tokens.colors.border,
        borderRadius: tokens.radius.lg,
        minHeight: compact ? 0 : 112,
        backgroundColor: tokens.colors.surface2,
        alignItems: "center",
        justifyContent: "center",
        padding: tokens.spacing[2],
      }}
    >
      <Text
        style={{
          color: tokens.colors.foregroundMuted,
          fontSize: tokens.fontSize.sm,
        }}
      >
        尚未添加到本地
      </Text>
    </View>
  );

  const actions = (
    <View
      style={{
        width: compact ? undefined : 150,
        gap: tokens.spacing[2],
        alignItems: compact ? "flex-start" : "center",
        justifyContent: compact ? "flex-start" : "center",
        flexDirection: compact ? "row" : "column",
        flexWrap: compact ? "wrap" : "nowrap",
        paddingHorizontal: compact ? tokens.spacing[1] : undefined,
        position: compact ? undefined : "relative",
      }}
    >
      {isPrivate ? (
        <>
          <Icon
            name="LockKeyhole"
            size={15}
            color={tokens.colors.foregroundMuted}
          />
          <Text
            style={{
              color: tokens.colors.foregroundMuted,
              fontSize: tokens.fontSize.sm,
            }}
          >
            本地私有
          </Text>
          <Button tokens={tokens} size="xs" onPress={onSelectForPublish}>
            选择发布
          </Button>
        </>
      ) : isCandidate ? (
        <>
          <Icon name="Link2" size={15} color={tokens.colors.accent} />
          <Text
            style={{
              color: tokens.colors.foregroundMuted,
              fontSize: tokens.fontSize.sm,
            }}
          >
            发现同名资产
          </Text>
          <Button tokens={tokens} size="xs" onPress={onAssociate}>
            关联已有本地
          </Button>
        </>
      ) : isConflict ? (
        <>
          <Icon name="X" size={15} color={tokens.colors.danger} />
          <Text
            style={{
              color: tokens.colors.danger,
              fontSize: tokens.fontSize.sm,
            }}
          >
            同名但未关联
          </Text>
        </>
      ) : isSharedOnly ? (
        <>
          <Icon
            name="ArrowRight"
            size={17}
            color={tokens.colors.foregroundMuted}
          />
          <Button
            tokens={tokens}
            size="xs"
            variant="default"
            onPress={onEnable}
            disabled={busy !== null}
          >
            添加到本地
          </Button>
        </>
      ) : isRemoteDeleted ? (
        <>
          <RelationPill
            tokens={tokens}
            label="远端已删除"
            icon="X"
            tone="diverged"
          />
          <Text
            style={{
              color: tokens.colors.foregroundMuted,
              fontSize: tokens.fontSize.sm,
            }}
          >
            本地副本仍保留
          </Text>
          <Button tokens={tokens} size="xs" onPress={onSelectForPublish}>
            重新发布
          </Button>
          <Button tokens={tokens} size="xs" variant="ghost" onPress={onUnlink}>
            保留为私有
          </Button>
        </>
      ) : isRemoteUpdate ? (
        <>
          <RelationPill
            tokens={tokens}
            label="共享 → 本地"
            icon="RefreshCw"
            tone="remote"
          />
          <Text
            style={{
              color: tokens.colors.foregroundMuted,
              fontSize: tokens.fontSize.sm,
            }}
          >
            共享端有新版本
          </Text>
          <Button
            tokens={tokens}
            size="xs"
            icon="RefreshCw"
            onPress={onEnable}
            disabled={busy !== null}
          >
            同步到本地
          </Button>
          <Button tokens={tokens} size="xs" variant="ghost" onPress={onDiff}>
            查看差异
          </Button>
          <Button tokens={tokens} size="xs" variant="ghost" onPress={onUnlink}>
            移除关联
          </Button>
        </>
      ) : isLocalUpdate || isDiverged || isUnpublishedLocal ? (
        <>
          <RelationPill
            tokens={tokens}
            label={
              isDiverged
                ? "双方均有修改"
                : isUnpublishedLocal
                  ? "本地有未发布内容"
                  : "本地 → 共享"
            }
            icon={isDiverged ? "X" : "UploadCloud"}
            tone={isDiverged ? "diverged" : "local"}
          />
          <Button
            tokens={tokens}
            size="xs"
            variant={isDiverged ? "ghost" : "secondary"}
            onPress={onSelectForPublish}
          >
            选择发布
          </Button>
          {isDiverged ? (
            <Button tokens={tokens} size="xs" onPress={onMerge}>
              合并修改
            </Button>
          ) : null}
          {isUnpublishedLocal ? null : (
            <Button tokens={tokens} size="xs" variant="ghost" onPress={onDiff}>
              查看差异
            </Button>
          )}
          <Button
            tokens={tokens}
            size="xs"
            variant="ghost"
            onPress={onDiscard}
            disabled={busy !== null}
          >
            放弃本地修改
          </Button>
          <Button tokens={tokens} size="xs" variant="ghost" onPress={onUnlink}>
            移除关联
          </Button>
        </>
      ) : isSynced ? (
        <>
          {compact ? null : (
            <View
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: "38%",
                height: 1,
                backgroundColor: tokens.colors.accent,
              }}
            />
          )}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              borderRadius: tokens.radius.full,
              backgroundColor: tokens.colors.surfaceWorkspace,
              paddingHorizontal: tokens.spacing[2],
              paddingVertical: 2,
            }}
          >
            <Icon name="Link2" size={13} color={tokens.colors.accent} />
            <Text
              style={{
                color: tokens.colors.accent,
                fontSize: tokens.fontSize.sm,
              }}
            >
              已同步关联
            </Text>
          </View>
          <Button tokens={tokens} size="xs" variant="ghost" onPress={onUnlink}>
            移除关联
          </Button>
          <Button tokens={tokens} size="xs" variant="ghost" onPress={onDiff}>
            查看差异
          </Button>
        </>
      ) : (
        <Button tokens={tokens} size="xs" onPress={onEnable}>
          添加到本地
        </Button>
      )}
    </View>
  );

  if (compact) {
    return (
      <View style={{ gap: 8 }}>
        {sharedCard}
        {actions}
        {localCard}
      </View>
    );
  }
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "stretch",
        gap: tokens.spacing[3],
      }}
    >
      <View style={{ flex: compact ? undefined : 1, minWidth: 0 }}>
        {sharedCard}
      </View>
      {actions}
      <View style={{ flex: compact ? undefined : 1, minWidth: 0 }}>
        {localCard}
      </View>
    </View>
  );
}

function UnbindDialog({
  open,
  tokens,
  repoName,
  forceMessage,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  tokens: Tokens;
  repoName: string;
  forceMessage: string | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (force: boolean) => void;
}) {
  return (
    <Overlay open={open} onClose={onClose} tokens={tokens} maxWidth={520}>
      <View style={{ gap: tokens.spacing[4], padding: tokens.spacing[4] }}>
        <DialogHeader
          title={forceMessage ? "共享 checkout 有本地改动" : "解绑共享仓库"}
          description={forceMessage ?? repoName}
          tokens={tokens}
          onClose={onClose}
          closeDisabled={busy}
        />
        <DialogSummary
          title={forceMessage ? "仍要解绑？" : "本地资产会保留"}
          description={
            forceMessage
              ? "仍要解绑将丢弃这些提交，但不会删除项目内资产。"
              : "只解除当前项目与共享仓库的绑定，并清除该仓库的同步关联；已经添加或修改的本地资产不会删除。"
          }
          tokens={tokens}
        />
        <View
          style={{
            flexDirection: "row",
            justifyContent: "flex-end",
            gap: tokens.spacing[2],
          }}
        >
          <Button tokens={tokens} variant="ghost" onPress={onClose}>
            取消
          </Button>
          <Button
            tokens={tokens}
            variant={forceMessage ? "destructive" : "default"}
            disabled={busy}
            onPress={() => onConfirm(Boolean(forceMessage))}
          >
            {forceMessage ? "仍要解绑" : "确认解绑"}
          </Button>
        </View>
      </View>
    </Overlay>
  );
}

function AssociationDialog({
  row,
  tokens,
  busy,
  onClose,
  onAdopt,
}: {
  row: AssetRelationshipRow | null;
  tokens: Tokens;
  busy: boolean;
  onClose: () => void;
  onAdopt: (mode: "preserve-local" | "use-remote") => void;
}) {
  return (
    <Overlay
      open={row !== null}
      onClose={onClose}
      tokens={tokens}
      maxWidth={520}
    >
      {row?.shared && row.local ? (
        <View style={{ gap: tokens.spacing[4], padding: tokens.spacing[4] }}>
          <DialogHeader
            title="关联已有本地资产"
            description={`${row.shared.name} 在共享仓库和本地同时存在`}
            tokens={tokens}
            onClose={onClose}
            closeDisabled={busy}
          />
          <DialogSummary
            title="推荐：保留本地并关联"
            description="不修改本地文件；建立关联后，可再选择上传本地版本。"
            tokens={tokens}
          />
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "flex-end",
              flexWrap: "wrap",
              gap: tokens.spacing[2],
            }}
          >
            <Button
              tokens={tokens}
              variant="ghost"
              onPress={() => onAdopt("use-remote")}
              disabled={busy}
              testID="shared-assets-adopt-remote"
            >
              使用共享版本（覆盖本地）
            </Button>
            <Button
              tokens={tokens}
              variant="default"
              onPress={() => onAdopt("preserve-local")}
              disabled={busy}
              testID="shared-assets-adopt-preserve"
            >
              保留本地并关联
            </Button>
          </View>
        </View>
      ) : null}
    </Overlay>
  );
}

function UnlinkDialog({
  rows,
  tokens,
  busy,
  onClose,
  onConfirm,
}: {
  rows: AssetRelationshipRow[];
  tokens: Tokens;
  busy: boolean;
  onClose: () => void;
  onConfirm: (deleteLocal: boolean) => void;
}) {
  const row = rows[0];
  const remoteDeleted = row?.syncStatus === "remote-deleted";
  return (
    <Overlay
      open={rows.length > 0}
      onClose={onClose}
      tokens={tokens}
      maxWidth={520}
    >
      {row?.shared ? (
        <View style={{ gap: tokens.spacing[4], padding: tokens.spacing[4] }}>
          <DialogHeader
            title={remoteDeleted ? "处理远端已删除的资产" : "移除共享关联"}
            description={
              remoteDeleted
                ? `共享仓库中已没有 ${row.shared.name}，请选择如何处理本地副本`
                : `请选择是否保留本地资产：${row.shared.name}`
            }
            tokens={tokens}
            onClose={onClose}
            closeDisabled={busy}
          />
          <DialogSummary
            title="推荐：保留本地资产"
            description="仅取消与共享仓库的同步关系；本地文件和本地修改都不会被删除。"
            warning={`删除本地会移除整个 ${KIND_LABELS[row.shared.kind]} 目录，包括尚未发布的修改，此操作不可撤销。`}
            tokens={tokens}
          />
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "flex-end",
              flexWrap: "wrap",
              gap: tokens.spacing[2],
            }}
          >
            <Button tokens={tokens} variant="ghost" onPress={onClose}>
              取消
            </Button>
            <Button
              tokens={tokens}
              variant="destructive"
              disabled={busy}
              onPress={() => onConfirm(true)}
            >
              移除关联并删除本地
            </Button>
            <Button
              tokens={tokens}
              variant="default"
              disabled={busy}
              onPress={() => onConfirm(false)}
              testID="shared-assets-unlink-confirm"
            >
              保留本地并移除关联
            </Button>
          </View>
        </View>
      ) : null}
    </Overlay>
  );
}

function BatchUnlinkDialog({
  rows,
  tokens,
  busy,
  onClose,
  onConfirm,
}: {
  rows: AssetRelationshipRow[];
  tokens: Tokens;
  busy: boolean;
  onClose: () => void;
  onConfirm: (deleteLocal: boolean) => void;
}) {
  const kind = rows[0]?.shared?.kind ?? "skill";
  return (
    <Overlay
      open={rows.length > 0}
      onClose={onClose}
      tokens={tokens}
      maxWidth={520}
    >
      <View style={{ gap: tokens.spacing[4], padding: tokens.spacing[4] }}>
        <DialogHeader
          title="批量移除关联"
          description={`${rows.length} 项共享 ${KIND_LABELS[kind]} 将解除与共享仓库的关联`}
          tokens={tokens}
          onClose={onClose}
          closeDisabled={busy}
        />
        <DialogSummary
          title="推荐：保留本地资产"
          description="仅取消与共享仓库的同步关系；本地文件和本地修改都不会被删除。"
          warning={`删除本地会移除这 ${rows.length} 项资产的本地文件或目录，包括尚未发布的修改，此操作无法撤销。`}
          tokens={tokens}
        />
        <Text
          style={{
            color: tokens.colors.foreground,
            fontSize: tokens.fontSize.sm,
          }}
        >
          逐项执行，结束后汇总成功与失败数量；失败项保持原状。
        </Text>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "flex-end",
            flexWrap: "wrap",
            gap: tokens.spacing[2],
          }}
        >
          <Button tokens={tokens} variant="ghost" onPress={onClose}>
            取消
          </Button>
          <Button
            tokens={tokens}
            variant="destructive"
            disabled={busy}
            onPress={() => onConfirm(true)}
          >
            移除关联并删除本地
          </Button>
          <Button
            tokens={tokens}
            variant="default"
            disabled={busy}
            onPress={() => onConfirm(false)}
            testID="shared-assets-batch-unlink-confirm"
          >
            保留本地并移除关联
          </Button>
        </View>
      </View>
    </Overlay>
  );
}

function PublishPreviewDialog({
  preview,
  tokens,
  busy,
  onClose,
  onCommit,
}: {
  preview: BatchPublishPreview | null;
  tokens: Tokens;
  busy: boolean;
  onClose: () => void;
  onCommit: () => void;
}) {
  const [diffFor, setDiffFor] = useState<string | null>(null);
  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        backgroundColor: tokens.colors.surfaceWorkspace,
      }}
    >
      {preview ? (
        <View style={{ flex: 1, minHeight: 0 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: tokens.spacing[3],
              paddingHorizontal: tokens.spacing[4],
              paddingVertical: tokens.spacing[4],
            }}
          >
            <View style={{ flexShrink: 1, minWidth: 0, gap: 2 }}>
              <Text
                style={{
                  color: tokens.colors.foreground,
                  fontSize: tokens.fontSize.lg,
                  fontWeight: tokens.fontWeight.semibold,
                }}
              >
                确认本次发布
              </Text>
              <Text
                style={{
                  color: tokens.colors.foregroundMuted,
                  fontSize: tokens.fontSize.sm,
                }}
              >
                只会提交下面选中的安全路径；任意一项校验失败时，整批都不会发布。
              </Text>
            </View>
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontFamily: tokens.fontFamily,
                fontSize: tokens.fontSize.sm,
              }}
            >
              基线 {preview.expectedRevision.slice(0, 8)}
            </Text>
          </View>
          <ScrollView
            style={{ flex: 1, minHeight: 0 }}
            contentContainerStyle={{
              gap: tokens.spacing[3],
              paddingHorizontal: tokens.spacing[4],
              paddingBottom: tokens.spacing[4],
            }}
          >
            {preview.items.map((item) => (
              <View
                key={item.assetId}
                style={{
                  gap: tokens.spacing[2],
                  borderRadius: tokens.radius.lg,
                  borderWidth: 1,
                  borderColor: tokens.colors.border,
                  backgroundColor: tokens.colors.surface1,
                  padding: tokens.spacing[3],
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: tokens.spacing[3],
                  }}
                >
                  <View style={{ flexShrink: 1, minWidth: 0, gap: 2 }}>
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: tokens.spacing[2],
                      }}
                    >
                      <Text
                        style={{
                          color: tokens.colors.foreground,
                          fontSize: tokens.fontSize.base,
                          fontWeight: tokens.fontWeight.semibold,
                        }}
                      >
                        {item.name}
                      </Text>
                      <Text
                        style={{
                          color: tokens.colors.foregroundMuted,
                          fontSize: tokens.fontSize.sm,
                          borderRadius: tokens.radius.full,
                          backgroundColor: tokens.colors.surface3,
                          paddingHorizontal: tokens.spacing[2],
                          paddingVertical: 2,
                        }}
                      >
                        {item.kind === "skill" ? "项目级" : "本地"}来源
                      </Text>
                    </View>
                    <Text
                      style={{
                        color: tokens.colors.foregroundMuted,
                        fontFamily: tokens.fontFamily,
                        fontSize: tokens.fontSize.sm,
                      }}
                      numberOfLines={1}
                    >
                      {item.targetPath}
                    </Text>
                  </View>
                  <Text
                    style={{
                      color:
                        item.state === "ineligible" || item.state === "skipped"
                          ? tokens.colors.danger
                          : tokens.colors.accent,
                      fontSize: tokens.fontSize.sm,
                      fontWeight: tokens.fontWeight.semibold,
                    }}
                  >
                    {item.state === "ineligible" || item.state === "skipped"
                      ? "无法发布"
                      : item.create
                        ? "新增"
                        : "更新"}
                  </Text>
                </View>
                <Text
                  style={{
                    color: tokens.colors.foregroundMuted,
                    fontSize: tokens.fontSize.sm,
                  }}
                >
                  {item.files.length} 个文件 ·{" "}
                  {formatBytes(
                    item.files.reduce((sum, file) => sum + file.size, 0),
                  )}
                </Text>
                {item.reasons.map((reason) => (
                  <Text
                    key={reason.code}
                    style={{
                      color: tokens.colors.danger,
                      fontSize: tokens.fontSize.sm,
                    }}
                  >
                    注意：{reason.message}
                  </Text>
                ))}
                <View style={{ gap: 2 }}>
                  {item.files.slice(0, 6).map((file) => (
                    <Text
                      key={file.path}
                      style={{
                        color: tokens.colors.foregroundMuted,
                        fontFamily: tokens.fontFamily,
                        fontSize: tokens.fontSize.sm,
                      }}
                      numberOfLines={1}
                    >
                      {file.path} · {formatBytes(file.size)}
                    </Text>
                  ))}
                  {item.files.length > 6 ? (
                    <Text
                      style={{
                        color: tokens.colors.foregroundMuted,
                        fontFamily: tokens.fontFamily,
                        fontSize: tokens.fontSize.sm,
                      }}
                    >
                      另有 {item.files.length - 6} 个文件
                    </Text>
                  ) : null}
                </View>
                <View
                  style={{ flexDirection: "row", justifyContent: "flex-end" }}
                >
                  <Button
                    tokens={tokens}
                    size="xs"
                    variant="ghost"
                    onPress={() =>
                      setDiffFor(diffFor === item.assetId ? null : item.assetId)
                    }
                  >
                    查看差异
                  </Button>
                </View>
                {diffFor === item.assetId ? (
                  <Mono tokens={tokens} numberOfLines={12}>
                    {item.diff || "(无差异)"}
                  </Mono>
                ) : null}
              </View>
            ))}
            {preview.skipped.map((entry) => (
              <Text
                key={entry.assetId}
                style={{
                  color: tokens.colors.warning,
                  fontSize: tokens.fontSize.sm,
                }}
              >
                跳过 {entry.assetId}：{entry.reason}
              </Text>
            ))}
          </ScrollView>
          <View
            style={{
              minHeight: 64,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: tokens.spacing[3],
              borderTopWidth: 1,
              borderTopColor: tokens.colors.border,
              backgroundColor: tokens.colors.surface1,
              paddingHorizontal: tokens.spacing[4],
              paddingVertical: tokens.spacing[3],
            }}
          >
            <Button
              tokens={tokens}
              variant="ghost"
              disabled={busy}
              onPress={onClose}
            >
              返回选择
            </Button>
            <Button
              tokens={tokens}
              variant="default"
              icon="UploadCloud"
              onPress={onCommit}
              disabled={busy}
              testID="shared-assets-publish-confirm"
            >
              {busy ? "发布中…" : `确认发布 ${preview.items.length} 项`}
            </Button>
          </View>
        </View>
      ) : (
        <View style={{ padding: tokens.spacing[6] }}>
          <Spinner tokens={tokens} />
        </View>
      )}
    </View>
  );
}

function DiffDialog({
  dialog,
  tokens,
  onClose,
}: {
  dialog: { title: string; result: AssetDiffResult | null } | null;
  tokens: Tokens;
  onClose: () => void;
}) {
  return (
    <Overlay
      open={dialog !== null}
      onClose={onClose}
      tokens={tokens}
      maxWidth={940}
      height="86%"
      width="96%"
    >
      <View
        style={{
          flex: 1,
          minHeight: 0,
          backgroundColor: tokens.colors.surface1,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            gap: tokens.spacing[3],
            borderBottomWidth: 1,
            borderBottomColor: tokens.colors.border,
            paddingHorizontal: tokens.spacing[4],
            paddingVertical: tokens.spacing[3],
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text
              style={{
                color: tokens.colors.foreground,
                fontSize: tokens.fontSize.lg,
                fontWeight: tokens.fontWeight.semibold,
              }}
            >
              {dialog?.title ?? "差异"}
            </Text>
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
              }}
            >
              共享仓库版本 → 本地待发布版本
            </Text>
          </View>
          <Button
            tokens={tokens}
            size="xs"
            variant="ghost"
            onPress={onClose}
            accessibilityLabel="关闭差异"
          >
            <Icon name="X" size={16} color={tokens.colors.foregroundMuted} />
          </Button>
        </View>
        {dialog?.result ? (
          dialog.result.kind === "binary" ? (
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
                padding: tokens.spacing[4],
              }}
            >
              二进制文件，仅支持覆盖或保留。
            </Text>
          ) : (
            <ScrollView
              style={{ flex: 1, minHeight: 0 }}
              contentContainerStyle={{
                gap: tokens.spacing[3],
                padding: tokens.spacing[4],
              }}
            >
              <DiffPane
                title="共享 → 本地"
                diff={dialog.result.localDiff}
                tokens={tokens}
              />
              <DiffPane
                title="基线 → 共享"
                diff={dialog.result.remoteDiff}
                tokens={tokens}
              />
            </ScrollView>
          )
        ) : (
          <Spinner tokens={tokens} />
        )}
        {dialog?.result ? (
          <View
            style={{
              flexDirection: "row",
              justifyContent: "flex-end",
              borderTopWidth: 1,
              borderTopColor: tokens.colors.border,
              paddingHorizontal: tokens.spacing[4],
              paddingVertical: tokens.spacing[3],
            }}
          >
            <Button tokens={tokens} onPress={onClose}>
              完成
            </Button>
          </View>
        ) : null}
      </View>
    </Overlay>
  );
}

function DiffPane({
  title,
  diff,
  tokens,
}: {
  title: string;
  diff: string;
  tokens: Tokens;
}) {
  return (
    <View
      style={{
        overflow: "hidden",
        borderRadius: tokens.radius.md,
        borderWidth: 1,
        borderColor: tokens.colors.border,
        backgroundColor: tokens.colors.surface2,
      }}
    >
      <View
        style={{
          borderBottomWidth: 1,
          borderBottomColor: tokens.colors.border,
          backgroundColor: tokens.colors.surface3,
          paddingHorizontal: tokens.spacing[3],
          paddingVertical: tokens.spacing[2],
        }}
      >
        <Text
          style={{
            color: tokens.colors.foregroundMuted,
            fontSize: tokens.fontSize.sm,
            fontWeight: tokens.fontWeight.semibold,
          }}
        >
          {title}
        </Text>
      </View>
      <ScrollView horizontal>
        <Text
          style={{
            color: tokens.colors.foreground,
            fontFamily: tokens.fontFamily,
            fontSize: tokens.fontSize.sm,
            padding: tokens.spacing[3],
          }}
        >
          {diff || "(无变化)"}
        </Text>
      </ScrollView>
    </View>
  );
}

function MergeCodePane({
  title,
  content,
  tokens,
}: {
  title: string;
  content: string;
  tokens: Tokens;
}) {
  return (
    <View
      style={{
        flex: 1,
        minWidth: 0,
        overflow: "hidden",
        borderWidth: 1,
        borderColor: tokens.colors.border,
        borderRadius: tokens.radius.md,
        backgroundColor: tokens.colors.surface2,
      }}
    >
      <View
        style={{
          borderBottomWidth: 1,
          borderBottomColor: tokens.colors.border,
          backgroundColor: tokens.colors.surface3,
          paddingHorizontal: tokens.spacing[2],
          paddingVertical: tokens.spacing[1],
        }}
      >
        <Text
          style={{
            color: tokens.colors.foregroundMuted,
            fontSize: tokens.fontSize.sm,
            fontWeight: "600",
          }}
        >
          {title}
        </Text>
      </View>
      <ScrollView horizontal>
        <Text
          style={{
            color: tokens.colors.foreground,
            fontFamily: tokens.fontFamily,
            fontSize: tokens.fontSize.sm,
            padding: tokens.spacing[2],
          }}
        >
          {content}
        </Text>
      </ScrollView>
    </View>
  );
}

function MergeDialog({
  dialog,
  tokens,
  busy,
  onClose,
  onApply,
}: {
  dialog: {
    assetId: string;
    path?: string;
    provider?: string;
    preview: MergePreviewResult | null;
  } | null;
  tokens: Tokens;
  busy: boolean;
  onClose: () => void;
  onApply: (resolutions: MergeResolution[]) => void;
}) {
  const [choices, setChoices] = useState<Record<string, MergeResolution>>({});
  const preview = dialog?.preview;
  const unresolved = (preview?.conflicts ?? []).some(
    (conflict) => !choices[conflict.id],
  );
  return (
    <Overlay
      open={dialog !== null}
      onClose={onClose}
      tokens={tokens}
      maxWidth={1380}
      height="88%"
      width="96%"
    >
      <View
        style={{
          flex: 1,
          minHeight: 0,
          backgroundColor: tokens.colors.surface1,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            gap: tokens.spacing[3],
            borderBottomWidth: 1,
            borderBottomColor: tokens.colors.border,
            paddingHorizontal: tokens.spacing[4],
            paddingVertical: tokens.spacing[3],
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text
              style={{
                color: tokens.colors.foreground,
                fontSize: tokens.fontSize.lg,
                fontWeight: tokens.fontWeight.semibold,
              }}
            >
              合并{" "}
              {dialog?.assetId.split("/").filter(Boolean).pop() ?? "共享资产"}
            </Text>
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
              }}
            >
              共同基线 + 本地修改 +
              共享仓库修改；确认后只更新本地，不会自动发布。
            </Text>
          </View>
          <Button
            tokens={tokens}
            size="xs"
            variant="ghost"
            onPress={onClose}
            accessibilityLabel="关闭合并"
          >
            <Icon name="X" size={16} color={tokens.colors.foregroundMuted} />
          </Button>
        </View>
        {preview ? (
          <>
            <View style={{ flex: 1, minHeight: 0, flexDirection: "row" }}>
              <View
                style={{
                  width: 210,
                  flexShrink: 0,
                  borderRightWidth: 1,
                  borderRightColor: tokens.colors.border,
                  backgroundColor: tokens.colors.surface2,
                  padding: tokens.spacing[3],
                  gap: tokens.spacing[2],
                }}
              >
                <Text
                  style={{
                    color: tokens.colors.foregroundMuted,
                    fontSize: tokens.fontSize.sm,
                  }}
                >
                  合并文件 · 1
                </Text>
                <View
                  style={{
                    borderRadius: tokens.radius.md,
                    backgroundColor: tokens.colors.surface3,
                    paddingHorizontal: tokens.spacing[2],
                    paddingVertical: tokens.spacing[2],
                    gap: 2,
                  }}
                >
                  <Text
                    style={{
                      color: tokens.colors.foreground,
                      fontSize: tokens.fontSize.sm,
                    }}
                    numberOfLines={2}
                  >
                    {preview.repositoryPath.split("/").pop() ??
                      preview.repositoryPath}
                  </Text>
                  <Text
                    style={{
                      color: tokens.colors.foregroundMuted,
                      fontSize: tokens.fontSize.sm,
                    }}
                  >
                    {preview.conflicts.length} 个冲突
                  </Text>
                </View>
              </View>
              <View
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: tokens.spacing[4],
                  gap: tokens.spacing[3],
                }}
              >
                <Text
                  style={{
                    color: tokens.colors.foregroundMuted,
                    fontSize: tokens.fontSize.sm,
                  }}
                >
                  {preview.conflicts.length === 0
                    ? "无冲突，可直接应用自动合并结果。"
                    : `${preview.conflicts.length} 个冲突块，未全部选择前不能保存。`}
                </Text>
                <ScrollView
                  style={{ flex: 1, minHeight: 0 }}
                  contentContainerStyle={{ gap: tokens.spacing[3] }}
                >
                  {preview.conflicts.map((conflict) => {
                    const current = choices[conflict.id];
                    return (
                      <View
                        key={conflict.id}
                        style={{
                          overflow: "hidden",
                          gap: tokens.spacing[2],
                          borderWidth: 1,
                          borderColor: "rgba(248, 81, 73, 0.42)",
                          borderRadius: tokens.radius.lg,
                          backgroundColor: tokens.colors.surface1,
                          paddingBottom: tokens.spacing[2],
                        }}
                      >
                        <View
                          style={{
                            flexDirection: "row",
                            alignItems: "flex-start",
                            justifyContent: "space-between",
                            gap: tokens.spacing[3],
                            borderBottomWidth: 1,
                            borderBottomColor: tokens.colors.border,
                            backgroundColor: "rgba(248, 81, 73, 0.08)",
                            padding: tokens.spacing[3],
                          }}
                        >
                          <Text
                            style={{
                              color: tokens.colors.danger,
                              fontSize: tokens.fontSize.sm,
                              fontWeight: "700",
                            }}
                          >
                            冲突 {conflict.id}
                          </Text>
                          <Text
                            style={{
                              color: tokens.colors.foregroundMuted,
                              fontSize: tokens.fontSize.sm,
                            }}
                          >
                            本地 / 共享
                          </Text>
                        </View>
                        <View
                          style={{
                            flexDirection: "row",
                            alignItems: "stretch",
                            gap: tokens.spacing[2],
                            paddingHorizontal: tokens.spacing[2],
                          }}
                        >
                          <MergeCodePane
                            title="本地"
                            content={conflict.local}
                            tokens={tokens}
                          />
                          <MergeCodePane
                            title="共享"
                            content={conflict.remote}
                            tokens={tokens}
                          />
                        </View>
                        <View
                          style={{
                            flexDirection: "row",
                            gap: 6,
                            flexWrap: "wrap",
                            paddingHorizontal: tokens.spacing[2],
                          }}
                        >
                          {(["local", "remote", "both", "custom"] as const).map(
                            (choice) => (
                              <Button
                                key={choice}
                                tokens={tokens}
                                size="xs"
                                variant={
                                  current?.choice === choice
                                    ? "default"
                                    : "secondary"
                                }
                                onPress={() =>
                                  setChoices((value) => ({
                                    ...value,
                                    [conflict.id]: {
                                      conflictId: conflict.id,
                                      choice,
                                      content:
                                        choice === "custom"
                                          ? (value[conflict.id]?.content ??
                                            `${conflict.local}\n${conflict.remote}`)
                                          : undefined,
                                    },
                                  }))
                                }
                                testID={`shared-assets-conflict-${conflict.id}-${choice}`}
                              >
                                {choice === "local"
                                  ? "采用本地"
                                  : choice === "remote"
                                    ? "采用共享"
                                    : choice === "both"
                                      ? "两者保留"
                                      : "自定义"}
                              </Button>
                            ),
                          )}
                        </View>
                        {current?.choice === "custom" ? (
                          <TextField
                            value={current.content ?? ""}
                            onChangeText={(content) =>
                              setChoices((value) => ({
                                ...value,
                                [conflict.id]: {
                                  conflictId: conflict.id,
                                  choice: "custom",
                                  content,
                                },
                              }))
                            }
                            multiline
                            tokens={tokens}
                          />
                        ) : null}
                      </View>
                    );
                  })}
                </ScrollView>
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "flex-end",
                    gap: tokens.spacing[2],
                    borderTopWidth: 1,
                    borderTopColor: tokens.colors.border,
                    paddingTop: tokens.spacing[3],
                  }}
                >
                  <Button
                    tokens={tokens}
                    variant="default"
                    disabled={busy || unresolved}
                    onPress={() =>
                      onApply(
                        preview.conflicts.map(
                          (conflict) =>
                            choices[conflict.id] ?? {
                              conflictId: conflict.id,
                              choice: "local",
                            },
                        ),
                      )
                    }
                    testID="shared-assets-merge-apply"
                  >
                    {busy
                      ? "合并中…"
                      : unresolved
                        ? "还有冲突未解决"
                        : "保存合并结果"}
                  </Button>
                  <Button tokens={tokens} variant="ghost" onPress={onClose}>
                    关闭
                  </Button>
                </View>
              </View>
            </View>
          </>
        ) : (
          <Spinner tokens={tokens} />
        )}
      </View>
    </Overlay>
  );
}

function IgnoreRulesDialog({
  open,
  tokens,
  projectId,
  drift,
  busy,
  onClose,
}: {
  open: boolean;
  tokens: Tokens;
  projectId: string;
  drift: DriftItem[];
  busy: boolean;
  onClose: () => void;
}) {
  const ignoreGet = useRpc(ignoreRulesGetRpc);
  const ignoreSet = useRpc(ignoreRulesSetRpc);
  const [raw, setRaw] = useState("");
  const [persisted, setPersisted] = useState("");
  const [errors, setErrors] = useState<IgnoreRulesResult["errors"]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const ignored = drift.filter((item) => item.ignored);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void ignoreGet({ projectId })
      .then(unwrap)
      .then((value) => {
        if (cancelled) return;
        setRaw(value.raw);
        setPersisted(value.raw);
        setErrors(value.errors);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ignoreGet, open, projectId]);
  return (
    <Overlay
      open={open}
      onClose={onClose}
      tokens={tokens}
      maxWidth={640}
      height={560}
      width="96%"
    >
      <View
        style={{
          flex: 1,
          minHeight: 0,
          backgroundColor: tokens.colors.surface1,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottomWidth: 1,
            borderBottomColor: tokens.colors.border,
            paddingHorizontal: tokens.spacing[4],
            paddingVertical: tokens.spacing[3],
          }}
        >
          <Text
            style={{
              color: tokens.colors.foreground,
              fontSize: tokens.fontSize.lg,
              fontWeight: tokens.fontWeight.semibold,
            }}
          >
            忽略规则
          </Text>
          <Button
            tokens={tokens}
            size="xs"
            variant="ghost"
            onPress={onClose}
            accessibilityLabel="关闭忽略规则"
          >
            <Icon name="X" size={16} color={tokens.colors.foregroundMuted} />
          </Button>
        </View>
        <ScrollView
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{
            gap: tokens.spacing[3],
            padding: tokens.spacing[4],
          }}
        >
          <Text
            style={{
              color: tokens.colors.foregroundMuted,
              fontSize: tokens.fontSize.sm,
            }}
          >
            每行一条规则，文件规则使用 .gitignore 子集：`__pycache__/`、`dir/`
            匹配任意层级的目录，`*.pyc` 匹配任意层级的文件，`/dist`
            只匹配资产根目录，`!name` 表示例外；不支持 `**`。也支持
            `path:`、`kind:`、`asset:` 资产级规则。命中的文件不会出现在差异、
            发布清单或提交中。
          </Text>
          <TextField
            value={raw}
            onChangeText={setRaw}
            multiline
            tokens={tokens}
            minHeight={320}
            testID="shared-assets-ignore-dialog-input"
          />
          {errors.map((entry) => (
            <Text
              key={`${entry.line}-${entry.message}`}
              style={{
                color: tokens.colors.danger,
                fontSize: tokens.fontSize.sm,
              }}
            >
              第 {entry.line} 行：{entry.message}
            </Text>
          ))}
          {notice ? (
            <Text
              style={{
                color: tokens.colors.success,
                fontSize: tokens.fontSize.sm,
              }}
            >
              {notice}
            </Text>
          ) : null}
          {ignored.length > 0 ? (
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.sm,
              }}
            >
              项目级已忽略 · {ignored.length}（在详情页「已忽略 N
              项提醒」中恢复）
            </Text>
          ) : null}
          <Text
            style={{
              color: tokens.colors.foregroundMuted,
              fontSize: tokens.fontSize.sm,
            }}
          >
            凭据文件（.env、私钥等）由内置的安全过滤拦截，不在此列表中，也无法关闭。
          </Text>
        </ScrollView>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "flex-end",
            gap: tokens.spacing[2],
            borderTopWidth: 1,
            borderTopColor: tokens.colors.border,
            paddingHorizontal: tokens.spacing[4],
            paddingVertical: tokens.spacing[3],
          }}
        >
          <Button tokens={tokens} size="sm" variant="ghost" onPress={onClose}>
            取消
          </Button>
          <Button
            tokens={tokens}
            size="sm"
            variant="ghost"
            disabled={raw === persisted || busy}
            onPress={() => setRaw(persisted)}
          >
            撤销改动
          </Button>
          <Button
            tokens={tokens}
            size="sm"
            variant="default"
            disabled={busy}
            onPress={() => {
              void ignoreSet({ projectId, raw })
                .then(unwrap)
                .then((value) => {
                  setErrors(value.errors);
                  setRaw(value.raw);
                  setPersisted(value.raw);
                  setNotice("忽略规则已保存");
                })
                .catch(() => setNotice("保存失败"));
            }}
            testID="shared-asset-ignore-rules-save"
          >
            保存
          </Button>
        </View>
      </View>
    </Overlay>
  );
}
