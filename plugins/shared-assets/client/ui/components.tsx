import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { Tokens } from "./tokens";

type ButtonVariant =
  "default" | "secondary" | "outline" | "ghost" | "danger" | "destructive";
type ButtonSize = "xs" | "sm" | "md";

export function Button({
  children,
  variant = "secondary",
  size = "sm",
  icon,
  onPress,
  disabled,
  style,
  textStyle,
  testID,
  accessibilityLabel,
  tokens,
}: {
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  testID?: string;
  accessibilityLabel?: string;
  tokens: Tokens;
}) {
  const height =
    size === "xs"
      ? tokens.control.xs
      : size === "sm"
        ? tokens.control.sm
        : tokens.control.md;
  const paddingHorizontal =
    size === "md" ? tokens.spacing[4] : tokens.spacing[3];
  const radius = size === "md" ? tokens.radius.lg : tokens.radius.md;
  const fontSize = size === "xs" ? tokens.fontSize.sm : tokens.fontSize.base;
  const iconSize = size === "xs" ? 12 : size === "sm" ? 14 : 16;
  const palette =
    variant === "default"
      ? {
          background: tokens.colors.accent,
          border: tokens.colors.accent,
          text: tokens.colors.accentForeground,
        }
      : variant === "outline"
        ? {
            background: "transparent",
            border: tokens.colors.border,
            text: tokens.colors.foreground,
          }
        : variant === "ghost"
          ? {
              background: "transparent",
              border: "transparent",
              text: tokens.colors.foregroundMuted,
            }
          : variant === "danger"
            ? {
                background: "transparent",
                border: tokens.colors.danger,
                text: tokens.colors.danger,
              }
            : variant === "destructive"
              ? {
                  background: tokens.colors.danger,
                  border: tokens.colors.danger,
                  text: tokens.colors.accentForeground,
                }
              : {
                  background: tokens.colors.surface3,
                  border: tokens.colors.surface3,
                  text: tokens.colors.foreground,
                };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }: PressableStateCallbackType) => [
        {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: tokens.spacing[2],
          height,
          paddingHorizontal,
          borderRadius: radius,
          borderWidth: 1,
          borderColor: palette.border,
          backgroundColor: palette.background,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {icon ? <Icon name={icon} size={iconSize} color={palette.text} /> : null}
      {children !== undefined ? (
        <Text
          numberOfLines={1}
          style={[
            { color: palette.text, fontSize, fontWeight: "normal" },
            textStyle,
          ]}
        >
          {children}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function IconButton({
  icon,
  onPress,
  tokens,
  label,
  disabled,
  testID,
}: {
  icon: string;
  onPress: () => void;
  tokens: Tokens;
  label: string;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }: PressableStateCallbackType) => ({
        width: tokens.control.sm,
        height: tokens.control.sm,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: tokens.radius.md,
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      <Icon name={icon} size={16} color={tokens.colors.foreground} />
    </Pressable>
  );
}

export function Alert({
  tone = "danger",
  title,
  description,
  tokens,
}: {
  tone?: "danger" | "warning" | "success";
  title: string;
  description?: string | null;
  tokens: Tokens;
}) {
  const color =
    tone === "danger"
      ? tokens.colors.danger
      : tone === "warning"
        ? tokens.colors.warning
        : tokens.colors.success;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: color,
        backgroundColor: `${color}16`,
        borderRadius: tokens.radius.lg,
        padding: tokens.spacing[3],
        gap: tokens.spacing[1],
      }}
    >
      <Text
        style={{ color, fontSize: tokens.fontSize.base, fontWeight: "600" }}
      >
        {title}
      </Text>
      {description ? (
        <Text
          style={{
            color: tokens.colors.foreground,
            fontSize: tokens.fontSize.sm,
            lineHeight: 18,
          }}
        >
          {description}
        </Text>
      ) : null}
    </View>
  );
}

export function Checkbox({
  checked,
  onPress,
  disabled,
  tokens,
  testID,
  accessibilityLabel,
  size = 20,
}: {
  checked: boolean;
  onPress: () => void;
  disabled?: boolean;
  tokens: Tokens;
  testID?: string;
  accessibilityLabel?: string;
  size?: number;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked, disabled }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <View
        style={{
          width: size,
          height: size,
          borderRadius: tokens.radius.md,
          borderWidth: 1,
          borderColor: checked ? tokens.colors.accent : tokens.colors.border,
          backgroundColor: checked
            ? tokens.colors.accent
            : tokens.colors.surface2,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked ? (
          <Icon name="Check" size={13} color={tokens.colors.accentForeground} />
        ) : null}
      </View>
    </Pressable>
  );
}

export function TextField({
  value,
  onChangeText,
  placeholder,
  tokens,
  multiline,
  secure,
  testID,
  editable = true,
  minHeight,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  tokens: Tokens;
  multiline?: boolean;
  secure?: boolean;
  testID?: string;
  editable?: boolean;
  minHeight?: number;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      placeholder={placeholder}
      placeholderTextColor={tokens.colors.foregroundMuted}
      editable={editable}
      secureTextEntry={secure}
      multiline={multiline}
      autoCapitalize="none"
      autoCorrect={false}
      testID={testID}
      style={{
        minHeight: multiline ? (minHeight ?? 120) : tokens.control.md,
        ...(multiline && minHeight ? { flexGrow: 1 } : {}),
        borderWidth: 1,
        borderColor: focused ? tokens.colors.accent : tokens.colors.border,
        borderRadius: tokens.radius.md,
        backgroundColor: tokens.colors.surface1,
        color: tokens.colors.foreground,
        paddingHorizontal: tokens.spacing[3],
        paddingVertical: tokens.spacing[2],
        fontSize: tokens.fontSize.base,
        textAlignVertical: multiline ? "top" : "center",
      }}
    />
  );
}

export function Field({
  label,
  hint,
  children,
  tokens,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  tokens: Tokens;
}) {
  return (
    <View style={{ gap: tokens.spacing[1.5] }}>
      <Text
        style={{
          color: tokens.colors.foreground,
          fontSize: tokens.fontSize.sm,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
      {children}
      {hint ? (
        <Text
          style={{
            color: tokens.colors.foregroundMuted,
            fontSize: tokens.fontSize.sm,
            lineHeight: 17,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function Panel({
  children,
  tokens,
  style,
}: {
  children: ReactNode;
  tokens: Tokens;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        {
          borderWidth: 1,
          borderColor: tokens.colors.border,
          borderRadius: tokens.radius.xl,
          backgroundColor: tokens.colors.surface1,
          padding: tokens.spacing[4],
          gap: tokens.spacing[3],
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionTitle({
  children,
  tokens,
  trailing,
}: {
  children: ReactNode;
  tokens: Tokens;
  trailing?: ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: tokens.spacing[3],
      }}
    >
      <Text
        style={{
          color: tokens.colors.foreground,
          fontSize: tokens.fontSize.lg,
          fontWeight: "600",
          flexShrink: 1,
        }}
      >
        {children}
      </Text>
      {trailing}
    </View>
  );
}

export function Muted({
  children,
  tokens,
  numberOfLines,
}: {
  children: ReactNode;
  tokens: Tokens;
  numberOfLines?: number;
}) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={{
        color: tokens.colors.foregroundMuted,
        fontSize: tokens.fontSize.sm,
      }}
    >
      {children}
    </Text>
  );
}

export function Mono({
  children,
  tokens,
  numberOfLines,
  testID,
}: {
  children: ReactNode;
  tokens: Tokens;
  numberOfLines?: number;
  testID?: string;
}) {
  return (
    <Text
      numberOfLines={numberOfLines}
      testID={testID}
      style={{
        color: tokens.colors.foreground,
        fontSize: tokens.fontSize.sm,
        fontFamily: tokens.fontFamily,
      }}
    >
      {children}
    </Text>
  );
}

export function Empty({
  children,
  tokens,
}: {
  children: ReactNode;
  tokens: Tokens;
}) {
  return (
    <Text
      style={{
        color: tokens.colors.foregroundMuted,
        fontSize: tokens.fontSize.base,
        paddingVertical: tokens.spacing[4],
      }}
    >
      {children}
    </Text>
  );
}

export function Spinner({ tokens }: { tokens: Tokens }) {
  return (
    <View style={{ paddingVertical: tokens.spacing[6] }}>
      <ActivityIndicator color={tokens.colors.foregroundMuted} />
    </View>
  );
}

export function TabRail({
  children,
  tokens,
}: {
  children: ReactNode;
  tokens: Tokens;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        gap: tokens.spacing[1],
        borderBottomWidth: 1,
        borderBottomColor: tokens.colors.border,
        paddingHorizontal: tokens.spacing[4],
        paddingTop: tokens.spacing[2],
      }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 4, alignItems: "center" }}
      >
        {children}
      </ScrollView>
    </View>
  );
}

export function TabButton({
  active,
  label,
  count,
  onPress,
  tokens,
  testID,
}: {
  active: boolean;
  label: string;
  count?: number;
  onPress: () => void;
  tokens: Tokens;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      testID={testID}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        borderBottomWidth: 2,
        borderBottomColor: active ? tokens.colors.accent : "transparent",
        paddingHorizontal: 12,
        paddingVertical: 10,
      }}
    >
      <Text
        style={{
          color: active
            ? tokens.colors.foreground
            : tokens.colors.foregroundMuted,
          fontSize: tokens.fontSize.sm,
          fontWeight: active
            ? tokens.fontWeight.semibold
            : tokens.fontWeight.normal,
        }}
      >
        {label}
      </Text>
      {count ? (
        <View
          style={{
            minWidth: 18,
            height: 18,
            paddingHorizontal: tokens.spacing[1],
            borderRadius: tokens.radius.full,
            backgroundColor: tokens.colors.statusDotWarning,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            style={{
              color: tokens.colors.accentForeground,
              fontSize: tokens.fontSize.sm,
              fontWeight: tokens.fontWeight.medium,
            }}
          >
            {count}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * The in-page overlay the AgentStorm shared-asset dialogs use. The plugin host
 * modal has its own chrome and width, which is why the two implementations did
 * not line up; this one lives inside the screen and can be matched exactly.
 */
export function Overlay({
  open,
  onClose,
  children,
  tokens,
  maxWidth = 520,
  height,
  width = "100%",
  zIndex = 20,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  tokens: Tokens;
  maxWidth?: number;
  height?: number | `${number}%`;
  width?: number | `${number}%`;
  zIndex?: number;
}) {
  if (!open) return null;
  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0,0,0,0.34)",
        padding: tokens.spacing[4],
      }}
      onStartShouldSetResponder={() => true}
      onResponderRelease={onClose}
    >
      <View
        style={{
          width,
          maxWidth,
          ...(height ? { height } : {}),
          overflow: "hidden",
          borderRadius: tokens.radius.xl,
          borderWidth: 1,
          borderColor: tokens.colors.border,
          backgroundColor: tokens.colors.surface1,
        }}
        onStartShouldSetResponder={() => true}
        onResponderRelease={() => undefined}
      >
        {children}
      </View>
    </View>
  );
}

export function DialogHeader({
  title,
  description,
  tokens,
  onClose,
  closeDisabled,
}: {
  title: string;
  description?: string | null;
  tokens: Tokens;
  onClose: () => void;
  closeDisabled?: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: tokens.spacing[3],
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          style={{
            color: tokens.colors.foreground,
            fontSize: tokens.fontSize.lg,
            fontWeight: tokens.fontWeight.semibold,
          }}
        >
          {title}
        </Text>
        {description ? (
          <Text
            style={{
              color: tokens.colors.foregroundMuted,
              fontSize: tokens.fontSize.sm,
            }}
          >
            {description}
          </Text>
        ) : null}
      </View>
      <Button
        accessibilityLabel="关闭"
        size="xs"
        variant="ghost"
        disabled={closeDisabled}
        onPress={onClose}
        tokens={tokens}
      >
        <Icon name="X" size={16} color={tokens.colors.foregroundMuted} />
      </Button>
    </View>
  );
}

export function DialogSummary({
  title,
  description,
  warning,
  tokens,
}: {
  title?: string;
  description?: string;
  warning?: string;
  tokens: Tokens;
}) {
  return (
    <View
      style={{
        gap: tokens.spacing[1],
        borderRadius: tokens.radius.lg,
        backgroundColor: tokens.colors.surface2,
        padding: tokens.spacing[3],
      }}
    >
      {title ? (
        <Text
          style={{
            color: tokens.colors.accent,
            fontSize: tokens.fontSize.sm,
            fontWeight: tokens.fontWeight.semibold,
          }}
        >
          {title}
        </Text>
      ) : null}
      {description ? (
        <Text
          style={{
            color: tokens.colors.foregroundMuted,
            fontSize: tokens.fontSize.sm,
          }}
        >
          {description}
        </Text>
      ) : null}
      {warning ? (
        <Text
          style={{
            color: tokens.colors.warning,
            fontSize: tokens.fontSize.sm,
          }}
        >
          {warning}
        </Text>
      ) : null}
    </View>
  );
}

export function useDelayedFlag(active: boolean, delayMs = 180): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return visible;
}
