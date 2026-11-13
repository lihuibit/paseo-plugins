import { useCallback, useEffect, useMemo, useRef } from "react";
import { Text } from "react-native";
import type { CandidatesResult } from "../shared/contracts";
import { SelectField, Hint } from "./ui/components";
import type { Tokens } from "./ui/tokens";
import { useProviderOptions } from "./provider-options";

export interface AgentConfigValues {
  provider: string;
  model: string;
  thinkingOptionId: string;
  modeId: string;
}

export function AgentConfigFields({
  providers,
  values,
  cwd,
  tokens,
  compact,
  onChange,
}: {
  providers: CandidatesResult["providers"];
  values: AgentConfigValues;
  cwd: string | null;
  tokens: Tokens;
  compact: boolean;
  onChange: (values: AgentConfigValues) => void;
}) {
  const options = useProviderOptions(values.provider || null, cwd);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const providerOptions = useMemo(
    () =>
      providers.map((entry) => ({
        value: entry.provider,
        label: entry.available
          ? entry.label || entry.provider
          : `${entry.label || entry.provider}（不可用）`,
        disabled: !entry.available,
      })),
    [providers],
  );

  const models = options.data?.models ?? [];
  const modes = options.data?.modes ?? [];
  const selectedModel =
    models.find((model) => model.id === values.model) ?? null;
  const thinkingOptions = selectedModel?.thinkingOptions ?? [];

  const modelOptions = useMemo(
    () =>
      models.map((model) => ({
        value: model.id,
        label: model.label,
        description: model.isDefault ? "默认模型" : model.description,
      })),
    [models],
  );
  const thinkingChoiceOptions = useMemo(
    () =>
      thinkingOptions.map((option) => ({
        value: option.id,
        label: option.label,
        description: option.isDefault ? "默认" : option.description,
      })),
    [thinkingOptions],
  );
  const modeOptions = useMemo(
    () =>
      modes.map((mode) => ({
        value: mode.id,
        label: mode.label,
        description: mode.description,
      })),
    [modes],
  );

  useEffect(() => {
    if (!options.data) return;
    const current = values;
    const nextModel =
      models.find((model) => model.id === current.model) ??
      models.find((model) => model.isDefault) ??
      models[0] ??
      null;
    const nextModelId = nextModel?.id ?? "";
    const nextThinkingPool = nextModel?.thinkingOptions ?? [];
    const nextThinking = nextThinkingPool.some(
      (option) => option.id === current.thinkingOptionId,
    )
      ? current.thinkingOptionId
      : (nextModel?.defaultThinkingOptionId ??
        nextThinkingPool.find((option) => option.isDefault)?.id ??
        nextThinkingPool[0]?.id ??
        "");
    const nextMode =
      modes.find((mode) => mode.id === current.modeId) ??
      ["full-access", "bypassPermissions", "acceptEdits", "auto", "default"]
        .map((id) => modes.find((mode) => mode.id === id))
        .find((mode) => mode !== undefined) ??
      modes[0] ??
      null;
    const nextModeId = nextMode?.id ?? "";
    if (
      nextModelId !== current.model ||
      nextThinking !== current.thinkingOptionId ||
      nextModeId !== current.modeId
    ) {
      onChangeRef.current({
        ...current,
        model: nextModelId,
        thinkingOptionId: nextThinking,
        modeId: nextModeId,
      });
    }
  }, [models, modes, options.data, values]);

  const selectProvider = useCallback((provider: string) => {
    onChangeRef.current({
      provider,
      model: "",
      thinkingOptionId: "",
      modeId: "",
    });
  }, []);
  const selectModel = useCallback(
    (model: string) => {
      const next = models.find((entry) => entry.id === model) ?? null;
      const pool = next?.thinkingOptions ?? [];
      const thinking =
        next?.defaultThinkingOptionId ??
        pool.find((option) => option.isDefault)?.id ??
        pool[0]?.id ??
        "";
      onChangeRef.current({
        ...values,
        model,
        thinkingOptionId: thinking,
      });
    },
    [models, values],
  );

  const loading = options.loading;
  const error = options.error;
  const modelsEmpty = !loading && options.data !== null && models.length === 0;
  const modesEmpty = !loading && options.data !== null && modes.length === 0;
  const failedWithoutData = !loading && options.data === null && Boolean(error);
  const modelPlaceholder = !values.provider
    ? "请先选择 Provider"
    : loading
      ? "正在读取模型…"
      : failedWithoutData
        ? "模型读取失败"
        : modelsEmpty
          ? "该 Provider 不支持选择模型"
          : "选择模型";
  const thinkingPlaceholder = !values.model
    ? "请先选择模型"
    : loading
      ? "正在读取思考深度…"
      : failedWithoutData
        ? "思考深度读取失败"
        : thinkingOptions.length === 0
          ? "默认 / 该模型不支持选择"
          : "选择思考深度";
  const modePlaceholder = !values.provider
    ? "请先选择 Provider"
    : loading
      ? "正在读取权限模式…"
      : failedWithoutData
        ? "权限模式读取失败"
        : modesEmpty
          ? "默认 / 该 Provider 不支持选择"
          : "选择权限模式";

  return (
    <>
      <SelectField
        label="Provider"
        value={values.provider || null}
        options={providerOptions}
        placeholder={
          providerOptions.length === 0 ? "没有可用 Provider" : "选择 Provider"
        }
        onChange={selectProvider}
        tokens={tokens}
        disabled={providerOptions.length === 0}
        size={compact ? "md" : "sm"}
        testID="assign-provider-trigger"
      />
      <SelectField
        label="模型"
        value={values.model || null}
        options={modelOptions}
        placeholder={modelPlaceholder}
        onChange={(value) => selectModel(value)}
        tokens={tokens}
        disabled={loading || models.length === 0}
        hint={error ?? undefined}
        size={compact ? "md" : "sm"}
        testID="assign-model-trigger"
      />
      <SelectField
        label="思考深度"
        value={values.thinkingOptionId || null}
        options={thinkingChoiceOptions}
        placeholder={thinkingPlaceholder}
        onChange={(value) =>
          onChangeRef.current({ ...values, thinkingOptionId: value })
        }
        tokens={tokens}
        disabled={loading || thinkingOptions.length === 0}
        size={compact ? "md" : "sm"}
        testID="assign-thinking-trigger"
      />
      <SelectField
        label="权限模式"
        value={values.modeId || null}
        options={modeOptions}
        placeholder={modePlaceholder}
        onChange={(value) => onChangeRef.current({ ...values, modeId: value })}
        tokens={tokens}
        disabled={loading || modes.length === 0}
        size={compact ? "md" : "sm"}
        testID="assign-mode-trigger"
      />
      {loading ? <Hint tokens={tokens}>正在读取 Provider 配置…</Hint> : null}
      {!loading && error ? (
        <Text
          style={{
            color: tokens.colors.destructive,
            fontSize: tokens.fontSize.sm,
          }}
        >
          {error}
        </Text>
      ) : null}
      {modelsEmpty ? (
        <Hint tokens={tokens}>
          该 Provider 未返回可选模型，无法手动指定模型。
        </Hint>
      ) : null}
      {modesEmpty ? (
        <Hint tokens={tokens}>
          该 Provider 未返回权限模式，将使用默认模式。
        </Hint>
      ) : null}
    </>
  );
}
