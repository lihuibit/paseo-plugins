// Recurrence and one-shot timing for the assign form.
//
// The form never asks for a cron expression. The user picks a shape — daily at
// 09:00, weekly on Monday, monthly on the 1st, weekdays, or every N minutes —
// and this module turns that into the cron string the scheduler accepts. The
// reverse direction exists so an existing trigger can be shown as a shape.
//
// Times are wall-clock in the device timezone, matching the schedule feature:
// "every day at 09:00" means 09:00 where the user is, not UTC.

export type RecurrenceMode =
  "daily" | "weekly" | "monthly" | "weekdays" | "interval";

export const RECURRENCE_MODES: readonly RecurrenceMode[] = [
  "daily",
  "weekly",
  "monthly",
  "weekdays",
  "interval",
];

export interface RecurrenceDraft {
  mode: RecurrenceMode;
  /** 0-23, wall clock. Also the anchor hour for `interval`. */
  hour: number;
  /** 0-59, wall clock. Also the anchor minute for `interval`. */
  minute: number;
  /** 0 = Sunday … 6 = Saturday. `weekly` only. */
  weekday: number;
  /** 1-31. `monthly` only. Months without this day are skipped, as cron does. */
  dayOfMonth: number;
  /** Interval mode: how many units between runs. */
  everyValue: number;
  /** Interval mode: the unit. */
  everyUnit: "minutes" | "hours";
}

export const DEFAULT_RECURRENCE: RecurrenceDraft = {
  mode: "daily",
  hour: 9,
  minute: 0,
  weekday: 1,
  dayOfMonth: 1,
  everyValue: 30,
  everyUnit: "minutes",
};

/** Values that keep an interval uniform when expressed as a cron field. */
export const INTERVAL_MINUTE_OPTIONS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
export const INTERVAL_HOUR_OPTIONS = [1, 2, 3, 4, 6, 8, 12];

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function sortedRing(start: number, step: number, size: number): number[] {
  const values: number[] = [];
  for (let offset = 0; offset < size; offset += step) {
    values.push((start + offset) % size);
  }
  return values.sort((left, right) => left - right);
}

/**
 * The cron expression for a shape.
 *
 * Monthly is `0 9 1 * *` and deliberately not adjusted for short months: cron
 * skips a February that has no 31st, and silently running on the 28th instead
 * would surprise someone who asked for the 31st.
 *
 * Interval shapes list the explicit minutes (or hours) on the ring, so the
 * anchor time survives: every 2 hours starting at 09:00 is `0 1,3,5,7,9,11,
 * 13,15,17,19,21,23 * * *`.
 */
