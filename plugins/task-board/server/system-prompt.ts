import type { BoardTask } from "../shared/core/board/types";

export function buildBoardSystemPrompt(task: BoardTask): string {
  const acceptance =
    task.acceptanceCriteria && task.acceptanceCriteria.length > 0
      ? task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")
      : "- (none listed)";

  return [
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
    '- For long work, call board_declare with kind="progress", a summary and an optional stage.',
    "- Do not claim done. A human accepts the card.",
    "",
    "Turn lifecycle",
    "- The board moves this card to in_progress when your turn starts.",
    "- A completed turn without another declaration moves the card to in_review.",
    "- A failed turn moves the card to blocked and records the error.",
  ]
    .filter((line) => line !== "")
    .join("\n");
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
