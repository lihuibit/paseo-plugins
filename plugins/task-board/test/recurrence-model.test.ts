import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECURRENCE,
  cronToRecurrence,
  describeRecurrence,
  nextCronRunAt,
  recurrenceToCron,
  type RecurrenceDraft,
} from "../client/recurrence-model";
import { describeTaskSchedule } from "../client/task-schedule-label";
import { nextRunAtForTrigger } from "../shared/core/board/schedule";
import type { BoardTask, Trigger } from "../shared/core/board/types";

function draft(patch: Partial<RecurrenceDraft>): RecurrenceDraft {
  return { ...DEFAULT_RECURRENCE, ...patch };
}

describe("recurrence cron shapes", () => {
  it("builds the five calendar shapes", () => {
    expect(recurrenceToCron(draft({ mode: "daily", hour: 9, minute: 0 }))).toBe(
      "0 9 * * *",
    );
    expect(
      recurrenceToCron(
        draft({ mode: "weekly", weekday: 1, hour: 10, minute: 30 }),
      ),
    ).toBe("30 10 * * 1");
    expect(
      recurrenceToCron(
        draft({ mode: "monthly", dayOfMonth: 15, hour: 8, minute: 0 }),
      ),
    ).toBe("0 8 15 * *");
    expect(
      recurrenceToCron(draft({ mode: "weekdays", hour: 9, minute: 30 })),
    ).toBe("30 9 * * 1-5");
  });

  it("keeps the interval anchor in the cron ring", () => {
    expect(
      recurrenceToCron(
        draft({
          mode: "interval",
          everyValue: 15,
          everyUnit: "minutes",
          hour: 9,
          minute: 15,
        }),
      ),
    ).toBe("0,15,30,45 * * * *");
    expect(
      recurrenceToCron(
        draft({
          mode: "interval",
          everyValue: 2,
          everyUnit: "hours",
          hour: 9,
          minute: 0,
        }),
      ),
    ).toBe("0 1,3,5,7,9,11,13,15,17,19,21,23 * * *");
  });

  it("round-trips every shape it writes", () => {
    const shapes: RecurrenceDraft[] = [
      draft({ mode: "daily", hour: 9, minute: 0 }),
      draft({ mode: "weekly", weekday: 5, hour: 18, minute: 30 }),
      draft({ mode: "monthly", dayOfMonth: 31, hour: 7, minute: 0 }),
      draft({ mode: "weekdays", hour: 9, minute: 15 }),
      draft({
        mode: "interval",
        everyValue: 20,
        everyUnit: "minutes",
        hour: 9,
        minute: 0,
      }),
      draft({
        mode: "interval",
        everyValue: 6,
        everyUnit: "hours",
        hour: 9,
        minute: 30,
      }),
    ];
    for (const shape of shapes) {
      const parsed = cronToRecurrence(recurrenceToCron(shape));
      expect(parsed?.mode).toBe(shape.mode);
      expect(parsed?.everyUnit).toBe(shape.everyUnit);
      expect(parsed?.everyValue).toBe(shape.everyValue);
      expect(parsed?.dayOfMonth).toBe(shape.dayOfMonth);
      expect(parsed?.weekday).toBe(shape.weekday);
    }
  });

  it("describes recurring schedules in words", () => {
    expect(describeRecurrence(draft({ mode: "daily", hour: 9 }))).toBe(
      "每天 09:00",
    );
    expect(
      describeRecurrence(draft({ mode: "weekly", weekday: 1, hour: 10 })),
    ).toBe("每周一 10:00");
    expect(describeRecurrence(draft({ mode: "weekdays", hour: 9 }))).toBe(
      "每个工作日 09:00",
    );
    expect(
      describeRecurrence(
        draft({ mode: "interval", everyValue: 2, everyUnit: "hours" }),
      ),
    ).toBe("每 2 小时");
  });
});

describe("nextRunAt for the four trigger kinds", () => {
  const from = new Date("2026-11-13T23:30:00");

  it("immediate runs now", () => {
    expect(nextRunAtForTrigger({ kind: "immediate" }, from)).toBe(
      from.toISOString(),
    );
  });

  it("manual has no next run", () => {
    expect(nextRunAtForTrigger({ kind: "manual" }, from)).toBeNull();
  });

  it("scheduled uses its runAt", () => {
    const trigger: Trigger = {
      kind: "scheduled",
      runAt: "2026-11-14T10:00:00.000Z",
    };
    expect(nextRunAtForTrigger(trigger, from)).toBe(trigger.runAt);
  });

  it("recurring uses the cron expression", () => {
    const trigger: Trigger = {
      kind: "recurring",
      cadence: { type: "cron", expression: "0 9 * * *" },
      session: "new",
    };
    const expected = nextCronRunAt("0 9 * * *", from);
    expect(expected).not.toBeNull();
    expect(nextRunAtForTrigger(trigger, from)).toBe(expected!.toISOString());
  });

  it("recurring interval uses the anchored ring", () => {
    const trigger: Trigger = {
      kind: "recurring",
      cadence: {
        type: "cron",
        expression: recurrenceToCron(
          draft({
            mode: "interval",
            everyValue: 2,
            everyUnit: "hours",
            hour: 9,
            minute: 0,
          }),
        ),
      },
      session: "new",
    };
    expect(nextRunAtForTrigger(trigger, from)).toBe(
      nextCronRunAt(
        "0 1,3,5,7,9,11,13,15,17,19,21,23 * * *",
        from,
      )!.toISOString(),
    );
  });
});

describe("card schedule labels", () => {
  const now = new Date("2026-11-13T12:00:00");

  function task(trigger: Trigger, nextRunAt: string | null): BoardTask {
    return {
      trigger,
      nextRunAt,
      runCount: 0,
    } as BoardTask;
  }

  it("shows a one-shot card as its time", () => {
    const label = describeTaskSchedule(
      task(
        { kind: "scheduled", runAt: "2026-11-14T10:00:00" },
        "2026-11-14T10:00:00",
      ),
      now,
    );
    expect(label).toMatchObject({
      cadence: "明天 10:00",
      nextRun: null,
      countdown: "还有 22 小时",
    });
  });

  it("shows a recurring card with its next run", () => {
    const label = describeTaskSchedule(
      task(
        {
          kind: "recurring",
          cadence: { type: "cron", expression: "0 10 * * 1" },
          session: "new",
        },
        "2026-11-16T10:00:00",
      ),
      now,
    );
    expect(label).toMatchObject({
      cadence: "每周一 10:00",
      nextRun: "周一 10:00",
    });
  });

  it("shows nothing for immediate and manual cards", () => {
    expect(
      describeTaskSchedule(task({ kind: "immediate" }, null), now),
    ).toBeNull();
    expect(
      describeTaskSchedule(task({ kind: "manual" }, null), now),
    ).toBeNull();
  });
});
