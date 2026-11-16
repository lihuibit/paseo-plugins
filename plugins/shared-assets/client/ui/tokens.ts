import type { PluginScreenProps } from "@getpaseo/plugin/client";

export type Theme = PluginScreenProps["theme"];

export const SPACING = {
  0: 0,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
} as const;

export const FONT_SIZE = {
  xs: 12,
  sm: 12,
  base: 14,
  lg: 16,
  xl: 18,
  "2xl": 20,
  "3xl": 22,
  "4xl": 26,
} as const;

export const FONT_WEIGHT = {
  normal: "normal",
  medium: "500",
  semibold: "600",
  bold: "bold",
} as const;

export const RADIUS = {
  sm: 2,
  base: 4,
  md: 6,
  lg: 8,
  xl: 12,
  "2xl": 16,
  full: 9999,
} as const;

export const CONTROL_HEIGHT = {
  xs: 28,
  sm: 32,
  md: 44,
} as const;

export const MONO_FONT =
  "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";

/**
 * The plugin theme exposes five surfaces but the shared-assets screens were
 * designed against AgentStorm's six. Surface 3 and the status-dot band are the
 * two that matter here, so they are filled in from the same palette.
 */
function isDarkSurface(hex: string): boolean {
  const value = hex.replace("#", "");
  if (value.length !== 6) return false;
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

export function createTokens(theme: Theme) {
  const c = theme.colors;
  const dark = isDarkSurface(c.surface0);
  return {
    colors: {
      surfaceWorkspace: c.surface0,
      surface0: c.surface0,
      surface1: c.surface1,
      surface2: c.surface2,
      surface3: dark ? "#3f3f46" : "#e4e4e7",
      border: c.border,
      accent: c.accent,
      accentForeground: c.accentForeground,
      foreground: c.foreground,
      foregroundMuted: c.foregroundMuted,
      foregroundExtraMuted: c.foregroundMuted,
      danger: c.statusDanger,
      warning: c.statusWarning,
      success: c.statusSuccess,
      statusDotSuccess: dark ? "#35c264" : "#299f51",
      statusDotDanger: dark ? "#f7796d" : "#f12e2f",
      statusDotWarning: dark ? "#db932e" : "#b37824",
    },
    spacing: SPACING,
    fontSize: FONT_SIZE,
    fontWeight: FONT_WEIGHT,
    radius: RADIUS,
    control: CONTROL_HEIGHT,
    fontFamily: MONO_FONT,
  };
}

export type Tokens = ReturnType<typeof createTokens>;
