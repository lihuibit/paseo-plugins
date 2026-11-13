import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  AssetDiffResult,
  AssetReadResult,
  AssetSummary,
  BatchPublishPreview,
  BatchPublishResult,
  Binding,
  DriftItem,
  IgnoreRulesResult,
  InstructionStatusResult,
  InstructionTargetStatus,
  MergePreviewResult,
  MergeResolution,
  MigrationReport,
  ProjectSummary,
  ProviderStatus,
  PublishPreview,
  SkillListResult,
} from "../shared/core/types";
import type { RpcEnvelope } from "../shared/core/errors";
import { SKILL_ROOTS, SUPPORTED_PROVIDERS } from "../shared/core/providers";
import {
  assetsListRpc,
  assetReadRpc,
  batchPublishCommitRpc,
  batchPublishPreviewRpc,
  configureRpc,
  diffRpc,
  driftListRpc,
  driftResolveRpc,
  driftUnignoreRpc,
  instructionsSetEnabledRpc,
  instructionsStatusRpc,
  ignoreRulesGetRpc,
  ignoreRulesSetRpc,
  mergeApplyRpc,
  mergePreviewRpc,
  migrateLegacyRpc,
  projectsListRpc,
  providersListRpc,
  publishCommitRpc,
  publishPreviewRpc,
  skillsListRpc,
  skillsSetEnabledRpc,
  statusRpc,
  syncRpc,
  unbindRpc,
  workspacePullRpc,
} from "../shared/contracts";

type Theme = PluginScreenProps["theme"];
type Styles = ReturnType<typeof makeStyles>;
type Tab =
  "skills" | "prompt" | "knowledge" | "docs" | "changes" | "drift" | "settings";
type StatusResult = {
  binding: Binding;
  sharedExists: boolean;
  assetCounts: { skills: number; knowledge: number; docs: number };
};
type StatusCall = (input: {
  projectId: string;
}) => Promise<RpcEnvelope<StatusResult>>;
type RunAction = (label: string, work: () => Promise<void>) => Promise<void>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unwrap<T>(envelope: RpcEnvelope<T>): T {
  if (envelope.ok) return envelope.value;
  throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
}

function shortRevision(value: string | null): string {
  return value ? value.slice(0, 8) : "—";
}

function makeStyles(theme: Theme, compact: boolean) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: {
      padding: compact ? 16 : 28,
      gap: 16,
      paddingBottom: 48,
      flexShrink: 0,
    },
    detail: { gap: 16, flexShrink: 0 },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      flexWrap: "wrap",
    },
    title: {
      color: theme.colors.foreground,
      fontSize: compact ? 22 : 26,
      fontWeight: "600",
    },
    subtitle: {
      color: theme.colors.foregroundMuted,
      fontSize: 13,
      lineHeight: 18,
    },
    card: {
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 10,
      backgroundColor: theme.colors.surface1,
      padding: 16,
      gap: 10,
      flexShrink: 0,
    },
    cardPressed: { borderColor: theme.colors.accent },
    sectionTitle: {
      color: theme.colors.foreground,
      fontSize: 16,
      fontWeight: "600",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flexWrap: "wrap",
    },
    spaceBetween: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    label: { color: theme.colors.foregroundMuted, fontSize: 12 },
    value: { color: theme.colors.foreground, fontSize: 13 },
    mono: {
      color: theme.colors.foreground,
      fontSize: 12,
      fontFamily: "monospace",
    },
    monoBox: {
      backgroundColor: theme.colors.surface0,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 6,
      padding: 10,
      flexShrink: 0,
    },
    button: {
      paddingVertical: 8,
      paddingHorizontal: 12,
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
    buttonText: { color: theme.colors.foreground, fontSize: 13 },
    buttonTextPrimary: { color: theme.colors.accentForeground, fontSize: 13 },
    buttonTextDanger: { color: theme.colors.statusDanger, fontSize: 13 },
    input: {
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 6,
      backgroundColor: theme.colors.surface0,
      color: theme.colors.foreground,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 13,
    },
    textArea: { minHeight: 140, textAlignVertical: "top" },
    badge: {
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    badgeText: { fontSize: 11, color: theme.colors.foregroundMuted },
    ok: { color: theme.colors.statusSuccess, fontSize: 12 },
    warn: { color: theme.colors.statusWarning, fontSize: 12 },
    error: { color: theme.colors.statusDanger, fontSize: 12 },
    tabRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
    tab: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6 },
    tabActive: { backgroundColor: theme.colors.surface2 },
    tabText: { color: theme.colors.foregroundMuted, fontSize: 13 },
    tabTextActive: { color: theme.colors.foreground, fontWeight: "600" },
    listRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
      flexShrink: 0,
    },
    grow: { flex: 1, gap: 4 },
    empty: {
      color: theme.colors.foregroundMuted,
      fontSize: 13,
      paddingVertical: 12,
    },
    image: {
      width: "100%",
      height: 220,
      borderRadius: 6,
      resizeMode: "contain",
    },
  });
}

