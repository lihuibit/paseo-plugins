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
  xs: 11,
  sm: 12,
  base: 14,
  lg: 16,
  xl: 18,
  "2xl": 20,
  "3xl": 26,
} as const;

export const RADIUS = {
  sm: 3,
  base: 4,
  md: 6,
  lg: 8,
  xl: 10,
  "2xl": 16,
  full: 9999,
} as const;

export const CONTROL_HEIGHT = {
  xs: 28,
  sm: 32,
  md: 40,
} as const;

export function createTokens(theme: Theme) {
  const c = theme.colors;
  return {
    colors: {
      surfaceWorkspace: c.surface0,
      surface0: c.surface0,
      surface1: c.surface1,
      surface2: c.surface2,
      surface3: c.surface2,
      border: c.border,
      accent: c.accent,
      accentForeground: c.accentForeground,
      foreground: c.foreground,
      foregroundMuted: c.foregroundMuted,
      danger: c.statusDanger,
      warning: c.statusWarning,
      success: c.statusSuccess,
    },
    spacing: SPACING,
    fontSize: FONT_SIZE,
    radius: RADIUS,
    control: CONTROL_HEIGHT,
  };
}

export type Tokens = ReturnType<typeof createTokens>;
