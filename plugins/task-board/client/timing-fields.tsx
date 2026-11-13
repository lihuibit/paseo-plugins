import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import {
  DEFAULT_RECURRENCE,
  INTERVAL_HOUR_OPTIONS,
  INTERVAL_MINUTE_OPTIONS,
  WEEKDAY_LABELS,
  buildDateOptions,
  buildTimeOptions,
  combineLocalDateTime,
  describeNextRun,
  describeRecurrence,
  minutesToTimeValue,
  nextCronRunAt,
  parseTimeValue,
  recurrenceToCron,
  splitLocalDateTime,
  type RecurrenceDraft,
  type RecurrenceMode,
} from "./recurrence-model";
import { Field, SegmentedControl, SelectField } from "./ui/components";
import type { Tokens } from "./ui/tokens";

const MODE_OPTIONS: Array<{
  value: RecurrenceMode;
  label: string;
  testID: string;
}> = [
  { value: "daily", label: "每天", testID: "recurrence-daily" },
  { value: "weekly", label: "每周", testID: "recurrence-weekly" },
  { value: "monthly", label: "每月", testID: "recurrence-monthly" },
  { value: "weekdays", label: "工作日", testID: "recurrence-weekdays" },
  { value: "interval", label: "间隔", testID: "recurrence-interval" },
];

const TIME_OPTIONS = buildTimeOptions().map((option) => ({
  value: option.value,
  label: option.label,
}));

const WEEKDAY_OPTIONS = WEEKDAY_LABELS.map((label, index) => ({
  value: String(index),
  label,
}));

const MONTH_DAY_OPTIONS = Array.from({ length: 31 }, (_, index) => ({
  value: String(index + 1),
  label: `${index + 1} 日`,
}));

const MINUTE_STEP_OPTIONS = INTERVAL_MINUTE_OPTIONS.map((value) => ({
  value: String(value),
  label: `${value} 分钟`,
}));

const HOUR_STEP_OPTIONS = INTERVAL_HOUR_OPTIONS.map((value) => ({
  value: String(value),
  label: `${value} 小时`,
}));

