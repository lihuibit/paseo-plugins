import { describe, expect, it } from "vitest";
import { BoardTaskSchema } from "../shared/core/board/types";
import {
  BUILTIN_PLANNING_PROMPT,
  renderPlanningPrompt,
} from "../shared/planning-prompt";
import { buildBoardSystemPrompt } from "../server/system-prompt";

const planningTask = BoardTaskSchema.parse({
  id: "btask_planning",
  displayId: "TASK-9",
  title: "Plan the migration",
  kind: "task-planning",
  status: "planning",
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:00.000Z",
});

const workerTask = BoardTaskSchema.parse({
  id: "btask_worker",
  displayId: "TASK-10",
  title: "Implement the migration",
  status: "todo",
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:00.000Z",
});

describe("planning prompt", () => {
  it("ships a built-in G0-G5 prompt for the plugin tool surface", () => {
    for (const gate of ["G0", "G1", "G2", "G3", "G4", "G5"]) {
      expect(BUILTIN_PLANNING_PROMPT).toContain(gate);
    }
    for (const tool of ["board_create", "board_assign", "board_done"]) {
      expect(BUILTIN_PLANNING_PROMPT).toContain(tool);
    }
    expect(BUILTIN_PLANNING_PROMPT).toContain("{{taskId}}");
    expect(BUILTIN_PLANNING_PROMPT).not.toContain("paseo-board");
    expect(BUILTIN_PLANNING_PROMPT).toContain("同一时间只允许一个子任务");
  });

  it("interpolates the task id", () => {
    expect(renderPlanningPrompt("card {{taskId}}", planningTask)).toBe(
      "card btask_planning",
    );
  });

  it("documents the progress contract for worker tasks", () => {
    const worker = buildBoardSystemPrompt(workerTask);
    expect(worker).toContain("Progress reporting");
    expect(worker).toContain("At most one progress per stage");
    expect(worker).toContain(
      "never replaces the closing review/blocked/waiting",
    );
  });

  it("documents the progress contract for planning tasks", () => {
    expect(BUILTIN_PLANNING_PROMPT).toContain("子任务每进入一个新阶段");
    expect(BUILTIN_PLANNING_PROMPT).toContain("同一阶段不重复报");
    expect(BUILTIN_PLANNING_PROMPT).toContain(
      "不能代替结尾的 review/blocked/waiting",
    );
  });

  it("prepends the built-in prompt only for planning tasks", () => {
    const planning = buildBoardSystemPrompt(planningTask);
    expect(
      planning.startsWith(
        renderPlanningPrompt(BUILTIN_PLANNING_PROMPT, planningTask),
      ),
    ).toBe(true);
    expect(planning).not.toContain("{{taskId}}");
    expect(planning).toContain("Reporting contract");

    const worker = buildBoardSystemPrompt(workerTask);
    expect(worker).not.toContain("G0 读任务");
    expect(worker).toContain("Reporting contract");
  });

  it("uses the settings override and falls back on blank input", () => {
    const overridden = buildBoardSystemPrompt(planningTask, {
      planningPrompt: "Custom plan for {{taskId}}",
    });
    expect(overridden.startsWith("Custom plan for btask_planning")).toBe(true);
    expect(overridden).not.toContain("G0 读任务");

    const blank = buildBoardSystemPrompt(planningTask, {
      planningPrompt: "  ",
    });
    expect(
      blank.startsWith(
        renderPlanningPrompt(BUILTIN_PLANNING_PROMPT, planningTask),
      ),
    ).toBe(true);
  });
});
