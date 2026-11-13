import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { BUILTIN_PLANNING_PROMPT } from "../shared/planning-prompt";
import {
  notificationsTestRpc,
  settingsGetRpc,
  settingsUpdateRpc,
} from "../shared/contracts";
import type { BoardSettings } from "../shared/settings";
import {
  Button,
  Field,
  FormInput,
  Hint,
  SectionLabel,
  Sheet,
  SwitchControl,
} from "./ui/components";
import type { Tokens } from "./ui/tokens";

type Settings = BoardSettings;

export function SettingsSheet({
  visible,
  tokens,
  compact,
  onClose,
}: {
  visible: boolean;
  tokens: Tokens;
  compact: boolean;
  onClose: () => void;
}) {
  const getSettings = useRpc(settingsGetRpc);
  const updateSettings = useRpc(settingsUpdateRpc);
  const testNotification = useRpc(notificationsTestRpc);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setNotice(null);
    setError(null);
    void getSettings({}).then((envelope) => {
      if (envelope.ok) setSettings(envelope.value.settings);
      else setError(`${envelope.error.code}: ${envelope.error.message}`);
    });
  }, [getSettings, visible]);

  const patch = (updater: (current: Settings) => Settings) => {
    setSettings((current) => (current ? updater(current) : current));
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const envelope = await updateSettings({
        patch: {
          timezone: settings.timezone ?? null,
          wecom: settings.wecom,
          planningPrompt: settings.planningPrompt,
        },
      });
      if (!envelope.ok)
        throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
      setSettings(envelope.value.settings);
      setNotice("设置已保存");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setError(null);
    setNotice(null);
    const envelope = await testNotification({
      webhookUrl: settings?.wecom.webhookUrl.trim() || undefined,
    });
    if (!envelope.ok) {
      setError(`${envelope.error.code}: ${envelope.error.message}`);
      return;
    }
    if (envelope.value.ok) {
      setNotice("测试消息已发送");
    } else {
      setError(
        envelope.value.error ??
          envelope.value.attempts
            .map((attempt) => attempt.error)
            .filter(Boolean)
            .join(" · ") ??
          "测试消息发送失败",
      );
    }
  };

  return (
    <Sheet
      visible={visible}
      title="通知与设置"
      onClose={onClose}
      tokens={tokens}
      compact={compact}
      width={600}
      testID="task-board-settings"
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            onPress={() => void test()}
            tokens={tokens}
          >
            测试通知
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onPress={onClose}
            disabled={saving}
            tokens={tokens}
          >
            取消
          </Button>
          <Button
            variant="default"
            size="sm"
            onPress={() => void save()}
            disabled={saving || !settings}
            tokens={tokens}
            testID="task-board-settings-save"
          >
            保存
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
          ) : notice ? (
            <Text
              numberOfLines={2}
              style={{
                flexShrink: 1,
                color: tokens.colors.statusDotSuccess,
                fontSize: tokens.fontSize.sm,
              }}
            >
              {notice}
            </Text>
          ) : null}
        </>
      }
    >
      {!settings ? (
        <Hint tokens={tokens}>正在读取设置…</Hint>
      ) : (
        <View style={{ gap: tokens.spacing[3] }}>
          <SectionLabel label="WeCom 通知" tokens={tokens} />
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: tokens.spacing[3],
            }}
          >
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  color: tokens.colors.foreground,
                  fontSize: tokens.fontSize.base,
                }}
              >
                启用 WeCom 通知
              </Text>
              <Hint tokens={tokens}>进入待验收、阻塞和定时执行时推送</Hint>
            </View>
            <SwitchControl
              value={settings.wecom.enabled}
              onValueChange={(value) =>
                patch((current) => ({
                  ...current,
                  wecom: { ...current.wecom, enabled: value },
                }))
              }
              tokens={tokens}
            />
          </View>
          <Field label="Webhook URL" tokens={tokens}>
            <FormInput
              value={settings.wecom.webhookUrl}
              onChangeText={(value) =>
                patch((current) => ({
                  ...current,
                  wecom: { ...current.wecom, webhookUrl: value },
                }))
              }
              placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
              tokens={tokens}
              testID="settings-wecom-url"
            />
          </Field>
          {(
            [
              ["notifyOnReview", "待验收"],
              ["notifyOnBlocked", "阻塞"],
              ["notifyOnScheduled", "定时执行"],
              ["notifyOnProgress", "进展"],
            ] as const
          ).map(([key, label]) => (
            <View
              key={key}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: tokens.spacing[3],
              }}
            >
              <Text
                style={{
                  color: tokens.colors.foreground,
                  fontSize: tokens.fontSize.sm,
                }}
              >
                {label}
              </Text>
              <SwitchControl
                value={settings.wecom[key]}
                onValueChange={(value) =>
                  patch((current) => ({
                    ...current,
                    wecom: { ...current.wecom, [key]: value },
                  }))
                }
                tokens={tokens}
              />
            </View>
          ))}

          <SectionLabel label="调度" tokens={tokens} />
          <Field
            label="时区"
            hint="留空使用宿主时区，例如 Asia/Shanghai"
            tokens={tokens}
          >
            <FormInput
              value={settings.timezone ?? ""}
              onChangeText={(value) =>
                patch((current) => ({
                  ...current,
                  timezone: value.trim() || undefined,
                }))
              }
              placeholder="Asia/Shanghai"
              tokens={tokens}
            />
          </Field>

          <SectionLabel label="规划任务提示词" tokens={tokens} />
          <Field
            label="任务规划 Agent 的系统提示词"
            hint="留空使用内置 G0–G5 提示词；支持 {{taskId}} 插值。只影响新创建的会话。"
            tokens={tokens}
          >
            <FormInput
              value={settings.planningPrompt}
              onChangeText={(value) =>
                patch((current) => ({ ...current, planningPrompt: value }))
              }
              placeholder={BUILTIN_PLANNING_PROMPT}
              multiline
              minHeight={220}
              tokens={tokens}
              testID="settings-planning-prompt"
            />
          </Field>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: tokens.spacing[3],
            }}
          >
            <Hint tokens={tokens}>
              {settings.planningPrompt.trim()
                ? "当前使用自定义提示词"
                : "当前使用内置提示词"}
            </Hint>
            <Button
              variant="outline"
              size="xs"
              onPress={() =>
                patch((current) => ({ ...current, planningPrompt: "" }))
              }
              disabled={!settings.planningPrompt}
              tokens={tokens}
              testID="settings-planning-prompt-reset"
            >
              恢复默认
            </Button>
          </View>
        </View>
      )}
    </Sheet>
  );
}
