import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { TaskBoardService } from "./service";
import type { DeclareRequest } from "./service";

function normalize(input: {
  kind: "review" | "blocked" | "waiting" | "progress" | "clear";
  summary?: string;
  stage?: string;
  blockReason?: "human_required" | "permission" | "question" | "manual";
  humanRequest?: {
    title: string;
    instructions: string;
    action?:
      | { kind: "open_url"; url: string }
      | { kind: "open_terminal"; command: string }
      | { kind: "manual" };
  };
}): DeclareRequest {
  if (input.kind === "progress") {
    return {
      kind: "progress",
      summary: input.summary ?? "progress",
      stage: input.stage,
    };
  }
  if (input.kind === "blocked") {
    return {
      kind: "blocked",
      summary: input.summary,
      blockReason: input.blockReason,
      humanRequest: input.humanRequest,
    };
  }
  return { kind: input.kind, summary: input.summary };
}

export function createBoardDeclareTool(service: TaskBoardService) {
  return defineAgentTool({
    name: "board_declare",
    description:
      "Report this task's status to the Paseo task board. Call once per turn when you finish, " +
      "need a human, are waiting on your own background work, or want to post progress.",
    input: z
      .object({
        kind: z.enum(["review", "blocked", "waiting", "progress", "clear"]),
        summary: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("One line the card shows"),
        stage: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Coarse stage name, progress only"),
        blockReason: z
          .enum(["human_required", "permission", "question", "manual"])
          .optional(),
        humanRequest: z
          .object({
            title: z.string().trim().min(1),
            instructions: z.string().trim().min(1),
            action: z
              .discriminatedUnion("kind", [
                z
                  .object({
                    kind: z.literal("open_url"),
                    url: z.string().trim().min(1),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("open_terminal"),
                    command: z.string().trim().min(1),
                  })
                  .strict(),
                z.object({ kind: z.literal("manual") }).strict(),
              ])
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    async execute(input, context) {
      if (input.kind === "progress" && !input.summary) {
        return {
          isError: true,
          text: "progress requires a summary",
          structuredContent: { accepted: false, code: "INVALID_INPUT" },
        };
      }
      const task = await service.declareForAgent(
        context.agent,
        normalize(input),
      );
      if (!task) {
        return {
          isError: true,
          text: "This agent is not bound to a task board card.",
          structuredContent: { accepted: false, code: "NO_BOUND_TASK" },
        };
      }
      return {
        text: `Declared ${input.kind}. ${task.displayId} is ${task.status}.`,
        structuredContent: {
          accepted: true,
          taskId: task.id,
          displayId: task.displayId,
          status: task.status,
          revision: task.revision,
        },
      };
    },
  });
}
