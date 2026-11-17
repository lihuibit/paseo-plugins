import type { PaseoAgent } from "./paseo-types";

export type PendingPermission = PaseoAgent["pendingPermissions"][number];

export interface PendingQuestion {
  header: string;
  question: string;
  options: string[];
  allowOther?: boolean;
  isOther?: boolean;
  multiSelect?: boolean;
}

export type QuestionAnswerPlan =
  | {
      ok: true;
      provider: "codex" | "claude" | "pi";
      questions: PendingQuestion[];
      answers: Record<string, string>;
    }
  | {
      ok: false;
      provider: string;
      questions: PendingQuestion[];
      reason: string;
    };

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      labels.push(entry);
      continue;
    }
    if (entry && typeof entry === "object") {
      const label = nonEmptyString((entry as Record<string, unknown>).label);
      if (label) labels.push(label);
    }
  }
  return labels;
}

export function readQuestions(request: PendingPermission): PendingQuestion[] {
  const input = request.input;
  const raw =
    input && typeof input === "object" && Array.isArray(input.questions)
      ? input.questions
      : [];
  return raw.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const header = nonEmptyString(record.header) ?? `Question ${index + 1}`;
    const question = nonEmptyString(record.question) ?? header;
    const allowOther =
      typeof record.allowOther === "boolean" ? record.allowOther : undefined;
    const isOther =
      typeof record.isOther === "boolean" ? record.isOther : undefined;
    const multiSelect =
      typeof record.multiSelect === "boolean" ? record.multiSelect : undefined;
    return [
      {
        header,
        question,
        options: readOptions(record.options),
        ...(allowOther === undefined ? {} : { allowOther }),
        ...(isOther === undefined ? {} : { isOther }),
        ...(multiSelect === undefined ? {} : { multiSelect }),
      },
    ];
  });
}

function providerKind(request: PendingPermission): string {
  return request.provider.toLowerCase();
}

function splitAnswers(message: string, count: number): string[] | null {
  const trimmed = message.trim();
  if (!trimmed) return null;
  if (count === 1) return [trimmed];

  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (paragraphs.length === count) return paragraphs;

  const lines = trimmed
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return lines.length === count ? lines : null;
}

function freeformAllowed(question: PendingQuestion): boolean {
  return question.allowOther === true || question.isOther === true;
}

function answerMismatch(
  question: PendingQuestion,
  answer: string,
): string | null {
  if (question.options.length === 0 || freeformAllowed(question)) return null;
  if (question.multiSelect) {
    const selected = answer
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (selected.length === 0) {
      return `"${question.header}" requires at least one option`;
    }
    const invalid = selected.filter(
      (entry) => !question.options.includes(entry),
    );
    if (invalid.length > 0) {
      return `"${question.header}" only accepts these options: ${question.options.join(", ")}`;
    }
    return null;
  }
  if (!question.options.includes(answer.trim())) {
    return `"${question.header}" only accepts these options: ${question.options.join(", ")}`;
  }
  return null;
}

function codexAnswers(values: string[]): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const [index, value] of values.entries()) {
    answers[`Question ${index + 1}`] = value;
  }
  return answers;
}

function claudeAnswers(
  questions: PendingQuestion[],
  values: string[],
): Record<string, string> | string {
  const answers: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const key = question.question || question.header;
    if (key in answers) return `Claude question text is duplicated: "${key}"`;
    answers[key] = values[index]!;
  }
  return answers;
}

function piAnswers(
  questions: PendingQuestion[],
  values: string[],
): Record<string, string> | string {
  const answers: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    if (question.header in answers) {
      return `Pi question header is duplicated: "${question.header}"`;
    }
    const value = values[index]!;
    answers[question.header] = question.multiSelect
      ? value
          .split(/\s*,\s*|\n+/)
          .map((entry) => entry.trim())
          .filter(Boolean)
          .join(", ")
      : value;
  }
  return answers;
}

/**
 * Builds the provider-specific answers map for one pending question request.
 *
 * Paseo's providers disagree on the key:
 * - codex: `Question 1` … `Question N`, every question required.
 * - claude: the full question text, falling back to the header.
 * - pi: the question header.
 */
export function buildQuestionAnswer(
  request: PendingPermission,
  message: string,
): QuestionAnswerPlan {
  const provider = providerKind(request);
  const questions = readQuestions(request);
  if (questions.length === 0) {
    return {
      ok: false,
      provider,
      questions,
      reason: "The pending question has no readable questions payload",
    };
  }

  if (provider !== "codex" && provider !== "claude" && provider !== "pi") {
    return {
      ok: false,
      provider,
      questions,
      reason: `Provider "${request.provider}" does not support answering questions`,
    };
  }

  const values = splitAnswers(message, questions.length);
  if (!values) {
    return {
      ok: false,
      provider,
      questions,
      reason:
        questions.length === 1
          ? "An empty answer cannot be submitted"
          : `The message could not be split into ${questions.length} answers. List one answer per line or separate paragraphs.`,
    };
  }

  for (const [index, question] of questions.entries()) {
    const mismatch = answerMismatch(question, values[index]!);
    if (mismatch) {
      return { ok: false, provider, questions, reason: mismatch };
    }
  }

  if (provider === "codex") {
    return {
      ok: true,
      provider,
      questions,
      answers: codexAnswers(values),
    };
  }
  if (provider === "claude") {
    const answers = claudeAnswers(questions, values);
    return typeof answers === "string"
      ? { ok: false, provider, questions, reason: answers }
      : { ok: true, provider, questions, answers };
  }
  const answers = piAnswers(questions, values);
  return typeof answers === "string"
    ? { ok: false, provider, questions, reason: answers }
    : { ok: true, provider, questions, answers };
}