function Button({
  label,
  onPress,
  disabled,
  primary,
  danger,
  styles,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  styles: Styles;
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
  styles,
  tone,
}: {
  label: string;
  styles: Styles;
  tone?: "ok" | "warn";
}) {
  return (
    <View style={styles.badge}>
      <Text
        style={[
          styles.badgeText,
          tone === "ok" ? styles.ok : tone === "warn" ? styles.warn : null,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

function StatusCard({
  project,
  status,
  busy,
  onSync,
  onUnbind,
  unbindArmed,
  onArmUnbind,
  onConfigure,
  styles,
}: {
  project: ProjectSummary;
  status: StatusResult | null;
  busy: string | null;
  onSync: () => void;
  onUnbind: () => void;
  unbindArmed: boolean;
  onArmUnbind: () => void;
  onConfigure: () => void;
  styles: Styles;
}) {
  if (!project.bound) {
    return (
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>尚未绑定共享仓库</Text>
        <Text style={styles.subtitle}>
          绑定一个团队 Git 仓库后，Skill、AGENTS.md、Knowledge 与 Doc
          会出现在这里。
        </Text>
        <View style={styles.row}>
          <Button
            label="绑定仓库"
            onPress={onConfigure}
            primary
            styles={styles}
            testID="shared-assets-configure-open"
          />
        </View>
      </View>
    );
  }
  const binding = status?.binding;
  return (
    <View style={styles.card}>
      <View style={styles.spaceBetween}>
        <Text style={styles.sectionTitle}>
          {binding?.displayName ?? project.libraryId ?? "共享仓库"}
        </Text>
        <View style={styles.row}>
          <Badge
            label={binding?.syncMode === "auto" ? "自动同步" : "手动同步"}
            styles={styles}
          />
          {binding?.state.dirty ? (
            <Badge label="本地改动" styles={styles} tone="warn" />
          ) : null}
          {binding?.state.behind ? (
            <Badge
              label={`落后 ${binding.state.behind}`}
              styles={styles}
              tone="warn"
            />
          ) : null}
          {binding?.state.ahead ? (
            <Badge label={`领先 ${binding.state.ahead}`} styles={styles} />
          ) : null}
        </View>
      </View>
      <Text style={styles.mono}>{binding?.repoUrl ?? ""}</Text>
      <View style={styles.row}>
        <Text style={styles.label}>分支</Text>
        <Text style={styles.value}>{binding?.branch ?? "(默认分支)"}</Text>
        <Text style={styles.label}>本地</Text>
        <Text style={styles.mono} testID="shared-assets-local-revision">
          {shortRevision(binding?.state.localRevision ?? null)}
        </Text>
        <Text style={styles.label}>远端</Text>
        <Text style={styles.mono}>
          {shortRevision(binding?.state.remoteRevision ?? null)}
        </Text>
      </View>
      <Text style={styles.label}>
        最近同步{" "}
        {binding?.state.lastSyncedAt
          ? new Date(binding.state.lastSyncedAt).toLocaleString()
          : "—"}
      </Text>
      {binding?.state.lastError ? (
        <Text style={styles.error}>
          {binding.state.lastError.code}: {binding.state.lastError.message}
        </Text>
      ) : null}
      <View style={styles.row}>
        <Button
          label={busy === "sync" ? "同步中…" : "检查更新并同步"}
          onPress={onSync}
          disabled={busy !== null}
          primary
          styles={styles}
          testID="shared-assets-sync"
        />
        <Button
          label="重新绑定"
          onPress={onConfigure}
          disabled={busy !== null}
          styles={styles}
        />
        <Button
          label={unbindArmed ? "确认解绑（不删项目文件）" : "解绑"}
          onPress={unbindArmed ? onUnbind : onArmUnbind}
          disabled={busy !== null}
          danger
          styles={styles}
        />
        <Button
          label="刷新"
          onPress={onSync}
          disabled={busy !== null}
          styles={styles}
        />
      </View>
    </View>
  );
}

async function loadStatus(
  statusCall: StatusCall,
  projectId: string,
): Promise<StatusResult> {
  return unwrap(await statusCall({ projectId }));
}

function ConfigureForm({
  project,
  onCancel,
  onDone,
  styles,
}: {
  project: ProjectSummary;
  onCancel: () => void;
  onDone: () => void;
  styles: Styles;
}) {
  const configure = useRpc(configureRpc);
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [syncMode, setSyncMode] = useState<"auto" | "manual">("manual");
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await configure({
          projectId: project.projectId,
          repoUrl: repoUrl.trim(),
          branch: branch.trim() ? branch.trim() : null,
          syncMode,
          trustConfirmed: true,
        }),
      );
      onDone();
    } catch (value) {
      setError(messageOf(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>
        绑定共享仓库 · {project.displayName}
      </Text>
      <Text style={styles.label}>Git URL（HTTPS / SSH / 本地路径）</Text>
      <TextInput
        value={repoUrl}
        onChangeText={setRepoUrl}
        placeholder="git@example.com:team/team-assets.git"
        placeholderTextColor={styles.label.color}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        testID="shared-assets-repo-url"
      />
      <Text style={styles.label}>分支（留空使用远端默认分支）</Text>
      <TextInput
        value={branch}
        onChangeText={setBranch}
        placeholder="main"
        placeholderTextColor={styles.label.color}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        testID="shared-assets-branch"
      />
      <View style={styles.row}>
        <Button
          label="自动同步"
          onPress={() => setSyncMode("auto")}
          primary={syncMode === "auto"}
          styles={styles}
        />
        <Button
          label="手动同步"
          onPress={() => setSyncMode("manual")}
          primary={syncMode === "manual"}
          styles={styles}
        />
      </View>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: trusted }}
        onPress={() => setTrusted((value) => !value)}
        style={styles.row}
        testID="shared-assets-trust"
      >
        <View
          style={{
            width: 16,
            height: 16,
            borderRadius: 3,
            borderWidth: 1,
            borderColor: trusted ? styles.ok.color : styles.label.color,
            backgroundColor: trusted ? styles.ok.color : "transparent",
          }}
        />
        <Text style={styles.value}>我信任该仓库中的指令与 Skill 内容</Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.row}>
        <Button
          label={busy ? "绑定中…" : "绑定并同步"}
          onPress={submit}
          disabled={busy || !repoUrl.trim() || !trusted}
          primary
          styles={styles}
          testID="shared-assets-configure-submit"
        />
        <Button
          label="取消"
          onPress={onCancel}
          disabled={busy}
          styles={styles}
        />
      </View>
      <Text style={styles.label}>
        Team Assets 仓库根目录需要 team-assets.json；checkout 写入
        $PASEO_HOME/plugin-data/agentstorm-shared-assets/repos/&lt;projectId&gt;。
      </Text>
    </View>
  );
}

function SkillsTab({
  data,
  workspaceDirectory,
  busy,
  onToggle,
  styles,
}: {
  data: SkillListResult | null;
  workspaceDirectory: string | null;
  busy: string | null;
  onToggle: (assetId: string, enabled: boolean, provider?: string) => void;
  styles: Styles;
}) {
  if (!data) return <ActivityIndicator />;
  if (data.skills.length === 0) {
    return (
      <Text style={styles.empty}>
        共享仓库中没有 skills/project 或 skills/global 条目。
      </Text>
    );
  }
  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Skills</Text>
      <Text style={styles.label}>
        启用后投影到对应 Provider 的项目级 Skill
        目录；停用只删除未被修改的受管副本。
      </Text>
      {data.skills.map((skill) => {
        const projections = data.projections.filter(
          (entry) => entry.assetId === skill.assetId,
        );
        const enabled = projections.some((entry) => entry.state === "managed");
        return (
          <View
            key={skill.assetId}
            style={styles.listRow}
            testID={`shared-assets-skill-${skill.name}`}
          >
            <View style={styles.grow}>
              <Text style={styles.value}>
                {skill.name} <Text style={styles.label}>· {skill.scope}</Text>
              </Text>
              {skill.description ? (
                <Text style={styles.label}>{skill.description}</Text>
              ) : null}
              {workspaceDirectory
                ? SUPPORTED_PROVIDERS.map((provider) => (
                    <Text key={`path-${provider}`} style={styles.mono}>
                      {workspaceDirectory}/{SKILL_ROOTS[provider]}/{skill.name}
                    </Text>
                  ))
                : null}
              <View style={styles.row}>
                {SUPPORTED_PROVIDERS.map((provider) => {
                  const projection = projections.find(
                    (entry) => entry.provider === provider,
                  );
                  const label =
                    projection?.state === "managed"
                      ? `${provider} 已启用`
                      : projection?.state === "modified"
                        ? `${provider} 有本地改动`
                        : `${provider} 未启用`;
                  return (
                    <Badge
                      key={provider}
                      label={label}
                      styles={styles}
                      tone={
                        projection?.state === "managed"
                          ? "ok"
                          : projection?.state === "modified"
                            ? "warn"
                            : undefined
                      }
                    />
                  );
                })}
                <Text style={styles.label}>{skill.fileCount} 个文件</Text>
              </View>
            </View>
            <View style={styles.row}>
              {SUPPORTED_PROVIDERS.map((provider) => {
                const projection = projections.find(
                  (entry) => entry.provider === provider,
                );
                const active =
                  projection?.state === "managed" ||
                  projection?.state === "modified";
                return (
                  <Button
                    key={provider}
                    testID={`shared-assets-skill-toggle-${skill.name}-${provider}`}
                    label={`${active ? "停用" : "启用"} ${provider}`}
                    onPress={() => onToggle(skill.assetId, !active, provider)}
                    disabled={busy !== null}
                    primary={!active}
                    styles={styles}
                  />
                );
              })}
              <Button
                testID={`shared-assets-skill-toggle-${skill.name}`}
                label={enabled ? "全部停用" : "全部启用"}
                onPress={() => onToggle(skill.assetId, !enabled, "both")}
                disabled={busy !== null}
                styles={styles}
              />
            </View>
          </View>
        );
      })}
      {data.warnings.map((warning) => (
        <Text key={warning} style={styles.warn}>
          {warning}
        </Text>
      ))}
    </View>
  );
}

