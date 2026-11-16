import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import type {
  AssetDiffResult,
  AssetKind,
  AssetReadResult,
  AssetRelationshipRow,
  BatchPublishPreview,
  BatchPublishResult,
  Binding,
  DriftItem,
  IgnoreRulesResult,
  LocalAssetSummary,
  MergePreviewResult,
  MergeResolution,
  MigrationReport,
  ProjectAttentionItem,
  ProjectSummary,
  ProviderStatus,
  RelationshipListResult,
  UnlinkResult,
} from "../shared/core/types";
import type { RpcEnvelope } from "../shared/core/errors";
import {
  assetReadRpc,
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
  migrateLegacyRpc,
  projectsListRpc,
  providersListRpc,
  relationshipsAdoptRpc,
  relationshipsBatchUnlinkRpc,
  relationshipsListRpc,
  relationshipsReadLocalRpc,
  relationshipsUnlinkRpc,
  skillsSetEnabledRpc,
  statusRpc,
  syncRpc,
  unbindRpc,
  workspacePullRpc,
} from "../shared/contracts";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmInline,
  Dialog,
  Divider,
  Empty,
  Field,
  IconButton,
  Muted,
  Mono,
  Panel,
  SectionTitle,
  Spinner,
  TabButton,
  TabRail,
  TextField,
} from "./ui/components";
import { createTokens, type Tokens } from "./ui/tokens";

type Tab = "skills" | "prompt" | "knowledge" | "docs" | "drift" | "settings";

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
  { id: "drift", label: "Drift" },
  { id: "settings", label: "设置" },
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

const DRIFT_TONES: Record<
  ProjectAttentionItem["reason"],
  "ok" | "warn" | "danger" | "muted"
