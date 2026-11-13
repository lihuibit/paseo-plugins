// How a task's execution timing reads on a card and on the detail page.
//
// A card that only says "codex" looks identical whether the task is waiting
// for a click or for 18:00 tomorrow. The trigger is the difference, and showing
// it is cheaper than making the user open the detail page to find out.

import type { BoardTask, Trigger } from "../shared/core/board/types";
import {
  WEEKDAY_LABELS,
  cronToRecurrence,
  describeRecurrence,
} from "./recurrence-model";

type TriggerCadence = Extract<Trigger, { kind: "recurring" }>["cadence"];

export interface TaskScheduleLabel {
  /** "每天 09:00" for recurring; "明天 10:00" for a one-shot. */
  cadence: string;
  /** The next run when it adds information the cadence does not carry. */
  nextRun: string | null;
  /** "还有 4 小时" — detail-page detail, never on a card. */
  countdown: string | null;
  runCount: number;
}

/**
 * The schedule a task carries, or null when it has no timing worth showing.
 *
 * `immediate` and `manual` are deliberately null: "runs when you press the
 * button" is the default, and labelling it would add a line to every card.
 */
export function describeTaskSchedule(
  task: BoardTask,
  now: Date = new Date(),
): TaskScheduleLabel | null {
  const trigger = task.trigger;
  if (!trigger) return null;
  const nextAt = parseRunAt(task.nextRunAt);
  switch (trigger.kind) {
    case "immediate":
    case "manual":
      return null;
    case "scheduled":
      return {
        // A one-shot's time IS its next run; repeating it would print the
        // same instant twice.
        cadence: formatCardTime(nextAt ?? parseRunAt(trigger.runAt), now),
        nextRun: null,
        countdown: nextAt ? describeCountdown(nextAt, now) : null,
        runCount: task.runCount,
      };
    case "recurring":
      return {
        cadence: describeCadence(trigger.cadence),
        nextRun: nextAt ? formatCardTime(nextAt, now) : null,
        countdown: nextAt ? describeCountdown(nextAt, now) : null,
        runCount: task.runCount,
      };
  }
}

/** Whether the task will start itself without a click. */
export function hasAutomaticSchedule(task: BoardTask): boolean {
  return (
    task.trigger?.kind === "scheduled" || task.trigger?.kind === "recurring"
  );
}

/** A recurring cadence in words, falling back to the expression it came from. */
function describeCadence(cadence: TriggerCadence): string {
  if (cadence.type === "every") {
    const minutes = Math.round(cadence.everyMs / 60_000);
    if (minutes < 60) return `每 ${minutes} 分钟`;
    const hours = Math.round(minutes / 60);
    return hours === 1 ? "每小时" : `每 ${hours} 小时`;
  }
  const draft = cronToRecurrence(cadence.expression);
  // The picker is the only way to build a cadence, so this normally round-trips.
  // A cron shape it cannot redraw still has a next run; the expression beats
  // showing nothing.
  return draft ? describeRecurrence(draft) : `循环 ${cadence.expression}`;
}

/**
 * "10:00", "明天 09:00", "周五 09:00", "10月23日 09:00".
 *
 * Today's time drops the day word: on a card "今天 10:00" spends four
 * characters to say what "10:00" already means.
 */
function formatCardTime(at: Date | null, now: Date): string {
  if (!at) return "未排期";
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const days = dayOffset(at, now);
  if (days === 0) return time;
  if (days === 1) return `明天 ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAY_LABELS[at.getDay()]} ${time}`;
  return `${at.getMonth() + 1}月${at.getDate()}日 ${time}`;
}

/** Detail-page form: always names the day. */
export function formatFullScheduleTime(
  iso: string | null | undefined,
  now: Date = new Date(),
): string {
  const at = parseRunAt(iso);
  if (!at) return "未排期";
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const days = dayOffset(at, now);
  if (days === 0) return `今天 ${time}`;
  if (days === 1) return `明天 ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAY_LABELS[at.getDay()]} ${time}`;
  return `${at.getMonth() + 1}月${at.getDate()}日 ${time}`;
}

const DAY_MS = 86_400_000;

function dayOffset(at: Date, now: Date): number {
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
  return Math.round((startOfTarget - startOfToday) / DAY_MS);
}

export function describeCountdown(at: Date, now: Date): string | null {
  const deltaMs = at.getTime() - now.getTime();
  if (deltaMs <= 0) return "即将执行";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `还有 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `还有 ${hours} 小时`;
  return `还有 ${Math.floor(hours / 24)} 天`;
}

function parseRunAt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