function targetLabel(target: InstructionTargetStatus): string {
  if (target.state === "managed") return "已投影";
  if (target.state === "conflict") return "冲突";
  return "未投影";
}

function PromptTab({
  project,
  status,
  workspaceId,
  content,
  busy,
  onToggle,
  styles,
}: {
  project: ProjectSummary;
  status: InstructionStatusResult | null;
  workspaceId: string | null;
  content: string | null;
  busy: string | null;
  onToggle: (provider: string, enabled: boolean) => void;
  styles: Styles;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>SYSTEM Prompt / AGENTS.md</Text>
      <Text style={styles.label}>
        链路：共享 AGENTS.md → 项目 .agentstorm/AGENTS.md → Provider 原生入口。
      </Text>
      {!workspaceId ? (
        <Text style={styles.warn}>
          该项目还没有 Workspace，创建 Workspace 后才能投影。
        </Text>
      ) : null}
      <View style={styles.row}>
        <Text style={styles.label}>共享文件</Text>
        <Badge
          label={status?.sharedExists ? "存在" : "缺失"}
          styles={styles}
          tone={status?.sharedExists ? "ok" : "warn"}
        />
        <Text style={styles.label}>canonical</Text>
        <Badge
          label={
            status?.canonical.exists
              ? status.canonical.matchesShared
                ? "与共享一致"
                : "内容不同"
              : "未创建"
          }
          styles={styles}
          tone={status?.canonical.matchesShared ? "ok" : "warn"}
        />
      </View>
      <View style={styles.grow}>
        {status?.targets.map((target) => (
          <View key={target.provider} style={styles.listRow}>
            <View style={styles.grow}>
              <Text style={styles.value}>{target.provider}</Text>
              <Text style={styles.mono}>{target.targetPath}</Text>
            </View>
            <Badge
              label={targetLabel(target)}
              styles={styles}
              tone={
                target.state === "managed"
                  ? "ok"
                  : target.state === "conflict"
                    ? "warn"
                    : undefined
              }
            />
            <Button
              label={target.state === "managed" ? "停用" : "启用"}
              onPress={() =>
                onToggle(target.provider, target.state !== "managed")
              }
              disabled={busy !== null}
              styles={styles}
            />
          </View>
        ))}
      </View>
      <View style={styles.row}>
        <Button
          label="投影到两个 Provider"
          onPress={() => onToggle("both", true)}
          disabled={busy !== null || !workspaceId}
          primary
          styles={styles}
          testID="shared-assets-instructions-enable"
        />
        <Button
          label="全部停用"
          onPress={() => onToggle("both", false)}
          disabled={busy !== null || !workspaceId}
          styles={styles}
        />
      </View>
      {content ? (
        <View style={styles.monoBox}>
          <Text style={styles.mono} testID="shared-assets-prompt-content">
            {content.slice(0, 4000)}
          </Text>
        </View>
      ) : (
        <Text style={styles.empty}>
          {project.bound ? "共享仓库没有根 AGENTS.md。" : ""}
        </Text>
      )}
    </View>
  );
}