/** One-shot timing: a calendar date and a wall-clock time. */
export function OneShotTimingField({
  scheduledAt,
  onChange,
  tokens,
  compact,
  disabled,
}: {
  /** `YYYY-MM-DDTHH:mm` in local time, or empty. */
  scheduledAt: string;
  onChange: (next: string) => void;
  tokens: Tokens;
  compact: boolean;
  disabled: boolean;
}): ReactElement {
  const now = useMemo(() => new Date(), []);
  const size = compact ? "md" : "sm";
  const dateOptions = useMemo(
    () =>
      buildDateOptions(now).map((option) => ({
        value: option.value,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
    [now],
  );

  const [dateValue, timeValue] = splitLocalDateTime(scheduledAt);
  const effectiveDate = dateValue || (dateOptions[0]?.value ?? "");
  const effectiveTime = timeValue || "09:00";

  const commit = useCallback(
    (nextDate: string, nextTime: string) => {
      onChange(`${nextDate}T${nextTime}`);
    },
    [onChange],
  );
  const nextRun = combineLocalDateTime(effectiveDate, effectiveTime);
  const preview = describeNextRun(nextRun, now);
  const inPast = nextRun !== null && nextRun.getTime() <= now.getTime();

  return (
    <>
      <SelectField
        label="日期"
        value={effectiveDate || null}
        options={dateOptions}
        placeholder="选择日期"
        onChange={(next) => commit(next, effectiveTime)}
        tokens={tokens}
        disabled={disabled}
        size={size}
        testID="assign-timing-date"
      />
      <SelectField
        label="时间"
        value={effectiveTime}
        options={TIME_OPTIONS}
        placeholder="选择时间"
        onChange={(next) => commit(effectiveDate, next)}
        tokens={tokens}
        disabled={disabled}
        size={size}
        testID="assign-timing-time"
      />
      {preview ? (
        <Text
          style={{
            color: inPast
              ? tokens.colors.destructive
              : tokens.colors.foregroundMuted,
            fontSize: tokens.fontSize.sm,
          }}
        >
          下次执行：{preview}
          {inPast ? " · 该时间已过去，请选择未来的时间" : ""}
        </Text>
      ) : null}
    </>
  );
}

/** Whether a one-shot value names a time that has already passed. */
export function isScheduledInPast(
  scheduledAt: string,
  now = new Date(),
): boolean {
  const [dateValue, timeValue] = splitLocalDateTime(scheduledAt);
  const at = combineLocalDateTime(dateValue, timeValue);
  return at !== null && at.getTime() <= now.getTime();
}

/** Recurrence timing: a shape, its parameters, and the resulting schedule. */
export function RecurrenceTimingField({
  value,
  onChange,
  tokens,
  compact,
  disabled,
}: {
  value: RecurrenceDraft;
  onChange: (next: RecurrenceDraft) => void;
  tokens: Tokens;
  compact: boolean;
  disabled: boolean;
}): ReactElement {
  const now = useMemo(() => new Date(), []);
  const size = compact ? "md" : "sm";
  const cron = recurrenceToCron(value);
  const nextRun = nextCronRunAt(cron, now);
  const preview = describeNextRun(nextRun, now);
  const timeValue = minutesToTimeValue(value.hour * 60 + value.minute);

  const update = useCallback(
    (patch: Partial<RecurrenceDraft>) => onChange({ ...value, ...patch }),
    [onChange, value],
  );
  const selectTime = useCallback(
    (next: string) => {
      const parsed = parseTimeValue(next);
      if (parsed) update({ hour: parsed.hour, minute: parsed.minute });
    },
    [update],
  );

  const minuteSteps = MINUTE_STEP_OPTIONS;
  const hourSteps = HOUR_STEP_OPTIONS;
  const stepOptions = value.everyUnit === "hours" ? hourSteps : minuteSteps;
  const stepValue = stepOptions.some(
    (option) => Number(option.value) === value.everyValue,
  )
    ? String(value.everyValue)
    : (stepOptions[0]?.value ?? "");

  return (
    <>
      <Field label="循环方式" tokens={tokens}>
        <SegmentedControl
          options={MODE_OPTIONS}
          value={value.mode}
          onValueChange={(next) => update({ mode: next })}
          tokens={tokens}
          size={compact ? "xs" : "sm"}
          style={{ flexWrap: "wrap" }}
        />
      </Field>

      {value.mode === "weekly" ? (
        <SelectField
          label="星期"
          value={String(value.weekday)}
          options={WEEKDAY_OPTIONS}
          placeholder="选择星期"
          onChange={(next) => update({ weekday: Number(next) })}
          tokens={tokens}
          disabled={disabled}
          size={size}
          testID="assign-recurrence-weekday"
        />
      ) : null}

      {value.mode === "monthly" ? (
        <SelectField
          label="日期"
          value={String(value.dayOfMonth)}
          options={MONTH_DAY_OPTIONS}
          placeholder="选择日期"
          onChange={(next) => update({ dayOfMonth: Number(next) })}
          tokens={tokens}
          disabled={disabled}
          size={size}
          testID="assign-recurrence-day"
        />
      ) : null}

      {value.mode === "interval" ? (
        <View style={{ flexDirection: "row", gap: tokens.spacing[2] }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <SelectField
              label="间隔"
              value={stepValue}
              options={stepOptions}
              placeholder="选择间隔"
              onChange={(next) => update({ everyValue: Number(next) })}
              tokens={tokens}
              disabled={disabled}
              size={size}
              testID="assign-recurrence-every"
            />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <SelectField
              label="单位"
              value={value.everyUnit}
              options={[
                { value: "minutes", label: "分钟" },
                { value: "hours", label: "小时" },
              ]}
              placeholder="单位"
              onChange={(next) =>
                update({
                  everyUnit: next === "hours" ? "hours" : "minutes",
                  everyValue:
                    next === "hours"
                      ? INTERVAL_HOUR_OPTIONS[0]!
                      : INTERVAL_MINUTE_OPTIONS[0]!,
                })
              }
              tokens={tokens}
              disabled={disabled}
              size={size}
              testID="assign-recurrence-unit"
            />
          </View>
        </View>
      ) : null}

      <SelectField
        label={value.mode === "interval" ? "起始时间" : "时间"}
        value={timeValue}
        options={TIME_OPTIONS}
        placeholder="选择时间"
        onChange={selectTime}
        tokens={tokens}
        disabled={disabled}
        size={size}
        testID={
          value.mode === "interval"
            ? "assign-recurrence-start"
            : "assign-recurrence-time"
        }
      />

      <Text
        style={{
          color: tokens.colors.foregroundMuted,
          fontSize: tokens.fontSize.sm,
        }}
      >
        {describeRecurrence(value)}
        {preview ? ` · 下次执行：${preview}` : ""}
      </Text>
    </>
  );
}

export function defaultRecurrence(): RecurrenceDraft {
  return { ...DEFAULT_RECURRENCE };
}