export function recurrenceToCron(draft: RecurrenceDraft): string {
  const minute = clamp(draft.minute, 0, 59);
  const hour = clamp(draft.hour, 0, 23);
  if (draft.mode === "interval") {
    if (draft.everyUnit === "hours") {
      const step = clamp(draft.everyValue, 1, 24);
      return `${minute} ${sortedRing(hour, step, 24).join(",")} * * *`;
    }
    const step = clamp(draft.everyValue, 1, 60);
    return `${sortedRing(minute, step, 60).join(",")} * * * *`;
  }

  switch (draft.mode) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${clamp(draft.weekday, 0, 6)}`;
    case "monthly":
      return `${minute} ${hour} ${clamp(draft.dayOfMonth, 1, 31)} * *`;
  }
}

/** Recover a shape from a cron string, or null when it is not one of ours. */
export function cronToRecurrence(expression: string): RecurrenceDraft | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (month !== "*") return null;

  const interval = intervalFromCron({ minute, hour, dayOfMonth, dayOfWeek });
  if (interval) return interval;

  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
  const base = {
    ...DEFAULT_RECURRENCE,
    hour: Number(hour),
    minute: Number(minute),
  };
  return calendarShapeFromCron(base, { dayOfMonth, dayOfWeek });
}

/**
 * Interval shapes: an explicit list of minutes (`15,45 * * * *`) or hours
 * (`0 1,9,17 * * *`), plus the older star-slash-N form.
 */
function intervalFromCron(fields: {
  minute: string;
  hour: string;
  dayOfMonth: string;
  dayOfWeek: string;
}): RecurrenceDraft | null {
  const { minute, hour, dayOfMonth, dayOfWeek } = fields;
  if (dayOfMonth !== "*" || dayOfWeek !== "*") return null;

  const minutes = listValues(minute, 0, 59);
  if (hour === "*" && minutes) {
    const step = ringStep(minutes, 60);
    if (step) {
      return {
        ...DEFAULT_RECURRENCE,
        mode: "interval",
        everyValue: step,
        everyUnit: "minutes",
        minute: minutes[0] ?? 0,
      };
    }
  }

  const hours = listValues(hour, 0, 23);
  const minuteValue =
    /^\d+$/.test(minute) && Number(minute) <= 59 ? Number(minute) : null;
  if (hours && minuteValue !== null) {
    const step = ringStep(hours, 24);
    if (step) {
      return {
        ...DEFAULT_RECURRENCE,
        mode: "interval",
        everyValue: step,
        everyUnit: "hours",
        hour: hours[0] ?? 0,
        minute: minuteValue,
      };
    }
  }

  const minutesStep = /^\*\/(\d+)$/.exec(minute);
  if (minutesStep && hour === "*") {
    return {
      ...DEFAULT_RECURRENCE,
      mode: "interval",
      everyValue: Number(minutesStep[1]),
      everyUnit: "minutes",
      minute: 0,
    };
  }
  if (minute === "*" && hour === "*") {
    return {
      ...DEFAULT_RECURRENCE,
      mode: "interval",
      everyValue: 1,
      everyUnit: "minutes",
      minute: 0,
    };
  }
  if (minute === "0" && hour === "*") {
    return {
      ...DEFAULT_RECURRENCE,
      mode: "interval",
      everyValue: 1,
      everyUnit: "hours",
      hour: 0,
      minute: 0,
    };
  }
  const hoursStep = /^\*\/(\d+)$/.exec(hour);
  if (minute === "0" && hoursStep) {
    return {
      ...DEFAULT_RECURRENCE,
      mode: "interval",
      everyValue: Number(hoursStep[1]),
      everyUnit: "hours",
      hour: 0,
      minute: 0,
    };
  }
  return null;
}

function listValues(field: string, min: number, max: number): number[] | null {
  if (!/^\d+(,\d+)*$/.test(field)) return null;
  const values = field.split(",").map(Number);
  if (values.some((value) => value < min || value > max)) return null;
  return [...new Set(values)].sort((left, right) => left - right);
}

/** The circular gap in a ring, or null when the list is not uniform. */
function ringStep(values: number[], size: number): number | null {
  if (values.length < 2) return null;
  if (values.length === size) return 1;
  let step: number | null = null;
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index]!;
    const next = values[(index + 1) % values.length]!;
    const gap = (next - current + size) % size;
    if (gap === 0) return null;
    if (step === null) step = gap;
    else if (step !== gap) return null;
  }
  return step;
}

/** Daily / weekdays / weekly / monthly, each a different day field. */
function calendarShapeFromCron(
  base: RecurrenceDraft,
  fields: { dayOfMonth: string; dayOfWeek: string },
): RecurrenceDraft | null {
  const { dayOfMonth, dayOfWeek } = fields;
  if (dayOfMonth === "*") {
    if (dayOfWeek === "*") return { ...base, mode: "daily" };
    if (dayOfWeek === "1-5") return { ...base, mode: "weekdays" };
    if (/^\d$/.test(dayOfWeek))
      return { ...base, mode: "weekly", weekday: Number(dayOfWeek) };
    return null;
  }
  if (dayOfWeek === "*" && /^\d+$/.test(dayOfMonth)) {
    return { ...base, mode: "monthly", dayOfMonth: Number(dayOfMonth) };
  }
  return null;
}

/** Human-readable summary, e.g. "每周一 09:00". */
export function describeRecurrence(draft: RecurrenceDraft): string {
  const time = `${pad2(clamp(draft.hour, 0, 23))}:${pad2(
    clamp(draft.minute, 0, 59),
  )}`;
  switch (draft.mode) {
    case "daily":
      return `每天 ${time}`;
    case "weekdays":
      return `每个工作日 ${time}`;
    case "weekly":
      return `每${WEEKDAY_LABELS[clamp(draft.weekday, 0, 6)]} ${time}`;
    case "monthly":
      return `每月 ${clamp(draft.dayOfMonth, 1, 31)} 日 ${time}`;
    case "interval": {
      const unit = draft.everyUnit === "hours" ? "小时" : "分钟";
      return draft.everyValue === 1
        ? `每${unit}`
        : `每 ${draft.everyValue} ${unit}`;
    }
  }
}

export const WEEKDAY_LABELS = [
  "周日",
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六",
] as const;

/** Date options for the one-shot picker: today plus the next `days` days. */
export interface DateOption {
  value: string;
  label: string;
  description?: string;
}

const DAY_MS = 86_400_000;

/**
 * `value` is a local `YYYY-MM-DD`; it is compared and rendered as a calendar
 * date, never as an instant, so a timezone shift cannot move it by a day.
 */
export function buildDateOptions(now: Date, days = 30): DateOption[] {
  const options: DateOption[] = [];
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(start.getTime() + offset * DAY_MS);
    const value = localDateValue(date);
    const weekday = WEEKDAY_LABELS[date.getDay()]!;
    const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
    const option: DateOption = {
      value,
      label: dayLabelFor(offset, monthDay, weekday),
    };
    if (offset < 2) option.description = weekday;
    options.push(option);
  }
  return options;
}

function dayLabelFor(
  offset: number,
  monthDay: string,
  weekday: string,
): string {
  if (offset === 0) return `今天（${monthDay}）`;
  if (offset === 1) return `明天（${monthDay}）`;
  return `${monthDay} ${weekday}`;
}

export function localDateValue(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Half-hour time options, `HH:mm`. */
export function buildTimeOptions(stepMinutes = 30): DateOption[] {
  const options: DateOption[] = [];
  for (let minute = 0; minute < 24 * 60; minute += stepMinutes) {
    options.push({
      value: minutesToTimeValue(minute),
      label: minutesToTimeValue(minute),
    });
  }
  return options;
}

export function minutesToTimeValue(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

export function parseTimeValue(
  value: string,
): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Combine a local `YYYY-MM-DD` and `HH:mm` into the instant it names. */
export function combineLocalDateTime(
  dateValue: string,
  timeValue: string,
): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue.trim());
  const time = parseTimeValue(timeValue);
  if (!dateMatch || !time) return null;
  const date = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    time.hour,
    time.minute,
    0,
    0,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The next fire time for a cron expression in local time, or null when the
 * expression never matches.
 *
 * Mirrors the daemon's `nextCronRunAt`; it is duplicated here only because the
 * form needs a preview before anything is saved.
 */
export function nextCronRunAt(expression: string, after: Date): Date | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minuteExpr, hourExpr, domExpr, monthExpr, dowExpr] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let step = 0; step < 366 * 24 * 60; step += 1) {
    if (
      matchCronField(minuteExpr, cursor.getMinutes(), 0, 59) &&
      matchCronField(hourExpr, cursor.getHours(), 0, 23) &&
      matchCronField(domExpr, cursor.getDate(), 1, 31) &&
      matchCronField(monthExpr, cursor.getMonth() + 1, 1, 12) &&
      matchCronField(dowExpr, cursor.getDay(), 0, 6)
    ) {
      return new Date(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

function matchCronField(
  expr: string,
  value: number,
  min: number,
  max: number,
): boolean {
  if (expr === "*") return true;
  for (const part of expr.split(",")) {
    const stepMatch = /^(?:\*|(\d+)-(\d+))\/(\d+)$/.exec(part);
    if (stepMatch) {
      const start = stepMatch[1] === undefined ? min : Number(stepMatch[1]);
      const end = stepMatch[2] === undefined ? max : Number(stepMatch[2]);
      const step = Number(stepMatch[3]);
      if (
        step > 0 &&
        value >= start &&
        value <= end &&
        (value - start) % step === 0
      )
        return true;
      continue;
    }
    const rangeMatch = /^(\d+)-(\d+)$/.exec(part);
    if (rangeMatch) {
      if (value >= Number(rangeMatch[1]) && value <= Number(rangeMatch[2]))
        return true;
      continue;
    }
    if (/^\d+$/.test(part) && Number(part) === value) return true;
  }
  return false;
}

/** "明天 09:00（还有 14 小时）" — what the form shows under the picker. */
export function describeNextRun(at: Date | null, now: Date): string | null {
  if (!at) return null;
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfTarget = new Date(
    at.getFullYear(),
    at.getMonth(),
    at.getDate(),
  ).getTime();
  const days = Math.round((startOfTarget - startOfToday) / DAY_MS);
  return `${relativeDayLabel(at, days)} ${time}（${describeCountdown(
    at.getTime() - now.getTime(),
  )}）`;
}

function relativeDayLabel(at: Date, days: number): string {
  if (days === 0) return "今天";
  if (days === 1) return "明天";
  return `${WEEKDAY_LABELS[at.getDay()]}（${at.getMonth() + 1}月${at.getDate()}日）`;
}

function describeCountdown(deltaMs: number): string {
  if (deltaMs <= 0) return "即将执行";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `还有 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `还有 ${hours} 小时`;
  return `还有 ${Math.floor(hours / 24)} 天`;
}

/** `2026-10-21T09:30` → ["2026-10-21", "09:30"]. Either half may be empty. */
export function splitLocalDateTime(value: string): [string, string] {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{1,2}:\d{2})$/.exec(value.trim());
  if (!match) return ["", ""];
  return [match[1]!, match[2]!.padStart(5, "0")];
}

/** Assemble the value the form stores from its two halves. */
export function joinLocalDateTime(
  dateValue: string,
  timeValue: string,
): string {
  if (!dateValue || !timeValue) return "";
  return `${dateValue}T${timeValue}`;
}

/** The form's starting value: tomorrow at 09:00, local time. */
export function defaultScheduledAt(now: Date): string {
  return joinLocalDateTime(
    localDateValue(new Date(now.getTime() + DAY_MS)),
    "09:00",
  );
}