function PublishBox({
  projectId,
  assetId,
  path,
  content,
  onChange,
  styles,
}: {
  projectId: string;
  assetId: string;
  path?: string;
  content: string;
  onChange: (value: string) => void;
  styles: Styles;
}) {
  const previewCall = useRpc(publishPreviewRpc);
  const commitCall = useRpc(publishCommitRpc);
  const [preview, setPreview] = useState<PublishPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const doPreview = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setPreview(
        unwrap(await previewCall({ projectId, assetId, path, content })),
      );
    } catch (value) {
      setError(messageOf(value));
    } finally {
      setBusy(false);
    }
  };

  const doCommit = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = unwrap(
        await commitCall({
          projectId,
          assetId,
          path,
          content,
          expectedRevision: preview.expectedRevision,
        }),
      );
      setPreview(null);
      setNotice(
        `已生成 commit ${result.commit.slice(0, 8)}。${result.pushHint}`,
      );
    } catch (value) {
      setError(messageOf(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>发布到共享仓库</Text>
      <TextInput
        value={content}
        onChangeText={(value) => {
          onChange(value);
          setPreview(null);
        }}
        multiline
        style={[styles.input, styles.textArea]}
        testID="shared-assets-publish-content"
      />
      <View style={styles.row}>
        <Button
          label="校验并预览 diff"
          onPress={doPreview}
          disabled={busy}
          primary
          styles={styles}
          testID="shared-assets-publish-preview"
        />
        <Button
          label={busy ? "处理中…" : "提交到共享仓库"}
          onPress={doCommit}
          disabled={busy || !preview}
          styles={styles}
          testID="shared-assets-publish-commit"
        />
      </View>
      <Text style={styles.label}>
        校验：路径、大小、凭据文件名、Skill frontmatter；push 需手动执行。
      </Text>
      {preview ? (
        <View style={styles.monoBox}>
          <Text style={styles.label}>目标：{preview.item.targetPath}</Text>
          <Text style={styles.mono} testID="shared-assets-publish-diff">
            {preview.item.diff || "(无差异)"}
          </Text>
        </View>
      ) : null}
      {notice ? <Text style={styles.ok}>{notice}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function KnowledgeTab({
  projectId,
  assets,
  styles,
}: {
  projectId: string;
  assets: AssetSummary[];
  styles: Styles;
}) {
  const readCall = useRpc(assetReadRpc);
  const knowledge = assets.filter((asset) => asset.kind === "knowledge");
  const [selected, setSelected] = useState<AssetSummary | null>(null);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelected(knowledge[0] ?? null);
  }, [knowledge.length]);

  useEffect(() => {
    if (!selected) {
      setContent("");
      return;
    }
    let cancelled = false;
    void readCall({ projectId, assetId: selected.assetId })
      .then(unwrap)
      .then((result: AssetReadResult) => {
        if (!cancelled) {
          setContent(result.content ?? "");
          setError(null);
        }
      })
      .catch((value) => {
        if (!cancelled) setError(messageOf(value));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selected, readCall]);

  if (knowledge.length === 0) {
    return <Text style={styles.empty}>共享仓库中没有 knowledge/*.md。</Text>;
  }

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Knowledge</Text>
      <View style={styles.row}>
        {knowledge.map((asset) => (
          <Button
            key={asset.assetId}
            label={asset.name}
            onPress={() => setSelected(asset)}
            primary={selected?.assetId === asset.assetId}
            styles={styles}
          />
        ))}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {selected ? (
        <PublishBox
          projectId={projectId}
          assetId={selected.assetId}
          content={content}
          onChange={setContent}
          styles={styles}
        />
      ) : null}
    </View>
  );
}

function DocsTab({
  projectId,
  assets,
  styles,
}: {
  projectId: string;
  assets: AssetSummary[];
  styles: Styles;
}) {
  const readCall = useRpc(assetReadRpc);
  const docs = assets.filter((asset) => asset.kind === "doc");
  const [doc, setDoc] = useState<AssetSummary | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [read, setRead] = useState<AssetReadResult | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const first = docs[0] ?? null;
    setDoc(first);
    setFile(first?.files[0]?.path ?? null);
  }, [docs.length]);

  useEffect(() => {
    if (!doc || !file) return;
    let cancelled = false;
    void readCall({ projectId, assetId: doc.assetId, path: file })
      .then(unwrap)
      .then((result) => {
        if (cancelled) return;
        setRead(result);
        setText(result.content ?? "");
        setError(null);
      })
      .catch((value) => {
        if (!cancelled) setError(messageOf(value));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, doc, file, readCall]);

  if (docs.length === 0) {
    return (
      <Text style={styles.empty}>
        共享仓库中没有 docs/&lt;name&gt;/ 目录包。
      </Text>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>Doc 目录包</Text>
      <View style={styles.row}>
        {docs.map((asset) => (
          <Button
            key={asset.assetId}
            label={`${asset.name} (${asset.fileCount})`}
            onPress={() => {
              setDoc(asset);
              setFile(asset.files[0]?.path ?? null);
            }}
            primary={doc?.assetId === asset.assetId}
            styles={styles}
          />
        ))}
      </View>
      {doc ? (
        <View style={styles.row}>
          {doc.files.map((entry) => (
            <Button
              key={entry.path}
              label={entry.path}
              onPress={() => setFile(entry.path)}
              primary={file === entry.path}
              styles={styles}
            />
          ))}
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {read?.kind === "image" && read.dataUri ? (
        <Image
          source={{ uri: read.dataUri }}
          style={styles.image}
          testID="shared-assets-doc-image"
        />
      ) : null}
      {read && read.kind === "binary" ? (
        <Text style={styles.label}>二进制附件 · {read.size} bytes</Text>
      ) : null}
      {doc && file && read?.kind === "text" ? (
        <PublishBox
          projectId={projectId}
          assetId={doc.assetId}
          path={file}
          content={text}
          onChange={setText}
          styles={styles}
        />
      ) : null}
    </View>
  );
}

function driftLabel(status: DriftItem["status"]): string {
  if (status === "synced") return "已同步";
  if (status === "local-update") return "本地已修改";
  if (status === "remote-update") return "共享已更新";
  if (status === "diverged") return "双方已修改";
  if (status === "remote-deleted") return "共享已删除";
  if (status === "unpublished-local") return "仅本地存在";
  return "本地缺失";
}

function driftTone(status: DriftItem["status"]): "ok" | "warn" | undefined {
  if (status === "synced") return "ok";
  if (status === "diverged" || status === "remote-deleted") return "warn";
  return undefined;
}

function pathForItem(item: DriftItem): string | undefined {
  return (
    item.files.find((file) => file.status !== "synced")?.path ??
    item.files[0]?.path
  );
}

function DriftTab({
  projectId,
  workspaceId,
  items,
  run,
  onReload,
  styles,
}: {
  projectId: string;
  workspaceId: string | null;
  items: DriftItem[];
  run: RunAction;
  onReload: () => void;
  styles: Styles;
}) {
  const diffCall = useRpc(diffRpc);
  const mergePreviewCall = useRpc(mergePreviewRpc);
  const mergeApplyCall = useRpc(mergeApplyRpc);
  const resolveCall = useRpc(driftResolveRpc);
  const unignoreCall = useRpc(driftUnignoreRpc);
  const pullCall = useRpc(workspacePullRpc);
  const [diff, setDiff] = useState<AssetDiffResult | null>(null);
  const [merge, setMerge] = useState<MergePreviewResult | null>(null);
  const [mergeTarget, setMergeTarget] = useState<{
    assetId: string;
    path?: string;
    provider?: string;
  } | null>(null);
  const [resolutions, setResolutions] = useState<
    Record<string, MergeResolution>
  >({});

  if (!workspaceId) {
    return <Text style={styles.warn}>该项目还没有 Workspace。</Text>;
  }

  const viewDiff = (item: DriftItem) =>
    run("diff", async () => {
      setMerge(null);
      setDiff(
        unwrap(
          await diffCall({
            projectId,
            workspaceId,
            assetId: item.assetId,
            path: pathForItem(item),
            provider: item.provider ?? undefined,
          }),
        ) as AssetDiffResult,
      );
    });

  const openMerge = (item: DriftItem) =>
    run("merge", async () => {
      setDiff(null);
      setResolutions({});
      setMergeTarget({
        assetId: item.assetId,
        path: pathForItem(item),
        provider: item.provider ?? undefined,
      });
      setMerge(
        unwrap(
          await mergePreviewCall({
            projectId,
            workspaceId,
            assetId: item.assetId,
            path: pathForItem(item),
            provider: item.provider ?? undefined,
          }),
        ) as MergePreviewResult,
      );
    });

  const applyMergeResult = () =>
    run("merge-apply", async () => {
      if (!merge) return;
      const merged = unwrap(
        await mergeApplyCall({
          projectId,
          workspaceId,
          assetId: merge.assetId,
          path: merge.repositoryPath,
          resolutions: merge.conflicts.map(
            (conflict) =>
              resolutions[conflict.id] ?? {
                conflictId: conflict.id,
                choice: "local" as const,
              },
          ),
          expectedLocalDigest: merge.expectedLocalDigest,
          expectedRemoteDigest: merge.expectedRemoteDigest,
        }),
      );
      setMerge(null);
      setResolutions({});
      setDiff(
        unwrap(
          await diffCall({
            projectId,
            workspaceId,
            assetId: merged.assetId,
            path: mergeTarget?.path ?? merged.repositoryPath,
            provider: mergeTarget?.provider,
          }),
        ) as AssetDiffResult,
      );
      setMergeTarget(null);
      onReload();
    });

  const act = (item: DriftItem, action: "overwrite" | "keep") =>
    run(action, async () => {
      unwrap(
        await resolveCall({
          projectId,
          workspaceId,
          assetId: item.assetId,
          path: null,
          provider: item.provider ?? undefined,
          action,
        }),
      );
      setDiff(null);
      setMerge(null);
      onReload();
    });

  return (
    <View style={styles.card} testID="shared-assets-drift">
      <View style={styles.spaceBetween}>
        <Text style={styles.sectionTitle}>Drift 检测</Text>
        <Button
          label="从共享仓库刷新本地副本"
          onPress={() =>
            run("pull", async () => {
              unwrap(await pullCall({ projectId, workspaceId }));
              onReload();
            })
          }
          styles={styles}
          testID="shared-assets-workspace-pull"
        />
      </View>
      <Text style={styles.label}>
        对比本地副本、共享仓库与上次同步基线；本地改动不会被自动覆盖。
      </Text>
      {items.length === 0 ? (
        <Text style={styles.empty}>还没有可跟踪的投影资产。</Text>
      ) : null}
      {items.map((item) => (
        <View
          key={`${item.assetId}/${item.provider ?? ""}`}
          style={styles.listRow}
          testID={`shared-assets-drift-${item.name}`}
        >
          <View style={styles.grow}>
            <Text style={styles.value}>
              {item.name}
              <Text style={styles.label}>
                {" "}
                · {item.kind}
                {item.provider ? ` · ${item.provider}` : ""}
              </Text>
            </Text>
            <Text style={styles.mono}>{item.targetPath}</Text>
            <Text style={styles.label}>
              {item.files.length} 个文件
              {item.files
                .filter((file) => file.status !== "synced")
                .slice(0, 3)
                .map((file) => ` · ${file.path}`)
                .join("")}
            </Text>
          </View>
          <Badge
            label={driftLabel(item.status)}
            styles={styles}
            tone={driftTone(item.status)}
          />
          {item.ignored ? (
            <Button
              label="取消忽略"
              onPress={() =>
                run("unignore", async () => {
                  unwrap(
                    await unignoreCall({
                      projectId,
                      workspaceId,
                      assetId: item.assetId,
                      path: null,
                      provider: item.provider ?? undefined,
                    }),
                  );
                  onReload();
                })
              }
              styles={styles}
            />
          ) : (
            <>
              <Button
                label="查看差异"
                onPress={() => viewDiff(item)}
                styles={styles}
                testID={`shared-assets-diff-${item.name}`}
              />
              <Button
                label="合并"
                onPress={() => openMerge(item)}
                styles={styles}
                testID={`shared-assets-merge-${item.name}`}
              />
              <Button
                label="覆盖本地"
                onPress={() => act(item, "overwrite")}
                styles={styles}
              />
              <Button
                label="保留并忽略"
                onPress={() => act(item, "keep")}
                styles={styles}
              />
            </>
          )}
        </View>
      ))}

      {diff ? (
        <View style={styles.monoBox}>
          <Text style={styles.sectionTitle}>
            {diff.assetId} {diff.path ? `· ${diff.path}` : ""}
          </Text>
          {diff.kind === "binary" ? (
            <Text style={styles.warn}>二进制文件，仅支持覆盖或保留。</Text>
          ) : (
            <>
              <Text style={styles.label}>基线 → 本地</Text>
              <Text style={styles.mono} testID="shared-assets-diff-local">
                {diff.localDiff || "(无变化)"}
              </Text>
              <Text style={styles.label}>基线 → 共享</Text>
              <Text style={styles.mono} testID="shared-assets-diff-remote">
                {diff.remoteDiff || "(无变化)"}
              </Text>
            </>
          )}
        </View>
      ) : null}

      {merge ? (
        <View style={styles.monoBox} testID="shared-assets-merge-panel">
          <Text style={styles.sectionTitle}>
            三方合并 · {merge.repositoryPath}
          </Text>
          <Text style={styles.label}>
            {merge.conflicts.length === 0
              ? "无冲突，可直接应用自动合并结果。"
              : `${merge.conflicts.length} 个冲突块，未全部选择前不能保存。`}
          </Text>
          {merge.conflicts.map((conflict) => {
            const current = resolutions[conflict.id];
            return (
              <View key={conflict.id} style={styles.card}>
                <Text style={styles.value}>冲突 {conflict.id}</Text>
                <Text style={styles.label}>本地</Text>
                <Text style={styles.mono}>{conflict.local}</Text>
                <Text style={styles.label}>共享</Text>
                <Text style={styles.mono}>{conflict.remote}</Text>
                <View style={styles.row}>
                  {(["local", "remote", "both", "custom"] as const).map(
                    (choice) => (
                      <Button
                        key={choice}
                        label={
                          choice === "local"
                            ? "采用本地"
                            : choice === "remote"
                              ? "采用共享"
                              : choice === "both"
                                ? "两者保留"
                                : "自定义"
                        }
                        onPress={() =>
                          setResolutions((value) => ({
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
                        primary={current?.choice === choice}
                        styles={styles}
                        testID={`shared-assets-conflict-${conflict.id}-${choice}`}
                      />
                    ),
                  )}
                </View>
                {current?.choice === "custom" ? (
                  <TextInput
                    value={current.content ?? ""}
                    onChangeText={(content) =>
                      setResolutions((value) => ({
                        ...value,
                        [conflict.id]: {
                          conflictId: conflict.id,
                          choice: "custom",
                          content,
                        },
                      }))
                    }
                    multiline
                    style={[styles.input, styles.textArea]}
                  />
                ) : null}
              </View>
            );
          })}
          <View style={styles.row}>
            <Button
              label={
                merge.conflicts.length > 0 &&
                merge.conflicts.some((conflict) => !resolutions[conflict.id])
                  ? "还有冲突未解决"
                  : "保存合并结果"
              }
              onPress={applyMergeResult}
              disabled={
                merge.conflicts.length > 0 &&
                merge.conflicts.some((conflict) => !resolutions[conflict.id])
              }
              primary
              styles={styles}
              testID="shared-assets-merge-apply"
            />
            <Button
              label="关闭"
              onPress={() => setMerge(null)}
              styles={styles}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function ChangesTab({
  projectId,
  workspaceId,
  assets,
  run,
  onReload,
  styles,
}: {
  projectId: string;
  workspaceId: string | null;
  assets: AssetSummary[];
  run: RunAction;
  onReload: () => void;
  styles: Styles;
}) {
  const previewCall = useRpc(batchPublishPreviewRpc);
  const commitCall = useRpc(batchPublishCommitRpc);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<BatchPublishPreview | null>(null);
  const [result, setResult] = useState<BatchPublishResult | null>(null);

  if (!workspaceId) {
    return <Text style={styles.warn}>该项目还没有 Workspace。</Text>;
  }
  const toggle = (assetId: string) => {
    setPreview(null);
    setSelected((value) =>
      value.includes(assetId)
        ? value.filter((entry) => entry !== assetId)
        : [...value, assetId],
    );
  };

  const doPreview = () =>
    run("batch-preview", async () => {
      setResult(null);
      setPreview(
        unwrap(
          await previewCall({
            projectId,
            workspaceId,
            items: selected.map((assetId) => ({ assetId })),
          }),
        ) as BatchPublishPreview,
      );
    });

  const doCommit = () =>
    run("batch-publish", async () => {
      if (!preview) return;
      const value = unwrap(
        await commitCall({
          projectId,
          workspaceId,
          items: selected.map((assetId) => ({ assetId })),
          expectedRevision: preview.expectedRevision,
        }),
      ) as BatchPublishResult;
      setResult(value);
      setPreview(null);
      onReload();
    });

  const publishable =
    preview?.items.filter(
      (item) => item.state === "eligible" || item.state === "warning",
    ).length ?? 0;

  return (
    <View style={styles.card} testID="shared-assets-changes">
      <View style={styles.spaceBetween}>
        <Text style={styles.sectionTitle}>选择性批量发布</Text>
        <View style={styles.row}>
          <Button
            label="全选"
            onPress={() => setSelected(assets.map((asset) => asset.assetId))}
            styles={styles}
          />
          <Button
            label="清空"
            onPress={() => setSelected([])}
            styles={styles}
          />
        </View>
      </View>
      <Text style={styles.label}>
        只发布勾选的资产；逐项校验，部分失败不阻断其余项；有未解决冲突的资产会被拒绝。
      </Text>
      {assets.map((asset) => {
        const checked = selected.includes(asset.assetId);
        return (
          <Pressable
            key={asset.assetId}
            accessibilityRole="checkbox"
            accessibilityState={{ checked }}
            onPress={() => toggle(asset.assetId)}
            style={styles.listRow}
            testID={`shared-assets-select-${asset.name}`}
          >
            <View
              style={{
                width: 16,
                height: 16,
                borderRadius: 3,
                borderWidth: 1,
                borderColor: checked ? styles.ok.color : styles.label.color,
                backgroundColor: checked ? styles.ok.color : "transparent",
              }}
            />
            <View style={styles.grow}>
              <Text style={styles.value}>
                {asset.name} <Text style={styles.label}>· {asset.kind}</Text>
              </Text>
              <Text style={styles.label}>
                {asset.path} · {asset.fileCount} 个文件
              </Text>
            </View>
          </Pressable>
        );
      })}
      <View style={styles.row}>
        <Button
          label="校验选中"
          onPress={doPreview}
          disabled={selected.length === 0}
          primary
          styles={styles}
          testID="shared-assets-batch-preview"
        />
        <Button
          label={`发布选中（${publishable} 项可发布）`}
          onPress={doCommit}
          disabled={!preview || publishable === 0}
          styles={styles}
          testID="shared-assets-batch-commit"
        />
      </View>
      {preview ? (
        <View style={styles.monoBox}>
          <Text style={styles.label}>
            基线 revision {preview.expectedRevision.slice(0, 8)}
          </Text>
          {preview.items.map((item) => (
            <View key={item.assetId} style={styles.listRow}>
              <View style={styles.grow}>
                <Text style={styles.value}>
                  {item.name} · {item.state}
                </Text>
                {item.reasons.map((reason) => (
                  <Text key={reason.code} style={styles.error}>
                    {reason.code}: {reason.message}
                  </Text>
                ))}
                <Text style={styles.mono}>
                  {item.diff.slice(0, 2000) || "(无差异)"}
                </Text>
              </View>
            </View>
          ))}
          {preview.skipped.map((entry) => (
            <Text key={entry.assetId} style={styles.warn}>
              {entry.assetId}: {entry.reason}
            </Text>
          ))}
        </View>
      ) : null}
      {result ? (
        <View style={styles.monoBox} testID="shared-assets-batch-result">
          <Text style={styles.value}>
            {result.commit
              ? `已提交 ${result.commit.slice(0, 8)}`
              : "没有写入提交"}
          </Text>
          <Text style={styles.ok}>
            成功 {result.published.length} · 失败 {result.failed.length} · 跳过{" "}
            {result.skipped.length}
          </Text>
          {result.published.map((entry) => (
            <Text key={`ok-${entry.assetId}`} style={styles.ok}>
              {entry.assetId}: {entry.files.join(", ")}
            </Text>
          ))}
          {result.failed.map((entry) => (
            <Text key={`fail-${entry.assetId}`} style={styles.error}>
              {entry.assetId}: {entry.reason}
            </Text>
          ))}
          <Text style={styles.label}>{result.pushHint}</Text>
        </View>
      ) : null}
    </View>
  );
}

function SettingsTab({
  projectId,
  workspaceId,
  run,
  styles,
}: {
  projectId: string;
  workspaceId: string | null;
  run: RunAction;
  styles: Styles;
}) {
  const providersCall = useRpc(providersListRpc);
  const ignoreGet = useRpc(ignoreRulesGetRpc);
  const ignoreSet = useRpc(ignoreRulesSetRpc);
  const migrateCall = useRpc(migrateLegacyRpc);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [raw, setRaw] = useState("");
  const [ignoreResult, setIgnoreResult] = useState<IgnoreRulesResult | null>(
    null,
  );
  const [migration, setMigration] = useState<MigrationReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    void providersCall({})
      .then(unwrap)
      .then((value) => {
        if (!cancelled) setProviders(value as ProviderStatus[]);
      })
      .catch(() => {});
    void ignoreGet({ projectId })
      .then(unwrap)
      .then((value) => {
        if (cancelled) return;
        setRaw(value.raw);
        setIgnoreResult(value as IgnoreRulesResult);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ignoreGet, projectId, providersCall]);

  return (
    <View style={styles.detail}>
      <View style={styles.card} testID="shared-assets-providers">
        <Text style={styles.sectionTitle}>Provider 矩阵</Text>
        <Text style={styles.label}>
          只有已验证的目录才会默认启用；未验证项会明确标注。
        </Text>
        {providers.map((provider) => (
          <View key={provider.id} style={styles.listRow}>
            <View style={styles.grow}>
              <Text style={styles.value}>{provider.label}</Text>
              <Text style={styles.mono}>
                skill: {provider.skillRoot ?? "不投影"} · prompt:{" "}
                {provider.instructionEntrypoint ?? "不投影"}
              </Text>
              <Text style={styles.label}>{provider.note}</Text>
            </View>
            <Badge
              label={provider.installed ? "已安装" : "未安装"}
              styles={styles}
              tone={provider.installed ? "ok" : undefined}
            />
            <Badge
              label={provider.skillVerified ? "已验证" : "未验证"}
              styles={styles}
              tone={provider.skillVerified ? "ok" : "warn"}
            />
          </View>
        ))}
      </View>

      <View style={styles.card} testID="shared-assets-ignore">
        <Text style={styles.sectionTitle}>Ignore 规则</Text>
        <Text style={styles.label}>
          每行一条：path:&lt;glob&gt;、kind:&lt;skill|prompt|knowledge|doc&gt;、
          asset:&lt;assetId&gt;，也可以直接写路径。保存会提交到共享仓库。
        </Text>
        <TextInput
          value={raw}
          onChangeText={setRaw}
          multiline
          style={[styles.input, styles.textArea]}
          testID="shared-assets-ignore-input"
        />
        {ignoreResult?.errors.map((error) => (
          <Text key={`${error.line}-${error.message}`} style={styles.error}>
            第 {error.line} 行：{error.message}
          </Text>
        ))}
        <View style={styles.row}>
          <Button
            label="保存规则"
            primary
            onPress={() =>
              run("ignore-save", async () => {
                const value = unwrap(
                  await ignoreSet({ projectId, raw }),
                ) as IgnoreRulesResult & { commit: string | null };
                setIgnoreResult(value);
                setRaw(value.raw);
              })
            }
            styles={styles}
            testID="shared-assets-ignore-save"
          />
        </View>
      </View>

      <View style={styles.card} testID="shared-assets-migration">
        <Text style={styles.sectionTitle}>.agentstorm/ 一次性迁移</Text>
        <Text style={styles.label}>
          只读导入 AGENTS.md、knowledge、docs 到共享 checkout；workflows
          跳过，源目录不删除，冲突项不覆盖。
        </Text>
        <View style={styles.row}>
          <Button
            label="预览迁移"
            onPress={() =>
              run("migrate-preview", async () => {
                if (!workspaceId) throw new Error("该项目还没有 Workspace");
                setMigration(
                  unwrap(
                    await migrateCall({
                      projectId,
                      workspaceId,
                      dryRun: true,
                    }),
                  ) as MigrationReport,
                );
              })
            }
            disabled={!workspaceId}
            primary
            styles={styles}
            testID="shared-assets-migrate-preview"
          />
          <Button
            label="执行导入"
            onPress={() =>
              run("migrate-apply", async () => {
                if (!workspaceId) throw new Error("该项目还没有 Workspace");
                setMigration(
                  unwrap(
                    await migrateCall({
                      projectId,
                      workspaceId,
                      dryRun: false,
                    }),
                  ) as MigrationReport,
                );
              })
            }
            disabled={
              !workspaceId ||
              !migration ||
              !migration.files.some((file) => file.action === "import")
            }
            styles={styles}
            testID="shared-assets-migrate-apply"
          />
        </View>
        {migration ? (
          <View style={styles.monoBox}>
            <Text style={styles.value}>
              {migration.dryRun
                ? "预览"
                : migration.applied
                  ? "已导入"
                  : "无变更"}
              {migration.reused ? "（源未变化，复用上次结果）" : ""}
            </Text>
            <Text style={styles.label}>
              源：{migration.before.files} 个文件 / {migration.before.bytes}{" "}
              bytes → 目标：{migration.after.files} 个文件 /{" "}
              {migration.after.bytes} bytes
            </Text>
            {migration.files.map((file) => (
              <Text
                key={`${file.sourcePath}-${file.repositoryPath}`}
                style={
                  file.action === "conflict"
                    ? styles.error
                    : file.action === "import"
                      ? styles.ok
                      : styles.label
                }
              >
                {file.action}: {file.sourcePath} → {file.repositoryPath}
                {file.reason ? `（${file.reason}）` : ""}
              </Text>
            ))}
            {migration.skipped.map((entry) => (
              <Text key={`skip-${entry.path}`} style={styles.warn}>
                跳过 {entry.path}：{entry.reason}
              </Text>
            ))}
            {migration.candidates.skills.length > 0 ? (
              <Text style={styles.label}>
                可发布 Skill 候选：{migration.candidates.skills.join(", ")}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function ProjectDetail({
  project,
  onBack,
  onChanged,
  styles,
}: {
  project: ProjectSummary;
  onBack: () => void;
  onChanged: () => void;
  styles: Styles;
}) {
  const statusCall = useRpc(statusRpc);
  const assetsCall = useRpc(assetsListRpc);
  const skillsCall = useRpc(skillsListRpc);
  const instructionsCall = useRpc(instructionsStatusRpc);
  const instructionsSet = useRpc(instructionsSetEnabledRpc);
  const skillsSet = useRpc(skillsSetEnabledRpc);
  const syncCall = useRpc(syncRpc);
  const unbindCall = useRpc(unbindRpc);
  const readCall = useRpc(assetReadRpc);
  const driftCall = useRpc(driftListRpc);

  const [workspaceId, setWorkspaceId] = useState<string | null>(
    project.workspaces.find((entry) => !entry.background)?.workspaceId ??
      project.workspaces[0]?.workspaceId ??
      null,
  );
  const [tab, setTab] = useState<Tab>("skills");
  const [configuring, setConfiguring] = useState(false);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [skills, setSkills] = useState<SkillListResult | null>(null);
  const [instructions, setInstructions] =
    useState<InstructionStatusResult | null>(null);
  const [promptContent, setPromptContent] = useState<string | null>(null);
  const [drift, setDrift] = useState<DriftItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    if (!project.bound) {
      setStatus(null);
      setAssets([]);
      setSkills(null);
      setInstructions(null);
      setPromptContent(null);
      setDrift([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [statusValue, assetsValue, skillsValue, driftValue] =
          await Promise.all([
            loadStatus(statusCall, project.projectId),
            assetsCall({ projectId: project.projectId }).then(unwrap),
            workspaceId
              ? skillsCall({ projectId: project.projectId, workspaceId }).then(
                  unwrap,
                )
              : Promise.resolve(null),
            workspaceId
              ? driftCall({ projectId: project.projectId, workspaceId }).then(
                  unwrap,
                )
              : Promise.resolve([]),
          ]);
        if (cancelled) return;
        setStatus(statusValue);
        setAssets(assetsValue);
        setSkills(skillsValue as SkillListResult | null);
        setDrift(driftValue as DriftItem[]);
        setError(null);
        if (workspaceId) {
          const [instructionValue, prompt] = await Promise.all([
            instructionsCall({
              projectId: project.projectId,
              workspaceId,
            }).then(unwrap),
            readCall({ projectId: project.projectId, assetId: "prompt" })
              .then(unwrap)
              .then((result: AssetReadResult) => result.content)
              .catch(() => null),
          ]);
          if (cancelled) return;
          setInstructions(instructionValue as InstructionStatusResult);
          setPromptContent(prompt);
        } else {
          setInstructions(null);
          setPromptContent(null);
        }
      } catch (value) {
        if (!cancelled) setError(messageOf(value));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    assetsCall,
    driftCall,
    instructionsCall,
    project.bound,
    project.projectId,
    readCall,
    refreshKey,
    skillsCall,
    statusCall,
    workspaceId,
  ]);

  const action = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (value) {
      setError(messageOf(value));
    } finally {
      setBusy(null);
    }
  };

  const toggleSkill = (assetId: string, enabled: boolean, provider = "both") =>
    action(enabled ? "启用 Skill" : "停用 Skill", async () => {
      if (!workspaceId) throw new Error("该项目还没有 Workspace");
      const result = unwrap(
        await skillsSet({
          projectId: project.projectId,
          workspaceId,
          assetId,
          provider,
          enabled,
        }),
      );
      const kept = result.kept.map((entry) => entry.targetPath);
      const errors = result.errors.map(
        (entry) => `${entry.provider}: ${entry.message}`,
      );
      if (errors.length > 0) setError(errors.join("\n"));
      if (kept.length > 0) setNotice(`已保留本地修改：${kept.join(", ")}`);
      reload();
    });

  const toggleInstructions = (provider: string, enabled: boolean) =>
    action(enabled ? "投影指令" : "停用指令投影", async () => {
      if (!workspaceId) throw new Error("该项目还没有 Workspace");
      const result = unwrap(
        await instructionsSet({
          projectId: project.projectId,
          workspaceId,
          provider,
          enabled,
        }),
      );
      if (result.kept.length > 0) {
        setNotice(
          `已保留：${result.kept.map((entry) => entry.targetPath).join(", ")}`,
        );
      }
      reload();
    });

  return (
    <View style={styles.detail}>
      <View style={styles.headerRow}>
        <View style={styles.grow}>
          <Text style={styles.title}>{project.displayName}</Text>
          <Text style={styles.subtitle}>{project.rootPath}</Text>
        </View>
        <Button label="返回项目列表" onPress={onBack} styles={styles} />
      </View>

      {project.workspaces.length > 1 ? (
        <View style={styles.row}>
          <Text style={styles.label}>Workspace</Text>
          {project.workspaces.map((workspace) => (
            <Button
              key={workspace.workspaceId}
              label={workspace.name}
              onPress={() => setWorkspaceId(workspace.workspaceId)}
              primary={workspaceId === workspace.workspaceId}
              styles={styles}
            />
          ))}
        </View>
      ) : project.workspaces[0] ? (
        <Text style={styles.label}>
          投影目录：{project.workspaces[0].directory}
        </Text>
      ) : (
        <Text style={styles.warn}>
          该项目尚无 Workspace；绑定可用，但投影需要 Workspace。
        </Text>
      )}

      {configuring || !project.bound ? (
        <ConfigureForm
          project={project}
          onCancel={() => setConfiguring(false)}
          onDone={() => {
            setConfiguring(false);
            reload();
            onChanged();
          }}
          styles={styles}
        />
      ) : (
        <StatusCard
          project={project}
          status={status}
          busy={busy}
          onSync={() =>
            action("sync", async () => {
              const result = unwrap(
                await syncCall({ projectId: project.projectId }),
              );
              setNotice(
                result.changed
                  ? "已同步到远端最新提交。"
                  : "已是最新，无需更新。",
              );
              reload();
            })
          }
          onUnbind={() =>
            action("unbind", async () => {
              setConfirmUnbind(false);
              const result = unwrap(
                await unbindCall({ projectId: project.projectId }),
              );
              setNotice(
                `已解绑。移除受管投影 ${result.removedProjections.length} 项；保留 ${result.preserved.length} 项本地修改。项目文件未被删除。`,
              );
              reload();
              onChanged();
            })
          }
          unbindArmed={confirmUnbind}
          onArmUnbind={() => setConfirmUnbind(true)}
          onConfigure={() => setConfiguring(true)}
          styles={styles}
        />
      )}

      {busy ? <ActivityIndicator /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {notice ? <Text style={styles.ok}>{notice}</Text> : null}

      {project.bound ? (
        <>
          <View style={styles.tabRow}>
            {(
              [
                "skills",
                "prompt",
                "knowledge",
                "docs",
                "changes",
                "drift",
                "settings",
              ] as const
            ).map((value) => (
              <Pressable
                key={value}
                accessibilityRole="tab"
                onPress={() => setTab(value)}
                style={[styles.tab, tab === value ? styles.tabActive : null]}
              >
                <Text
                  style={[
                    styles.tabText,
                    tab === value ? styles.tabTextActive : null,
                  ]}
                >
                  {value === "skills"
                    ? "Skills"
                    : value === "prompt"
                      ? "SYSTEM Prompt"
                      : value === "knowledge"
                        ? "Knowledge"
                        : value === "docs"
                          ? "Docs"
                          : value === "changes"
                            ? "变更 / 发布"
                            : value === "drift"
                              ? "Drift"
                              : "设置"}
                </Text>
              </Pressable>
            ))}
          </View>
          {tab === "skills" ? (
            <SkillsTab
              data={skills}
              workspaceDirectory={
                project.workspaces.find(
                  (entry) => entry.workspaceId === workspaceId,
                )?.directory ?? null
              }
              busy={busy}
              onToggle={toggleSkill}
              styles={styles}
            />
          ) : null}
          {tab === "prompt" ? (
            <PromptTab
              project={project}
              status={instructions}
              workspaceId={workspaceId}
              content={promptContent}
              busy={busy}
              onToggle={toggleInstructions}
              styles={styles}
            />
          ) : null}
          {tab === "knowledge" ? (
            <KnowledgeTab
              projectId={project.projectId}
              assets={assets}
              styles={styles}
            />
          ) : null}
          {tab === "docs" ? (
            <DocsTab
              projectId={project.projectId}
              assets={assets}
              styles={styles}
            />
          ) : null}
          {tab === "changes" ? (
            <ChangesTab
              projectId={project.projectId}
              workspaceId={workspaceId}
              assets={assets}
              run={action}
              onReload={reload}
              styles={styles}
            />
          ) : null}
          {tab === "drift" ? (
            <DriftTab
              projectId={project.projectId}
              workspaceId={workspaceId}
              items={drift}
              run={action}
              onReload={reload}
              styles={styles}
            />
          ) : null}
          {tab === "settings" ? (
            <SettingsTab
              projectId={project.projectId}
              workspaceId={workspaceId}
              run={action}
              styles={styles}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

export function SharedAssetsScreen(props: PluginScreenProps) {
  const styles = useMemo(
    () => makeStyles(props.theme, props.layout.compact),
    [props.theme, props.layout.compact],
  );
  const projectsCall = useRpc(projectsListRpc);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(
    props.params.projectId ?? null,
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void projectsCall({})
      .then(unwrap)
      .then((value) => {
        if (cancelled) return;
        setProjects(value);
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

  const project =
    projects.find((entry) => entry.projectId === projectId) ?? null;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      testID="shared-assets-screen"
    >
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? <ActivityIndicator /> : null}
      {!loading && project ? (
        <ProjectDetail
          project={project}
          onBack={() => setProjectId(null)}
          onChanged={() => setRefreshKey((value) => value + 1)}
          styles={styles}
        />
      ) : null}
      {!loading && !project ? (
        <View style={styles.detail}>
          <Text style={styles.title}>项目</Text>
          <Text style={styles.subtitle}>
            团队 Git 仓库中的 Skill、AGENTS.md、Knowledge 与
            Doc，投影到当前项目。
          </Text>
          {projects.length === 0 ? (
            <Text style={styles.empty}>Paseo 中还没有 Project。</Text>
          ) : null}
          {projects.map((entry) => (
            <Pressable
              key={entry.projectId}
              accessibilityRole="button"
              onPress={() => setProjectId(entry.projectId)}
              style={styles.card}
            >
              <View style={styles.spaceBetween}>
                <Text style={styles.sectionTitle}>{entry.displayName}</Text>
                <Badge
                  label={entry.bound ? "已绑定" : "未绑定"}
                  styles={styles}
                  tone={entry.bound ? "ok" : undefined}
                />
              </View>
              <Text style={styles.label}>{entry.rootPath}</Text>
              <Text style={styles.label}>
                {entry.workspaces.length} 个 Workspace
                {entry.bound
                  ? ` · ${entry.syncMode === "auto" ? "自动同步" : "手动同步"}`
                  : ""}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}
