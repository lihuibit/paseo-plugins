import type { BoardTask } from "../shared/core/board/types";
import {
  BUILTIN_PLANNING_PROMPT,
  renderPlanningPrompt,
} from "../shared/planning-prompt";

export function buildBoardSystemPrompt(
  task: BoardTask,
  options: { planningPrompt?: string } = {},
): string {
  const acceptance =
    task.acceptanceCriteria && task.acceptanceCriteria.length > 0
      ? task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")
      : "- (none listed)";

  const base = [
    `You are the assigned agent for Paseo task board card ${task.displayId} (${task.id}).`,
    "",
    "Scope",
    `- Work only on this card: ${task.title}`,
    task.description ? `- Description: ${task.description}` : "",
    "- Do not modify unrelated files or other cards.",
    "",
    "Acceptance criteria",
    acceptance,
    "",
    "Reporting contract",
    '- When the work is ready for human acceptance, call board_declare with kind="review" and a one-line summary.',
    '- When you need a human decision, call board_declare with kind="blocked", a blockReason and a humanRequest.',
    '- When you are waiting on background work you started, call board_declare with kind="waiting".',
    "Progress reporting",
    '- Report progress at these moments, not only when the task looks "long":',
    "  * right after you finish reading the task and start the first concrete step;",
    "  * each time you complete a stage (implementation done -> tests running -> tests passed);",
    "  * before any step expected to take more than ~2 minutes (build, full test suite, dependency install).",
    "- At most one progress per stage; if the stage has not changed, do not report again.",
    "- summary must say what you are doing now and what comes next, e.g.",
    '  "modified the question branch in assigner.ts, adding unit tests next".',
    '  Do not write "working on it" / "in progress".',
    "- progress keeps the card in in_progress and never replaces the closing review/blocked/waiting.",
    "- Do not claim done. A human accepts the card.",
    "",
    "Turn lifecycle",
    "- The board moves this card to in_progress when your turn starts.",
    "- A completed turn without another declaration moves the card to in_review.",
    "- A failed turn moves the card to blocked and records the error.",
  ]
    .filter((line) => line !== "")
    .join("\n");
  if (task.kind !== "task-planning") return base;
  const template = options.planningPrompt?.trim()
    ? options.planningPrompt
    : BUILTIN_PLANNING_PROMPT;
  return `${renderPlanningPrompt(template, task)}\n\n${base}`;
}

export function buildInitialMessage(
  task: BoardTask,
  override?: string,
): string {
  if (override) return override;
  return [
    `Task board card ${task.displayId}: ${task.title}`,
    task.description ? `\n${task.description}` : "",
    task.acceptanceCriteria && task.acceptanceCriteria.length > 0
      ? `\nAcceptance criteria:\n${task.acceptanceCriteria
          .map((item) => `- ${item}`)
          .join("\n")}`
      : "",
    "",
    'When finished, call board_declare with kind="review" and a short summary.',
  ]
    .filter((line) => line !== "")
    .join("\n");
}