> = {
  diverged: "danger",
  "local-update": "warn",
  "remote-update": "warn",
  "remote-deleted": "danger",
  "unpublished-local": "muted",
  synced: "ok",
  missing: "muted",
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

function shortRevision(value: string | null | undefined): string {
  return value ? value.slice(0, 8) : "—";
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
        paddingHorizontal: tokens.spacing[3],
        paddingVertical: tokens.spacing[2],
        gap: 2,
      }}
    >
      <Text
        style={{
          color: tokens.colors.foreground,
          fontSize: tokens.fontSize["2xl"],
          fontWeight: "500",
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
        contentContainerStyle={{
          padding: compact ? 16 : 28,
          paddingBottom: 48,
          gap: 16,
        }}
      >
        <View
          style={{
            flexDirection: compact ? "column" : "row",
            alignItems: compact ? "stretch" : "flex-start",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <View style={{ flexShrink: 1, gap: 4 }}>
            <Text
              style={{
                color: tokens.colors.foreground,
                fontSize: compact ? 22 : 26,
                fontWeight: "600",
              }}
            >
              按项目管理的团队资产
            </Text>
            <Muted tokens={tokens}>
              Workflow、Skill、SYSTEM Prompt
              与经验库以项目为作用域；同一项目下的工作区共用一套共享库。
            </Muted>
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
            gap: compact ? 8 : 12,
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
                flexDirection: compact ? "column" : "row",
                alignItems: compact ? "stretch" : "center",
                gap: 12,
                borderWidth: 1,
                borderColor: tokens.colors.border,
                backgroundColor: tokens.colors.surface1,
                borderRadius: tokens.radius.xl,
                padding: compact ? 12 : 16,
              }}
              testID={`shared-assets-project-${project.projectId}`}
            >
              <View
                style={{
                  width: compact ? 32 : 38,
                  height: compact ? 32 : 38,
                  borderRadius: tokens.radius.lg,
                  backgroundColor: `${tokens.colors.accent}18`,
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
              <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
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
                      fontSize: tokens.fontSize["2xl"],
                      fontWeight: "600",
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
                          ? tokens.colors.danger
                          : tokens.colors.accent,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                      accessibilityLabel={`${attention.length} 项需要处理`}
                      testID={`shared-assets-attention-${project.projectId}`}
                    >
                      <Text
                        style={{
                          color: tokens.colors.accentForeground,
                          fontSize: tokens.fontSize.xs,
                          fontWeight: "600",
                        }}
                      >
                        {attention.length}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Muted tokens={tokens}>{project.rootPath}</Muted>
                <Text
                  style={{
                    color: tokens.colors.foreground,
                    fontSize: tokens.fontSize.sm,
                  }}
                >
                  {syncSummary(project)}
                  {project.repoUrl ? ` · ${project.repoUrl}` : ""}
                </Text>
                <View
                  style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}
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
                          color: tokens.colors.foregroundMuted,
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
    <View
      style={{
        marginTop: 4,
        borderTopWidth: 1,
        borderTopColor: tokens.colors.border,
        paddingTop: 6,
        gap: 2,
      }}
    >
      {items.map((item) => {
        const key = attentionKey(item);
        return (
          <View
            key={key}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingVertical: 3,
            }}
          >
            <View
              style={{
                width: 7,
                height: 7,
                borderRadius: 4,
                backgroundColor:
                  item.reason === "diverged"
                    ? tokens.colors.danger
                    : item.reason === "remote-update"
                      ? tokens.colors.accent
                      : tokens.colors.warning,
              }}
            />
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.xs,
                width: 84,
              }}
              numberOfLines={1}
            >
              {KIND_LABELS[item.kind]}
            </Text>
            {!compact && item.provider ? (
              <Text
                style={{
                  color: tokens.colors.foregroundMuted,
                  fontSize: tokens.fontSize.xs,
                  width: 64,
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
                flex: 1,
                minWidth: 0,
              }}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {item.name}
            </Text>
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: tokens.fontSize.xs,
              }}
            >
              {ATTENTION_LABELS[item.reason]}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={busyKey === key}
              onPress={() => onToggle(item)}
              testID={`shared-assets-attention-ignore-${key}`}
            >
              <Text
                style={{
                  color: tokens.colors.accent,
                  fontSize: tokens.fontSize.xs,
                }}
              >
                {restore ? "恢复" : "忽略"}
              </Text>
            </Pressable>
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
  const relationshipsReadLocalCall = useRpc(relationshipsReadLocalRpc);
  const relationshipsAdoptCall = useRpc(relationshipsAdoptRpc);
  const relationshipsUnlinkCall = useRpc(relationshipsUnlinkRpc);
  const relationshipsBatchUnlinkCall = useRpc(relationshipsBatchUnlinkRpc);
  const skillsSetEnabledCall = useRpc(skillsSetEnabledRpc);
  const instructionsSetCall = useRpc(instructionsSetEnabledRpc);
  const assetReadCall = useRpc(assetReadRpc);
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
  const [readDialog, setReadDialog] = useState<{
    title: string;
    result: AssetReadResult;
  } | null>(null);

  const workspaceId = project.workspaceId;
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
          provider: providerValue,
        }),
      ) as MergePreviewResult;
      setMergeDialog({
        assetId: row.shared.assetId,
        provider: providerValue,
        preview: result,
      });
    } catch (value) {
      setMergeDialog(null);
      setError(messageOf(value));
    }
  };

  const openDriftDiff = async (item: DriftItem) => {
    if (!workspaceId) return;
    setDiffDialog({ title: `${item.name} · 共享与本地差异`, result: null });
    try {
      const result = unwrap(
        await diffCall({
          projectId: project.projectId,
          workspaceId,
          assetId: item.assetId,
          path: item.files.find((file) => file.status !== "synced")?.path,
          provider: item.provider ?? undefined,
        }),
      ) as AssetDiffResult;
      setDiffDialog({ title: `${item.name} · 共享与本地差异`, result });
    } catch (value) {
      setDiffDialog(null);
      setError(messageOf(value));
    }
  };

  const openDriftMerge = async (item: DriftItem) => {
    if (!workspaceId) return;
    setMergeDialog({
      assetId: item.assetId,
      provider: item.provider ?? undefined,
      preview: null,
    });
    try {
      const result = unwrap(
        await mergePreviewCall({
          projectId: project.projectId,
          workspaceId,
          assetId: item.assetId,
          path: item.files.find((file) => file.status !== "synced")?.path,
          provider: item.provider ?? undefined,
        }),
      ) as MergePreviewResult;
      setMergeDialog({
        assetId: item.assetId,
        provider: item.provider ?? undefined,
        preview: result,
      });
    } catch (value) {
      setMergeDialog(null);
      setError(messageOf(value));
    }
  };

  const resolveDrift = async (item: DriftItem, action: "overwrite" | "keep") =>
    run(action, async () => {
      if (!workspaceId) throw new Error("该项目还没有 Workspace");
      unwrap(
        await driftResolveCall({
          projectId: project.projectId,
          workspaceId,
          assetId: item.assetId,
          path: null,
          provider: item.provider ?? undefined,
          action,
        }),
      );
      setNotice(
        action === "overwrite"
          ? "已用共享版本覆盖本地"
          : "已保留本地并建立新基线",
      );
    });

  const readAssetFile = async (row: AssetRelationshipRow, path?: string) => {
    if (!row.shared) return;
    try {
      const result = unwrap(
        await assetReadCall({
          projectId: project.projectId,
          assetId: row.shared.assetId,
          path,
        }),
      ) as AssetReadResult;
      setReadDialog({ title: row.shared.name, result });
    } catch (value) {
      setError(messageOf(value));
    }
  };

  const readLocalAssetFile = async (
    row: AssetRelationshipRow,
    path?: string,
  ) => {
    if (!row.local || !workspaceId) return;
    try {
      const result = unwrap(
        await relationshipsReadLocalCall({
          projectId: project.projectId,
          workspaceId,
          kind: row.local.kind,
          provider: row.local.provider,
          localAssetId: row.local.assetId,
          path,
        }),
      ) as AssetReadResult;
      setReadDialog({ title: row.local.name, result });
    } catch (value) {
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
      };
      if (result.errors.length > 0) {
        setError(result.errors.map((entry) => entry.message).join("；"));
      }
      setNotice(
        result.kept.length > 0
          ? `已保留本地内容：${result.kept.map((entry) => entry.targetPath).join("，")}`
          : enabled
            ? "已添加到本地"
            : "已移除本地关联",
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
      unwrap(
        await relationshipsAdoptCall({
          projectId: project.projectId,
          workspaceId,
          kind: row.shared!.kind,
          provider: row.local!.provider,
          assetId: row.shared!.assetId,
          localAssetId: row.local!.assetId,
          mode,
        }),
      );
      setAssociation(null);
      setNotice(
        mode === "preserve-local"
          ? `${row.shared!.name} 已关联，保留本地版本`
          : `${row.shared!.name} 已关联并使用共享版本`,
      );
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
      setNotice(
        `批量解除关联：成功 ${result.items.length} 项，失败 ${result.failed.length} 项`,
      );
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

  const skillProviders = providers.filter((entry) => entry.skillRoot);
  const promptProviders = providers.filter(
    (entry) => entry.instructionEntrypoint,
  );
  const activeProviders = kind === "prompt" ? promptProviders : skillProviders;
  const allRows = relationships?.rows ?? [];
  const batchRows = allRows.filter((row) => batchSelected.has(row.id));
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
    (row) => row.local !== null || row.shared !== null,
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
          gap: 12,
          paddingHorizontal: compact ? 12 : 28,
          paddingVertical: compact ? 8 : 10,
          borderBottomWidth: 1,
          borderBottomColor: tokens.colors.border,
          flexWrap: "wrap",
        }}
      >
        <Button
          tokens={tokens}
          size="xs"
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
          }}
          numberOfLines={compact ? 1 : undefined}
          ellipsizeMode="middle"
        >
          {project.rootPath}
          {project.workspaceName
            ? ` · 作用域工作区：${project.workspaceName}`
            : " · 该项目暂无工作区"}
        </Text>
        <View style={{ flex: 1 }} />
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

      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{
          padding: compact ? 16 : 28,
          paddingBottom: kind ? 112 : 48,
          gap: 16,
        }}
      >
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

        <Panel tokens={tokens}>
          <View style={{ flexDirection: "row", gap: 12 }}>
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: tokens.radius.lg,
                backgroundColor: `${tokens.colors.accent}18`,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="LibraryBig" size={20} color={tokens.colors.accent} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                style={{
                  color: tokens.colors.foreground,
                  fontSize: tokens.fontSize.lg,
                  fontWeight: "600",
                }}
              >
                共享资产库
              </Text>
              {compact ? null : (
                <Muted tokens={tokens}>
                  使用团队共享 Skill、Provider SYSTEM Prompt
                  与经验库，也可选择本地资产发布给团队
                </Muted>
              )}
            </View>
          </View>
        </Panel>

        {configuring || !project.bound ? (
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
        ) : (
          <OverviewCard
            tokens={tokens}
            compact={compact}
            project={project}
            binding={status}
            busy={busy}
            confirmUnbind={confirmUnbind}
            forceUnbind={forceUnbind}
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
            onRefresh={() => {
              reload();
              onChanged();
              setNotice("已刷新");
            }}
            onRebind={() => setConfiguring(true)}
            onRequestUnbind={() => setConfirmUnbind(true)}
            onCancelUnbind={() => setConfirmUnbind(false)}
            onUnbind={(force) =>
              run("unbind", async () => {
                try {
                  unwrap(
                    await unbindCall({
                      projectId: project.projectId,
                      force,
                    }),
                  );
                  setConfirmUnbind(false);
                  setForceUnbind(null);
                  setNotice("已解绑共享仓库，本地资产均已保留");
                } catch (value) {
                  if (messageOf(value).includes("E_LOCAL_CHANGES")) {
                    setForceUnbind(messageOf(value));
                    setConfirmUnbind(false);
                    return;
                  }
                  throw value;
                }
              })
            }
          />
        )}

        {project.bound ? (
          <>
            {!workspaceId ? (
              <Alert
                tone="warning"
                title="该项目还没有 Workspace"
                description="绑定可用，但投影、同步与发布需要至少一个 Workspace。请先在侧边栏创建一个工作区。"
                tokens={tokens}
              />
            ) : null}
            <TabRail>
              {TABS.map((entry) => (
                <TabButton
                  key={entry.id}
                  active={tab === entry.id}
                  label={entry.label}
                  count={
                    entry.id === "drift"
                      ? drift.filter(
                          (item) => item.status !== "synced" && !item.ignored,
                        ).length
                      : 0
                  }
                  onPress={() => setTab(entry.id)}
                  tokens={tokens}
                  testID={`shared-assets-tab-${entry.id}`}
                />
              ))}
            </TabRail>

            {ignoredForView.length > 0 ? (
              <View style={{ gap: 4 }}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setShowIgnored((value) => !value)}
                  style={{ alignSelf: "flex-start" }}
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
                      borderWidth: 1,
                      borderColor: tokens.colors.border,
                      borderRadius: tokens.radius.lg,
                      backgroundColor: tokens.colors.surface1,
                      paddingHorizontal: tokens.spacing[3],
                      paddingVertical: tokens.spacing[2],
                      gap: 4,
                    }}
                  >
                    {ignoredForView.map((item) => (
                      <View
                        key={`${item.assetId}/${item.provider ?? ""}`}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <Text
                          style={{
                            color: tokens.colors.foreground,
                            fontSize: tokens.fontSize.sm,
                            flex: 1,
                            minWidth: 0,
                          }}
                          numberOfLines={1}
                          ellipsizeMode="middle"
                        >
                          {item.name}
                        </Text>
                        <Muted tokens={tokens}>
                          {KIND_LABELS[item.kind]}
                          {item.provider ? ` · ${item.provider}` : ""}
                        </Muted>
                        <Button
                          tokens={tokens}
                          size="xs"
                          variant="ghost"
                          onPress={() => void ignoreItem(item, false)}
                        >
                          恢复提醒
                        </Button>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}

            {kind && activeProviders.length > 0 ? (
              <TabRail>
                {activeProviders.map((entry) => (
                  <TabButton
                    key={entry.id}
                    active={provider === entry.id}
                    label={entry.label}
                    onPress={() => setProvider(entry.id)}
                    tokens={tokens}
                    testID={`shared-assets-provider-${entry.id}`}
                  />
                ))}
              </TabRail>
            ) : null}

            {tab === "skills" ||
            tab === "prompt" ||
            tab === "knowledge" ||
            tab === "docs" ? (
              <RelationshipView
                tokens={tokens}
                compact={compact}
                kind={kind!}
                result={relationships}
                busy={busy}
                workspaceId={workspaceId}
                selectedIds={selectedLocalIds}
                batchMode={batchMode}
                batchSelected={batchSelected}
                onToggleBatchMode={() => {
                  setBatchMode((value) => !value);
                  setBatchSelected(new Set());
                }}
                onToggleBatch={(row) => {
                  setBatchSelected((current) => {
                    const next = new Set(current);
                    if (next.has(row.id)) next.delete(row.id);
                    else next.add(row.id);
                    return next;
                  });
                }}
                onSyncAll={() => void syncAllRemote()}
                onToggleSelected={toggleSelected}
                onSelectForPublish={selectForPublish}
                onEnable={(row) =>
                  void run("enable", () => setEnabled(row, true))
                }
                onAssociate={(row) => setAssociation(row)}
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
                onRead={(row, path) => void readAssetFile(row, path)}
                onReadLocal={(row, path) => void readLocalAssetFile(row, path)}
              />
            ) : null}

            {tab === "drift" ? (
              <DriftView
                tokens={tokens}
                items={drift.filter(
                  (item) => item.status !== "synced" || item.ignored,
                )}
                busy={busy}
                onDiff={(item) => void openDriftDiff(item)}
                onMerge={(item) => void openDriftMerge(item)}
                onOverwrite={(item) => void resolveDrift(item, "overwrite")}
                onKeep={(item) => void resolveDrift(item, "keep")}
                onIgnore={(item, ignored) => void ignoreItem(item, ignored)}
                onPull={() =>
                  run("pull", async () => {
                    if (!workspaceId) return;
                    unwrap(
                      await workspacePullCall({
                        projectId: project.projectId,
                        workspaceId,
                      }),
                    );
                    setNotice("已从共享仓库刷新本地副本");
                  })
                }
              />
            ) : null}

            {tab === "settings" ? (
              <SettingsView
                tokens={tokens}
                projectId={project.projectId}
                workspaceId={workspaceId}
                providers={providers}
                drift={drift}
                busy={busy}
                onIgnoreChange={(item, ignored) =>
                  void ignoreItem(item, ignored)
                }
                onNotice={setNotice}
              />
            ) : null}
          </>
        ) : null}
      </ScrollView>

      {project.bound && kind ? (
        <PublishFooter
          tokens={tokens}
          compact={compact}
          kind={kind}
          selectedCount={selectedCount}
          publishableCount={publishableRows.length}
          batchMode={batchMode}
          batchSelectedCount={batchSelected.size}
          batchSelectableCount={batchSelectableCount}
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
                  .filter((row) => row.local !== null || row.shared !== null)
                  .map((row) => row.id),
              ),
            )
          }
          onClearBatch={() => setBatchSelected(new Set())}
          onBatchAssociate={() =>
            run("batch-associate", async () => {
              let done = 0;
              let failed = 0;
              for (const row of batchCandidates) {
                if (!workspaceId || !row.shared || !row.local) continue;
                try {
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
                  done += 1;
                } catch {
                  failed += 1;
                }
              }
              setNotice(`批量关联：成功 ${done} 项，失败 ${failed} 项`);
            })
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
              setNotice(`批量同步：成功 ${done} 项，失败 ${failed} 项`);
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
      <PublishPreviewDialog
        open={previewOpen}
        preview={preview}
        tokens={tokens}
        busy={busy === "publish"}
        onClose={() => setPreviewOpen(false)}
        onCommit={() => void commitPublish()}
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
      <ReadDialog
        dialog={readDialog}
        tokens={tokens}
        onClose={() => setReadDialog(null)}
      />
      <IgnoreRulesDialog
        open={ignoreDialog}
        tokens={tokens}
        projectId={project.projectId}
        drift={drift}
        busy={busy === "ignore-rules"}
        onClose={() => setIgnoreDialog(false)}
        onRestore={(item) => void ignoreItem(item, false)}
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

function OverviewCard({
  tokens,
  compact,
  project,
  binding,
  busy,
  confirmUnbind,
  forceUnbind,
  onSync,
  onRefresh,
  onRebind,
  onRequestUnbind,
  onCancelUnbind,
  onUnbind,
}: {
  tokens: Tokens;
  compact: boolean;
  project: ProjectSummary;
  binding: Binding | null;
  busy: string | null;
  confirmUnbind: boolean;
  forceUnbind: string | null;
  onSync: () => void;
  onRefresh: () => void;
  onRebind: () => void;
  onRequestUnbind: () => void;
  onCancelUnbind: () => void;
  onUnbind: (force: boolean) => void;
}) {
  const state = binding?.state ?? project.state;
  return (
    <Panel tokens={tokens}>
      <View
        style={{
          flexDirection: compact ? "column" : "row",
          alignItems: compact ? "stretch" : "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text
            style={{
              color: tokens.colors.foreground,
              fontSize: tokens.fontSize["2xl"],
              fontWeight: "600",
            }}
          >
            {binding?.displayName ?? repositoryDisplayName(project.repoUrl)}
          </Text>
          <Mono tokens={tokens} numberOfLines={1}>
            {project.repoUrl ?? ""}
          </Mono>
        </View>
        <View
          style={{
            flexDirection: "row",
            gap: 6,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <Badge
            tokens={tokens}
            label={project.syncMode === "auto" ? "自动同步" : "手动同步"}
          />
          {state?.dirty ? (
            <Badge tokens={tokens} label="本地改动" tone="warn" />
          ) : null}
          {(state?.behind ?? 0) > 0 ? (
            <Badge
              tokens={tokens}
              label={`落后 ${state?.behind}`}
              tone="warn"
            />
          ) : null}
          {(state?.ahead ?? 0) > 0 ? (
            <Badge tokens={tokens} label={`领先 ${state?.ahead}`} />
          ) : null}
        </View>
      </View>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: compact ? 8 : 20,
        }}
      >
        <View style={{ flexDirection: "row", gap: 4 }}>
          <Muted tokens={tokens}>分支</Muted>
          <Text
            style={{
              color: tokens.colors.foreground,
              fontSize: tokens.fontSize.sm,
            }}
          >
            {project.branch ?? "(默认分支)"}
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: 4 }}>
          <Muted tokens={tokens}>本地</Muted>
          <Mono tokens={tokens} testID="shared-assets-local-revision">
            {shortRevision(state?.localRevision)}
          </Mono>
        </View>
        <View style={{ flexDirection: "row", gap: 4 }}>
          <Muted tokens={tokens}>远端</Muted>
          <Mono tokens={tokens}>{shortRevision(state?.remoteRevision)}</Mono>
        </View>
        <Muted tokens={tokens}>
          最近同步{" "}
          {state?.lastSyncedAt
            ? new Date(state.lastSyncedAt).toLocaleString()
            : "—"}
        </Muted>
      </View>
      {state?.lastError ? (
        <Alert
          tone="danger"
          title={state.lastError.code}
          description={state.lastError.message}
          tokens={tokens}
        />
      ) : null}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button
          tokens={tokens}
          size="xs"
          variant="default"
          icon="RefreshCw"
          disabled={busy !== null}
          onPress={onSync}
          testID="shared-assets-sync"
        >
          {busy === "sync" ? "同步中…" : "检查更新并同步"}
        </Button>
        <Button
          tokens={tokens}
          size="xs"
          variant="ghost"
          disabled={busy !== null}
          onPress={onRebind}
        >
          重新绑定
        </Button>
        <Button
          tokens={tokens}
          size="xs"
          variant="danger"
          disabled={busy !== null}
          onPress={onRequestUnbind}
        >
          解绑
        </Button>
        <Button
          tokens={tokens}
          size="xs"
          variant="ghost"
          disabled={busy !== null}
          onPress={onRefresh}
        >
          刷新
        </Button>
      </View>
      {confirmUnbind ? (
        <ConfirmInline
          tokens={tokens}
          title="解绑共享仓库？"
          description="受管投影会被移除，本地修改会保留；项目文件不会被删除。"
          confirmLabel="确认解绑"
          cancelLabel="取消"
          onConfirm={() => onUnbind(false)}
          onCancel={onCancelUnbind}
          destructive
        />
      ) : null}
      {forceUnbind ? (
        <ConfirmInline
          tokens={tokens}
          title="共享 checkout 有未推送提交或本地改动"
          description={`${forceUnbind}。仍要解绑将丢弃这些提交，但不会删除项目内资产。`}
          confirmLabel="仍要解绑"
          cancelLabel="取消"
          onConfirm={() => onUnbind(true)}
          onCancel={() => onCancelUnbind()}
          destructive
        />
      ) : null}
    </Panel>
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
  batchCandidates,
  batchSyncable,
  batchPublishable,
  batchUnlinkable,
  busy,
  onSelectAllPublishable,
  onPreview,
  onSelectAllBatch,
  onClearBatch,
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
  batchCandidates: number;
  batchSyncable: number;
  batchPublishable: number;
  batchUnlinkable: number;
  busy: boolean;
  onSelectAllPublishable: () => void;
  onPreview: () => void;
  onSelectAllBatch: () => void;
  onClearBatch: () => void;
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
              size="xs"
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
              批量发布 · {batchPublishable}
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
              ? "勾选要处理的资产；范围限于当前标签页。"
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
            size="xs"
            variant="default"
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
  result,
  busy,
  workspaceId,
  selectedIds,
  batchMode,
  batchSelected,
  onToggleBatchMode,
  onToggleBatch,
  onSyncAll,
  onToggleSelected,
  onSelectForPublish,
  onEnable,
  onAssociate,
  onUnlink,
  onDiff,
  onMerge,
  onDiscard,
  onIgnore,
  onRead,
  onReadLocal,
}: {
  tokens: Tokens;
  compact: boolean;
  kind: AssetKind;
  result: RelationshipListResult | null;
  busy: string | null;
  workspaceId: string | null;
  selectedIds: ReadonlySet<string>;
  batchMode: boolean;
  batchSelected: ReadonlySet<string>;
  onToggleBatchMode: () => void;
  onToggleBatch: (row: AssetRelationshipRow) => void;
  onSyncAll: () => void;
  onToggleSelected: (row: AssetRelationshipRow) => void;
  onSelectForPublish: (row: AssetRelationshipRow) => void;
  onEnable: (row: AssetRelationshipRow) => void;
  onAssociate: (row: AssetRelationshipRow) => void;
  onUnlink: (row: AssetRelationshipRow) => void;
  onDiff: (row: AssetRelationshipRow) => void;
  onMerge: (row: AssetRelationshipRow) => void;
  onDiscard: (row: AssetRelationshipRow) => void;
  onIgnore: (row: AssetRelationshipRow, ignored: boolean) => void;
  onRead: (row: AssetRelationshipRow, path?: string) => void;
  onReadLocal: (row: AssetRelationshipRow, path?: string) => void;
}) {
  const rows = result?.rows ?? [];
  const candidates = rows.filter((row) => row.relationship === "candidate");
  const remoteUpdates = rows.filter(
    (row) =>
      row.relationship === "linked" && row.syncStatus === "remote-update",
  );
  const linked = rows.filter((row) => row.relationship === "linked");

  if (!workspaceId) {
    return <Empty tokens={tokens}>该项目还没有 Workspace。</Empty>;
  }
  if (!result) return <Spinner tokens={tokens} />;

  return (
    <View style={{ gap: 12 }}>
      {compact ? (
        <View style={{ gap: 8 }}>
          <View style={{ gap: 2 }}>
            <Text
              style={{
                color: tokens.colors.foreground,
                fontSize: tokens.fontSize.lg,
                fontWeight: "600",
              }}
            >
              {KIND_LABELS[kind]} · {rows.length} 项
            </Text>
            <Muted tokens={tokens}>
              {kind === "skill"
                ? "启用后投影到对应 Provider 的项目级 Skill 目录；停用只删除未被修改的受管副本。"
                : kind === "prompt"
                  ? "链路：共享 AGENTS.md → 项目 .agentstorm/AGENTS.md → Provider 原生入口。"
                  : "共享与本地副本的关联；勾选本地资产后，在底部预览并发布。"}
            </Muted>
          </View>
          <View
            style={{
              flexDirection: "row",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            {kind === "skill" ? (
              <Button
                tokens={tokens}
                size="xs"
                icon="RefreshCw"
                onPress={onSyncAll}
                disabled={busy !== null}
              >
                一键同步
              </Button>
            ) : null}
            <Button
              tokens={tokens}
              size="xs"
              variant={batchMode ? "default" : "secondary"}
              onPress={onToggleBatchMode}
              testID="shared-assets-batch-toggle"
            >
              {batchMode ? "退出批量" : "批量操作"}
            </Button>
          </View>
        </View>
      ) : (
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            gap: tokens.spacing[3],
            borderBottomWidth: 1,
            borderBottomColor: tokens.colors.border,
            paddingBottom: tokens.spacing[2],
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text
              style={{
                color: tokens.colors.foreground,
                fontSize: tokens.fontSize.lg,
                fontWeight: "600",
              }}
            >
              共享仓库
            </Text>
            <Muted tokens={tokens}>团队可用的 {KIND_LABELS[kind]}</Muted>
          </View>
          <View style={{ width: 150, alignItems: "center", gap: 8 }}>
            <Text
              style={{
                color: tokens.colors.foreground,
                fontSize: tokens.fontSize.lg,
                fontWeight: "600",
              }}
            >
              同步与关联
            </Text>
            <View
              style={{
                flexDirection: "row",
                gap: 6,
                flexWrap: "wrap",
                justifyContent: "center",
              }}
            >
              {kind === "skill" ? (
                <Button
                  tokens={tokens}
                  size="xs"
                  icon="RefreshCw"
                  onPress={onSyncAll}
                  disabled={busy !== null}
                >
                  一键同步
                </Button>
              ) : null}
              <Button
                tokens={tokens}
                size="xs"
                variant={batchMode ? "default" : "secondary"}
                onPress={onToggleBatchMode}
                testID="shared-assets-batch-toggle"
              >
                {batchMode ? "退出批量" : "批量操作"}
              </Button>
            </View>
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text
              style={{
                color: tokens.colors.foreground,
                fontSize: tokens.fontSize.lg,
                fontWeight: "600",
              }}
            >
              本地 {KIND_LABELS[kind]}
            </Text>
            <Muted tokens={tokens}>
              {kind === "skill"
                ? "当前 Provider 实际可用"
                : kind === "prompt"
                  ? "项目唯一 AGENTS.md 与当前 Provider 链接"
                  : "当前项目中的可用资产"}
            </Muted>
          </View>
        </View>
      )}

      {candidates.length > 0 ? (
        <View
          style={{
            flexDirection: compact ? "column" : "row",
            alignItems: compact ? "stretch" : "center",
            gap: tokens.spacing[3],
            borderWidth: 1,
            borderColor: tokens.colors.border,
            backgroundColor: tokens.colors.surface1,
            borderRadius: tokens.radius.lg,
            paddingHorizontal: tokens.spacing[3],
            paddingVertical: tokens.spacing[2],
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text
              style={{
                color: tokens.colors.foreground,
                fontSize: tokens.fontSize.base,
                fontWeight: "600",
              }}
            >
              {candidates.length} 项同名资产尚未关联
            </Text>
            <Muted tokens={tokens}>
              一键关联按「保留本地」处理：不改动本地文件，不自动发布；与共享版本不同时显示为本地未发布。
            </Muted>
          </View>
          <Button
            tokens={tokens}
            size="xs"
            icon="Link2"
            style={compact ? { alignSelf: "flex-start" } : undefined}
            onPress={() => candidates.forEach((row) => onAssociate(row))}
          >
            一键关联全部
          </Button>
        </View>
      ) : null}

      {rows.length === 0 ? (
        <Empty tokens={tokens}>
          共享仓库和本地都没有发现 {KIND_LABELS[kind]}
        </Empty>
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
              gap: 8,
            }}
            testID={`shared-assets-row-${row.shared?.name ?? row.local?.name}`}
          >
            {batchMode ? (
              <View
                style={{
                  width: 28,
                  justifyContent: "center",
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
                onRead={(path) => onRead(row, path)}
                onReadLocal={(path) => onReadLocal(row, path)}
              />
            </View>
          </View>
        );
      })}

      {remoteUpdates.length > 0 && !batchMode ? (
        <Muted tokens={tokens}>
          有 {remoteUpdates.length}{" "}
          项共享更新可同步到本地；在对应行点击「同步到本地」。
        </Muted>
      ) : null}
      {linked.length === 0 && !batchMode ? (
        <Muted tokens={tokens}>当前没有已关联的 {KIND_LABELS[kind]}。</Muted>
      ) : null}
    </View>
  );
}

function RelationshipRow({
  row,
  tokens,
  compact,
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
  onRead,
  onReadLocal,
}: {
  row: AssetRelationshipRow;
  tokens: Tokens;
  compact: boolean;
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
  onRead: (path?: string) => void;
  onReadLocal: (path?: string) => void;
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
  const isPrivate = row.relationship === "private";
  const isCandidate = row.relationship === "candidate";
  const isSharedOnly = row.relationship === "shared-only";
  const isConflict = row.relationship === "conflict";
  const isSynced =
    row.relationship === "linked" &&
    !isRemoteUpdate &&
    !isDiverged &&
    !isLocalUpdate &&
    !isRemoteDeleted;
  const localDetail = !local
    ? ""
    : isPrivate
      ? `将创建新的共享 ${KIND_LABELS[local.kind]}`
      : isCandidate
        ? `将更新同名共享 ${KIND_LABELS[local.kind]}`
        : row.relationship === "linked"
          ? `将更新已关联的共享 ${KIND_LABELS[local.kind]}`
          : "";

  const sharedCard = shared ? (
    <View
      style={[
        {
          flex: compact ? undefined : 1,
          minWidth: 0,
          minHeight: compact ? undefined : 112,
          borderWidth: 1,
          borderColor:
            row.relationship === "linked"
              ? tokens.colors.accent
              : tokens.colors.border,
          backgroundColor: isRemoteUpdate
            ? `${tokens.colors.accent}12`
            : isLocalUpdate
              ? `${tokens.colors.warning}10`
              : isDiverged || isRemoteDeleted
                ? `${tokens.colors.danger}10`
                : tokens.colors.surface1,
          borderRadius: tokens.radius.lg,
          padding: tokens.spacing[3],
          gap: 4,
        },
        isDiverged ? { borderColor: tokens.colors.danger } : null,
        isRemoteDeleted ? { borderColor: tokens.colors.danger } : null,
        isRemoteUpdate ? { borderColor: tokens.colors.accent } : null,
        isLocalUpdate ? { borderColor: tokens.colors.warning } : null,
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: tokens.radius.md,
            backgroundColor: tokens.colors.surface2,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon
            name={
              isRemoteDeleted
                ? "X"
                : isRemoteUpdate
                  ? "RefreshCw"
                  : isLocalUpdate
                    ? "UploadCloud"
                    : row.relationship === "linked"
                      ? "Check"
                      : "LibraryBig"
            }
            size={14}
            color={
              isRemoteDeleted || isDiverged
                ? tokens.colors.danger
                : isRemoteUpdate || isLocalUpdate
                  ? tokens.colors.warning
                  : tokens.colors.accent
            }
          />
        </View>
        <Text
          style={{
            color: tokens.colors.foreground,
            fontSize: tokens.fontSize.base,
            fontWeight: "600",
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {shared.name}
        </Text>
        <Badge tokens={tokens} label="项目级" />
      </View>
      <Muted tokens={tokens} numberOfLines={2}>
        {shared.description || "无描述"}
      </Muted>
      {syncStatus && syncStatus !== "synced" ? (
        <Badge
          tokens={tokens}
          label={ATTENTION_LABELS[syncStatus]}
          tone={DRIFT_TONES[syncStatus]}
        />
      ) : null}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {shared.files[0] ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => onRead(shared.files[0]?.path)}
          >
            <Text
              style={{
                color: tokens.colors.accent,
                fontSize: tokens.fontSize.xs,
              }}
            >
              预览
            </Text>
          </Pressable>
        ) : null}
        <Muted tokens={tokens}>{shared.fileCount} 个文件</Muted>
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
        minHeight: 96,
        alignItems: "center",
        justifyContent: "center",
        padding: 8,
      }}
    >
      {isPrivate ? null : <Muted tokens={tokens}>尚未添加到本地</Muted>}
    </View>
  );

  const localCard = local ? (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled: !showSelection }}
      disabled={!showSelection}
      onPress={onToggleSelected}
      style={{
        flex: compact ? undefined : 1,
        minWidth: 0,
        minHeight: compact ? undefined : 112,
        borderWidth: 1,
        borderColor: selected
          ? tokens.colors.accent
          : isRemoteUpdate
            ? tokens.colors.accent
            : isLocalUpdate || isDiverged || isRemoteDeleted
              ? isDiverged || isRemoteDeleted
                ? tokens.colors.danger
                : tokens.colors.warning
              : tokens.colors.border,
        backgroundColor: selected
          ? tokens.colors.surface2
          : isRemoteUpdate
            ? `${tokens.colors.accent}0a`
            : isLocalUpdate
              ? `${tokens.colors.warning}08`
              : isDiverged || isRemoteDeleted
                ? `${tokens.colors.danger}08`
                : tokens.colors.surface1,
        borderRadius: tokens.radius.lg,
        padding: tokens.spacing[3],
        gap: 4,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {showSelection ? (
          <View pointerEvents="none">
            <Checkbox
              tokens={tokens}
              checked={selected}
              onPress={onToggleSelected}
              size={20}
              accessibilityLabel={`选择发布 ${local.name}`}
              testID={`shared-assets-publish-select-${local.name}`}
            />
          </View>
        ) : null}
        <Text
          style={{
            color: tokens.colors.foreground,
            fontSize: tokens.fontSize.base,
            fontWeight: "600",
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {local.name}
        </Text>
        <Badge tokens={tokens} label={local.provider ?? "本地"} />
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
      <Pressable
        accessibilityRole="button"
        onPress={(event) => {
          event.stopPropagation();
          onReadLocal();
        }}
        style={{ alignSelf: "flex-start" }}
      >
        <Text
          style={{
            color: tokens.colors.accent,
            fontSize: tokens.fontSize.xs,
          }}
        >
          预览
        </Text>
      </Pressable>
      <Mono tokens={tokens} numberOfLines={1}>
        {local.path}
      </Mono>
      <Muted tokens={tokens} numberOfLines={1}>
        {local.description || "无描述"}
      </Muted>
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
      {isLocalUpdate || isDiverged || isRemoteDeleted ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            borderRadius: tokens.radius.full,
            borderWidth: 1,
            borderColor:
              isDiverged || isRemoteDeleted
                ? tokens.colors.danger
                : tokens.colors.warning,
            backgroundColor: `${isDiverged || isRemoteDeleted ? tokens.colors.danger : tokens.colors.warning}12`,
            paddingHorizontal: tokens.spacing[2],
            paddingVertical: 2,
            alignSelf: "flex-start",
          }}
        >
          <Icon
            name={isDiverged || isRemoteDeleted ? "X" : "UploadCloud"}
            size={12}
            color={
              isDiverged || isRemoteDeleted
                ? tokens.colors.danger
                : tokens.colors.warning
            }
          />
          <Text
            style={{
              color:
                isDiverged || isRemoteDeleted
                  ? tokens.colors.danger
                  : tokens.colors.warning,
              fontSize: tokens.fontSize.sm,
            }}
          >
            {isDiverged
              ? "共享端与本地均有修改"
              : isRemoteDeleted
                ? "共享仓库已删除，本地副本仍保留"
                : "本地有未发布修改"}
          </Text>
        </View>
      ) : null}
      {isPrivate ? (
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
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
      <Muted tokens={tokens}>
        {local.fileCount} 个文件
        {row.relationship === "linked" && row.driftFiles > 0
          ? ` · ${row.driftFiles} 个有差异`
          : ""}
      </Muted>
    </Pressable>
  ) : (
    <View
      style={{
        flex: compact ? undefined : 1,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: tokens.colors.border,
        borderRadius: tokens.radius.lg,
        minHeight: 96,
        alignItems: "center",
        justifyContent: "center",
        padding: 8,
      }}
    >
      <Muted tokens={tokens}>尚未添加到本地</Muted>
    </View>
  );

  const actions = (
    <View
      style={{
        width: compact ? undefined : 150,
        gap: tokens.spacing[2],
        alignItems: compact ? "flex-start" : "center",
        justifyContent: "center",
        flexDirection: compact ? "row" : "column",
        flexWrap: "wrap",
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
          <Muted tokens={tokens}>本地私有</Muted>
          <Button tokens={tokens} size="xs" onPress={onSelectForPublish}>
            选择发布
          </Button>
        </>
      ) : isCandidate ? (
        <>
          <Icon name="Link2" size={15} color={tokens.colors.accent} />
          <Muted tokens={tokens}>发现同名资产</Muted>
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
          <Badge tokens={tokens} label="远端已删除" tone="danger" />
          <Muted tokens={tokens}>本地副本仍保留</Muted>
          <Button tokens={tokens} size="xs" onPress={onSelectForPublish}>
            重新发布
          </Button>
          <Button tokens={tokens} size="xs" variant="ghost" onPress={onUnlink}>
            保留为私有
          </Button>
        </>
      ) : isRemoteUpdate ? (
        <>
          <Badge tokens={tokens} label="共享 → 本地" tone="warn" />
          <Muted tokens={tokens}>共享端有新版本</Muted>
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
      ) : isLocalUpdate || isDiverged ? (
        <>
          <Badge
            tokens={tokens}
            label={isDiverged ? "双方均有修改" : "本地 → 共享"}
            tone={isDiverged ? "danger" : "warn"}
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
          <Button tokens={tokens} size="xs" variant="ghost" onPress={onDiff}>
            查看差异
          </Button>
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
        gap: 10,
      }}
    >
      {sharedCard}
      {actions}
      {localCard}
    </View>
  );
}

function DriftView({
  tokens,
  items,
  busy,
  onDiff,
  onMerge,
  onOverwrite,
  onKeep,
  onIgnore,
  onPull,
}: {
  tokens: Tokens;
  items: DriftItem[];
  busy: string | null;
  onDiff: (item: DriftItem) => void;
  onMerge: (item: DriftItem) => void;
  onOverwrite: (item: DriftItem) => void;
  onKeep: (item: DriftItem) => void;
  onIgnore: (item: DriftItem, ignored: boolean) => void;
  onPull: () => void;
}) {
  return (
    <Panel tokens={tokens}>
      <SectionTitle
        tokens={tokens}
        trailing={
          <Button
            tokens={tokens}
            size="xs"
            icon="RefreshCw"
            onPress={onPull}
            disabled={busy !== null}
            testID="shared-assets-workspace-pull"
          >
            刷新本地副本
          </Button>
        }
      >
        Drift 检测
      </SectionTitle>
      <Muted tokens={tokens}>
        对比本地副本、共享仓库与上次同步基线；本地改动不会被自动覆盖。
      </Muted>
      {items.length === 0 ? (
        <Empty tokens={tokens}>还没有可跟踪的投影资产。</Empty>
      ) : null}
      {items.map((item) => (
        <View
          key={`${item.assetId}/${item.provider ?? ""}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            borderBottomWidth: 1,
            borderBottomColor: tokens.colors.border,
            paddingVertical: 8,
            flexWrap: "wrap",
          }}
          testID={`shared-assets-drift-${item.name}`}
        >
          <View style={{ flex: 1, minWidth: 220, gap: 2 }}>
            <Text
              style={{
                color: tokens.colors.foreground,
                fontSize: tokens.fontSize.base,
              }}
            >
              {item.name}{" "}
              <Text
                style={{
                  color: tokens.colors.foregroundMuted,
                  fontSize: tokens.fontSize.xs,
                }}
              >
                · {KIND_LABELS[item.kind]}
                {item.provider ? ` · ${item.provider}` : ""}
              </Text>
            </Text>
            <Mono tokens={tokens} numberOfLines={1}>
              {item.targetPath}
            </Mono>
            <Muted tokens={tokens}>
              {item.files.length} 个文件
              {item.files
                .filter((file) => file.status !== "synced")
                .slice(0, 3)
                .map((file) => ` · ${file.path}`)
                .join("")}
            </Muted>
          </View>
          <Badge
            tokens={tokens}
            label={ATTENTION_LABELS[item.status]}
            tone={DRIFT_TONES[item.status]}
          />
          {item.ignored ? (
            <Button
              tokens={tokens}
              size="xs"
              variant="ghost"
              onPress={() => onIgnore(item, false)}
              disabled={busy !== null}
            >
              恢复提醒
            </Button>
          ) : (
            <>
              <Button
                tokens={tokens}
                size="xs"
                variant="ghost"
                onPress={() => onDiff(item)}
              >
                查看差异
              </Button>
              <Button
                tokens={tokens}
                size="xs"
                variant="ghost"
                onPress={() => onMerge(item)}
              >
                合并
              </Button>
              <Button
                tokens={tokens}
                size="xs"
                variant="ghost"
                onPress={() => onOverwrite(item)}
              >
                覆盖本地
              </Button>
              <Button
                tokens={tokens}
                size="xs"
                variant="ghost"
                onPress={() => onKeep(item)}
              >
                保留并忽略
              </Button>
              <Button
                tokens={tokens}
                size="xs"
                variant="ghost"
                onPress={() => onIgnore(item, true)}
              >
                忽略
              </Button>
            </>
          )}
        </View>
      ))}
    </Panel>
  );
}

function SettingsView({
  tokens,
  projectId,
  workspaceId,
  providers,
  drift,
  busy,
  onIgnoreChange,
  onNotice,
}: {
  tokens: Tokens;
  projectId: string;
  workspaceId: string | null;
  providers: ProviderStatus[];
  drift: DriftItem[];
  busy: string | null;
  onIgnoreChange: (item: DriftItem, ignored: boolean) => void;
  onNotice: (value: string) => void;
}) {
  const ignoreGet = useRpc(ignoreRulesGetRpc);
  const ignoreSet = useRpc(ignoreRulesSetRpc);
  const migrateCall = useRpc(migrateLegacyRpc);
  const [raw, setRaw] = useState("");
  const [ignoreResult, setIgnoreResult] = useState<IgnoreRulesResult | null>(
    null,
  );
  const [migration, setMigration] = useState<MigrationReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void ignoreGet({ projectId })
      .then(unwrap)
      .then((value) => {
        if (cancelled) return;
        setRaw(value.raw);
        setIgnoreResult(value as IgnoreRulesResult);
      })
      .catch((value) => {
        if (!cancelled) setError(messageOf(value));
      });
    return () => {
      cancelled = true;
    };
  }, [ignoreGet, projectId]);

  const ignored = drift.filter((item) => item.ignored);
  return (
    <View style={{ gap: 12 }}>
      <Panel tokens={tokens}>
        <SectionTitle tokens={tokens}>Provider 矩阵</SectionTitle>
        <Muted tokens={tokens}>
          只有已验证的目录才会默认启用；未验证项会明确标注。
        </Muted>
        {providers.map((provider) => (
          <View
            key={provider.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingVertical: 6,
              borderBottomWidth: 1,
              borderBottomColor: tokens.colors.border,
              flexWrap: "wrap",
            }}
          >
            <View style={{ flex: 1, minWidth: 200 }}>
              <Text
                style={{
                  color: tokens.colors.foreground,
                  fontSize: tokens.fontSize.base,
                }}
              >
                {provider.label}
              </Text>
              <Mono tokens={tokens}>
                skill: {provider.skillRoot ?? "不投影"} · prompt:{" "}
                {provider.instructionEntrypoint ?? "不投影"}
              </Mono>
              <Muted tokens={tokens}>{provider.note}</Muted>
            </View>
            <Badge
              tokens={tokens}
              label={provider.installed ? "已安装" : "未安装"}
              tone={provider.installed ? "ok" : "muted"}
            />
            <Badge
              tokens={tokens}
              label={provider.skillVerified ? "已验证" : "未验证"}
              tone={provider.skillVerified ? "ok" : "warn"}
            />
          </View>
        ))}
      </Panel>

      <Panel tokens={tokens} style={{}}>
        <SectionTitle tokens={tokens}>Ignore 规则</SectionTitle>
        <Muted tokens={tokens}>
          每行一条：path:&lt;glob&gt;、kind:&lt;skill|prompt|knowledge|doc&gt;、asset:&lt;assetId&gt;，也可以直接写路径。保存会提交到共享仓库。
        </Muted>
        <TextField
          value={raw}
          onChangeText={setRaw}
          multiline
          tokens={tokens}
          testID="shared-assets-ignore-input"
        />
        {ignoreResult?.errors.map((entry) => (
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
        {error ? (
          <Text
            style={{
              color: tokens.colors.danger,
              fontSize: tokens.fontSize.sm,
            }}
          >
            {error}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button
            tokens={tokens}
            size="xs"
            variant="default"
            disabled={busy !== null}
            onPress={() => {
              void ignoreSet({ projectId, raw })
                .then(unwrap)
                .then((value) => {
                  const result = value as IgnoreRulesResult & {
                    commit: string | null;
                  };
                  setIgnoreResult(result);
                  setRaw(result.raw);
                  onNotice(
                    result.commit
                      ? `忽略规则已保存并提交 ${result.commit.slice(0, 8)}`
                      : "忽略规则已保存",
                  );
                })
                .catch((value) => setError(messageOf(value)));
            }}
            testID="shared-assets-ignore-save"
          >
            保存规则
          </Button>
        </View>
        {ignored.length > 0 ? (
          <View style={{ gap: 4 }}>
            <Text
              style={{
                color: tokens.colors.foreground,
                fontSize: tokens.fontSize.base,
                fontWeight: "600",
              }}
            >
              项目级已忽略 · {ignored.length}
            </Text>
            {ignored.map((item) => (
              <View
                key={`${item.assetId}/${item.provider ?? ""}`}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  paddingVertical: 4,
                }}
              >
                <Text
                  style={{
                    color: tokens.colors.foreground,
                    fontSize: tokens.fontSize.sm,
                    flex: 1,
                    minWidth: 0,
                  }}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {item.name}
                </Text>
                <Muted tokens={tokens}>
                  {KIND_LABELS[item.kind]}
                  {item.provider ? ` · ${item.provider}` : ""}
                </Muted>
                <Button
                  tokens={tokens}
                  size="xs"
                  variant="ghost"
                  onPress={() => onIgnoreChange(item, false)}
                >
                  恢复提醒
                </Button>
              </View>
            ))}
          </View>
        ) : null}
      </Panel>

      <Panel tokens={tokens}>
        <SectionTitle tokens={tokens}>.agentstorm/ 一次性迁移</SectionTitle>
        <Muted tokens={tokens}>
          只读导入 AGENTS.md、knowledge、docs 到共享 checkout；workflows
          跳过，源目录不删除，冲突项不覆盖。
        </Muted>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Button
            tokens={tokens}
            size="xs"
            variant="default"
            disabled={!workspaceId || busy !== null}
            onPress={() =>
              workspaceId &&
              void migrateCall({ projectId, workspaceId, dryRun: true })
                .then(unwrap)
                .then((value) => setMigration(value as MigrationReport))
                .catch((value) => setError(messageOf(value)))
            }
            testID="shared-assets-migrate-preview"
          >
            预览迁移
          </Button>
          <Button
            tokens={tokens}
            size="xs"
            disabled={
              !workspaceId ||
              !migration ||
              !migration.files.some((file) => file.action === "import")
            }
            onPress={() =>
              workspaceId &&
              void migrateCall({ projectId, workspaceId, dryRun: false })
                .then(unwrap)
                .then((value) => {
                  setMigration(value as MigrationReport);
                  onNotice("迁移已执行");
                })
                .catch((value) => setError(messageOf(value)))
            }
            testID="shared-assets-migrate-apply"
          >
            执行导入
          </Button>
        </View>
        {migration ? (
          <View style={{ gap: 2 }}>
            <Muted tokens={tokens}>
              {migration.dryRun
                ? "预览"
                : migration.applied
                  ? "已导入"
                  : "无变更"}
              {migration.reused ? "（源未变化，复用上次结果）" : ""} · 源{" "}
              {migration.before.files} 个文件 → 目标 {migration.after.files}{" "}
              个文件
            </Muted>
            {migration.files.map((file) => (
              <Text
                key={`${file.sourcePath}-${file.repositoryPath}`}
                style={{
                  color:
                    file.action === "conflict"
                      ? tokens.colors.danger
                      : file.action === "import"
                        ? tokens.colors.success
                        : tokens.colors.foregroundMuted,
                  fontSize: tokens.fontSize.sm,
                }}
              >
                {file.action}: {file.sourcePath} → {file.repositoryPath}
                {file.reason ? `（${file.reason}）` : ""}
              </Text>
            ))}
            {migration.candidates.skills.length > 0 ? (
              <Muted tokens={tokens}>
                可发布 Skill 候选：{migration.candidates.skills.join(", ")}
              </Muted>
            ) : null}
          </View>
        ) : null}
      </Panel>
    </View>
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
    <Dialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="关联已有本地资产"
    >
      {row?.shared && row.local ? (
        <>
          <Muted tokens={tokens}>
            本地「{row.local.name}」与共享「{row.shared.name}
            」同名。选择关联方式：
          </Muted>
          <View style={{ gap: 8 }}>
            <Button
              tokens={tokens}
              variant="default"
              onPress={() => onAdopt("preserve-local")}
              disabled={busy}
              testID="shared-assets-adopt-preserve"
            >
              保留本地版本并关联
            </Button>
            <Button
              tokens={tokens}
              variant="secondary"
              onPress={() => onAdopt("use-remote")}
              disabled={busy}
              testID="shared-assets-adopt-remote"
            >
              使用共享版本并关联
            </Button>
            <Button tokens={tokens} variant="ghost" onPress={onClose}>
              取消
            </Button>
          </View>
        </>
      ) : null}
    </Dialog>
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
  const [deleteLocal, setDeleteLocal] = useState(false);
  const row = rows[0];
  const hasChanges =
    row?.syncStatus === "local-update" ||
    row?.syncStatus === "diverged" ||
    (row?.driftFiles ?? 0) > 0;
  return (
    <Dialog
      open={rows.length > 0}
      onOpenChange={(open) => {
        if (!open) {
          setDeleteLocal(false);
          onClose();
        }
      }}
      title="移除共享资产关联"
    >
      {row?.shared ? (
        <>
          <Muted tokens={tokens}>
            「{row.shared.name}」将不再关联共享仓库。共享仓库中的版本不受影响。
          </Muted>
          {hasChanges ? (
            <Alert
              tone="warning"
              title="本地有未保存的修改"
              description="如果勾选删除本地资产，这些修改将无法恢复。"
              tokens={tokens}
            />
          ) : null}
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: deleteLocal }}
            onPress={() => setDeleteLocal((value) => !value)}
            style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
          >
            <Checkbox
              tokens={tokens}
              checked={deleteLocal}
              onPress={() => setDeleteLocal((value) => !value)}
            />
            <Text
              style={{
                color: tokens.colors.foreground,
                fontSize: tokens.fontSize.base,
              }}
            >
              同时删除本地受管副本
            </Text>
          </Pressable>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              tokens={tokens}
              variant={deleteLocal ? "danger" : "default"}
              onPress={() => onConfirm(deleteLocal)}
              disabled={busy}
              testID="shared-assets-unlink-confirm"
            >
              {busy ? "处理中…" : deleteLocal ? "删除并移除关联" : "仅移除关联"}
            </Button>
            <Button tokens={tokens} variant="ghost" onPress={onClose}>
              取消
            </Button>
          </View>
        </>
      ) : null}
    </Dialog>
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
  const [deleteLocal, setDeleteLocal] = useState(false);
  const hasChanges = rows.some(
    (row) =>
      row.syncStatus === "local-update" ||
      row.syncStatus === "diverged" ||
      row.driftFiles > 0,
  );
  return (
    <Dialog
      open={rows.length > 0}
      onOpenChange={(open) => {
        if (!open) {
          setDeleteLocal(false);
          onClose();
        }
      }}
      title="批量移除关联"
    >
      <Muted tokens={tokens}>
        将解除 {rows.length}{" "}
        项本地资产与共享仓库的关联。共享仓库中的版本不受影响。
      </Muted>
      {hasChanges ? (
        <Alert
          tone="warning"
          title="部分本地资产有未保存修改"
          description="勾选删除本地资产会移除这些修改，且无法恢复。"
          tokens={tokens}
        />
      ) : null}
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: deleteLocal }}
        onPress={() => setDeleteLocal((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
      >
        <Checkbox
          tokens={tokens}
          checked={deleteLocal}
          onPress={() => setDeleteLocal((value) => !value)}
        />
        <Text
          style={{
            color: tokens.colors.foreground,
            fontSize: tokens.fontSize.base,
          }}
        >
          同时删除这些本地受管副本
        </Text>
      </Pressable>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button
          tokens={tokens}
          variant={deleteLocal ? "danger" : "default"}
          onPress={() => onConfirm(deleteLocal)}
          disabled={busy}
          testID="shared-assets-batch-unlink-confirm"
        >
          {busy ? "处理中…" : deleteLocal ? "删除并移除关联" : "仅移除关联"}
        </Button>
        <Button tokens={tokens} variant="ghost" onPress={onClose}>
          取消
        </Button>
      </View>
    </Dialog>
  );
}

function PublishPreviewDialog({
  open,
  preview,
  tokens,
  busy,
  onClose,
  onCommit,
}: {
  open: boolean;
  preview: BatchPublishPreview | null;
  tokens: Tokens;
  busy: boolean;
  onClose: () => void;
  onCommit: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => !value && onClose()}
      title="发布预览"
    >
      {preview ? (
        <>
          <Muted tokens={tokens}>
            基于 revision {preview.expectedRevision.slice(0, 8)}
            。逐项校验，部分失败不阻断其余项。
          </Muted>
          <ScrollView style={{ maxHeight: 360 }}>
            {preview.items.map((item) => (
              <View
                key={item.assetId}
                style={{
                  gap: 4,
                  paddingVertical: 6,
                  borderBottomWidth: 1,
                  borderBottomColor: tokens.colors.border,
                }}
              >
                <View
                  style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                >
                  <Text
                    style={{
                      color: tokens.colors.foreground,
                      fontSize: tokens.fontSize.base,
                      fontWeight: "600",
                    }}
                  >
                    {item.name}
                  </Text>
                  <Badge
                    tokens={tokens}
                    label={item.state}
                    tone={
                      item.state === "eligible"
                        ? "ok"
                        : item.state === "warning"
                          ? "warn"
                          : "danger"
                    }
                  />
                </View>
                <Text
                  style={{
                    color: item.create
                      ? tokens.colors.accent
                      : tokens.colors.foregroundMuted,
                    fontSize: tokens.fontSize.sm,
                  }}
                >
                  {item.create
                    ? `将创建新的共享 ${KIND_LABELS[item.kind]}`
                    : `将更新同名共享 ${KIND_LABELS[item.kind]}`}
                </Text>
                {item.reasons.map((reason) => (
                  <Text
                    key={reason.code}
                    style={{
                      color: tokens.colors.danger,
                      fontSize: tokens.fontSize.sm,
                    }}
                  >
                    {reason.code}: {reason.message}
                  </Text>
                ))}
                <Mono tokens={tokens} numberOfLines={6}>
                  {item.diff.slice(0, 1200) || "(无差异)"}
                </Mono>
              </View>
            ))}
          </ScrollView>
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
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              tokens={tokens}
              variant="default"
              onPress={onCommit}
              disabled={busy}
              testID="shared-assets-publish-confirm"
            >
              {busy ? "发布中…" : "确认发布"}
            </Button>
            <Button tokens={tokens} variant="ghost" onPress={onClose}>
              返回
            </Button>
          </View>
        </>
      ) : (
        <Muted tokens={tokens}>正在生成预览…</Muted>
      )}
    </Dialog>
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
    <Dialog
      open={dialog !== null}
      onOpenChange={(open) => !open && onClose()}
      title={dialog?.title ?? "差异"}
      width={760}
    >
      {dialog?.result ? (
        dialog.result.kind === "binary" ? (
          <Muted tokens={tokens}>二进制文件，仅支持覆盖或保留。</Muted>
        ) : (
          <ScrollView style={{ maxHeight: 460 }}>
            <Text
              style={{ color: tokens.colors.foregroundMuted, fontSize: 12 }}
            >
              基线 → 本地
            </Text>
            <Mono tokens={tokens}>{dialog.result.localDiff || "(无变化)"}</Mono>
            <Text
              style={{
                color: tokens.colors.foregroundMuted,
                fontSize: 12,
                marginTop: 8,
              }}
            >
              基线 → 共享
            </Text>
            <Mono tokens={tokens}>
              {dialog.result.remoteDiff || "(无变化)"}
            </Mono>
          </ScrollView>
        )
      ) : (
        <Spinner tokens={tokens} />
      )}
    </Dialog>
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
    <Dialog
      open={dialog !== null}
      onOpenChange={(open) => !open && onClose()}
      title="三方合并"
      width={760}
    >
      {preview ? (
        <>
          <Muted tokens={tokens}>
            {preview.conflicts.length === 0
              ? "无冲突，可直接应用自动合并结果。"
              : `${preview.conflicts.length} 个冲突块，未全部选择前不能保存。`}
          </Muted>
          <ScrollView style={{ maxHeight: 380 }}>
            {preview.conflicts.map((conflict) => {
              const current = choices[conflict.id];
              return (
                <View
                  key={conflict.id}
                  style={{
                    gap: 4,
                    paddingVertical: 8,
                    borderBottomWidth: 1,
                    borderBottomColor: tokens.colors.border,
                  }}
                >
                  <Text
                    style={{
                      color: tokens.colors.foreground,
                      fontWeight: "600",
                    }}
                  >
                    冲突 {conflict.id}
                  </Text>
                  <Muted tokens={tokens}>本地</Muted>
                  <Mono tokens={tokens}>{conflict.local}</Mono>
                  <Muted tokens={tokens}>共享</Muted>
                  <Mono tokens={tokens}>{conflict.remote}</Mono>
                  <View
                    style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}
                  >
                    {(["local", "remote", "both", "custom"] as const).map(
                      (choice) => (
                        <Button
                          key={choice}
                          tokens={tokens}
                          size="xs"
                          variant={
                            current?.choice === choice ? "default" : "secondary"
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
          <View style={{ flexDirection: "row", gap: 8 }}>
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
        </>
      ) : (
        <Spinner tokens={tokens} />
      )}
    </Dialog>
  );
}

function ReadDialog({
  dialog,
  tokens,
  onClose,
}: {
  dialog: { title: string; result: AssetReadResult } | null;
  tokens: Tokens;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={dialog !== null}
      onOpenChange={(open) => !open && onClose()}
      title={dialog?.title ?? "预览"}
      width={760}
    >
      {dialog?.result.kind === "image" && dialog.result.dataUri ? (
        <Image
          source={{ uri: dialog.result.dataUri }}
          style={{ width: "100%", height: 360, resizeMode: "contain" }}
        />
      ) : dialog?.result.kind === "binary" ? (
        <Muted tokens={tokens}>二进制附件 · {dialog.result.size} bytes</Muted>
      ) : (
        <ScrollView style={{ maxHeight: 460 }}>
          <Mono tokens={tokens}>
            {dialog?.result.content ?? ""}
            {dialog?.result.truncated ? "\n… (已截断)" : ""}
          </Mono>
        </ScrollView>
      )}
    </Dialog>
  );
}

function IgnoreRulesDialog({
  open,
  tokens,
  projectId,
  drift,
  busy,
  onClose,
  onRestore,
}: {
  open: boolean;
  tokens: Tokens;
  projectId: string;
  drift: DriftItem[];
  busy: boolean;
  onClose: () => void;
  onRestore: (item: DriftItem) => void;
}) {
  const ignoreGet = useRpc(ignoreRulesGetRpc);
  const ignoreSet = useRpc(ignoreRulesSetRpc);
  const [raw, setRaw] = useState("");
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
        setErrors(value.errors);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ignoreGet, open, projectId]);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => !value && onClose()}
      title="忽略规则"
    >
      <Muted tokens={tokens}>
        全局规则随共享仓库同步；项目级已忽略只影响当前项目的提醒。
      </Muted>
      <TextField
        value={raw}
        onChangeText={setRaw}
        multiline
        tokens={tokens}
        testID="shared-assets-ignore-dialog-input"
      />
      {errors.map((entry) => (
        <Text
          key={`${entry.line}-${entry.message}`}
          style={{ color: tokens.colors.danger, fontSize: tokens.fontSize.sm }}
        >
          第 {entry.line} 行：{entry.message}
        </Text>
      ))}
      {notice ? (
        <Text
          style={{ color: tokens.colors.success, fontSize: tokens.fontSize.sm }}
        >
          {notice}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button
          tokens={tokens}
          size="xs"
          variant="default"
          disabled={busy}
          onPress={() => {
            void ignoreSet({ projectId, raw })
              .then(unwrap)
              .then((value) => {
                setErrors(value.errors);
                setRaw(value.raw);
                setNotice("忽略规则已保存");
              })
              .catch(() => setNotice("保存失败"));
          }}
        >
          保存规则
        </Button>
        <Button tokens={tokens} size="xs" variant="ghost" onPress={onClose}>
          关闭
        </Button>
      </View>
      <Divider tokens={tokens} />
      <Text
        style={{
          color: tokens.colors.foreground,
          fontSize: tokens.fontSize.base,
          fontWeight: "600",
        }}
      >
        项目级已忽略 · {ignored.length}
      </Text>
      {ignored.map((item) => (
        <View
          key={`${item.assetId}/${item.provider ?? ""}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingVertical: 4,
          }}
        >
          <Text
            style={{
              color: tokens.colors.foreground,
              fontSize: tokens.fontSize.sm,
              flex: 1,
              minWidth: 0,
            }}
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {item.name}
          </Text>
          <Muted tokens={tokens}>
            {KIND_LABELS[item.kind]}
            {item.provider ? ` · ${item.provider}` : ""}
          </Muted>
          <Button
            tokens={tokens}
            size="xs"
            variant="ghost"
            onPress={() => onRestore(item)}
          >
            恢复提醒
          </Button>
        </View>
      ))}
    </Dialog>
  );
}
