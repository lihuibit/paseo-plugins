import { z } from "zod";

export const WeComSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    webhookUrl: z.string().trim().default(""),
    notifyOnReview: z.boolean().default(true),
    notifyOnBlocked: z.boolean().default(true),
    notifyOnScheduled: z.boolean().default(true),
    notifyOnProgress: z.boolean().default(false),
    minIntervalMs: z.number().int().min(0).max(60_000).default(1_000),
    retries: z.number().int().min(0).max(5).default(3),
  })
  .strict();
export type WeComSettings = z.infer<typeof WeComSettingsSchema>;

export const BoardSettingsSchema = z
  .object({
    wecom: WeComSettingsSchema.default({
      enabled: false,
      webhookUrl: "",
      notifyOnReview: true,
      notifyOnBlocked: true,
      notifyOnScheduled: true,
      notifyOnProgress: false,
      minIntervalMs: 1_000,
      retries: 3,
    }),
    timezone: z.string().trim().min(1).optional(),
  })
  .strict();
export type BoardSettings = z.infer<typeof BoardSettingsSchema>;

export const BoardSettingsPatchSchema = z
  .object({
    wecom: WeComSettingsSchema.partial().optional(),
    timezone: z.string().trim().min(1).nullable().optional(),
  })
  .strict();
export type BoardSettingsPatch = z.infer<typeof BoardSettingsPatchSchema>;

export const DEFAULT_BOARD_SETTINGS: BoardSettings = BoardSettingsSchema.parse({
  wecom: {},
});
