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
  6: 24,
  8: 32,
} as const;

export const FONT_SIZE = {
  sm: 12,
  base: 14,
  lg: 16,
  xl: 18,
  "2xl": 20,
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
      borderAccent: c.accent,
      foreground: c.foreground,
      foregroundMuted: c.foregroundMuted,
      foregroundExtraMuted: c.foregroundMuted,
      accent: c.accent,
      accentForeground: c.accentForeground,
      destructive: c.statusDanger,
      destructiveForeground: c.accentForeground,
      statusDotRunning: c.statusSuccess,
      statusDotWarning: c.statusWarning,
      statusDotDanger: c.statusDanger,
      statusDotSuccess: c.statusSuccess,
    },
    spacing: SPACING,
    fontSize: FONT_SIZE,
    radius: RADIUS,
    control: CONTROL_HEIGHT,
  };
}

export type Tokens = ReturnType<typeof createTokens>;
