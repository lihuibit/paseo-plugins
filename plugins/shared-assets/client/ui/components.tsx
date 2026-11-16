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
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import type { Tokens } from "./tokens";

type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "danger";
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
  const iconSize = size === "xs" ? 12 : 14;
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
            : {
                background: tokens.colors.surface2,
                border: tokens.colors.surface2,
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
          opacity: disabled ? 0.45 : pressed ? 0.82 : 1,
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

export function Badge({
  label,
  tone,
  tokens,
}: {
  label: string;
  tone?: "ok" | "warn" | "danger" | "muted";
  tokens: Tokens;
}) {
  const color =
    tone === "ok"
      ? tokens.colors.success
      : tone === "warn"
        ? tokens.colors.warning
        : tone === "danger"
          ? tokens.colors.danger
          : tokens.colors.foregroundMuted;
  return (
    <View
      style={{
        borderRadius: tokens.radius.full,
        borderWidth: 1,
        borderColor: tone === "ok" ? color : tokens.colors.border,
        backgroundColor: tone === "ok" ? `${color}1a` : tokens.colors.surface1,
        paddingHorizontal: tokens.spacing[2],
        paddingVertical: 2,
      }}
    >
      <Text style={{ color, fontSize: tokens.fontSize.xs }}>{label}</Text>
    </View>
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
  size = 16,
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
        width: size + 6,
        height: size + 6,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <View
        style={{
          width: size,
          height: size,
          borderRadius: 3,
          borderWidth: 1,
          borderColor: checked
            ? tokens.colors.accent
            : tokens.colors.foregroundMuted,
          backgroundColor: checked ? tokens.colors.accent : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked ? (
          <Icon name="Check" size={11} color={tokens.colors.accentForeground} />
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
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  tokens: Tokens;
  multiline?: boolean;
  secure?: boolean;
  testID?: string;
  editable?: boolean;
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
        minHeight: multiline ? 120 : tokens.control.md,
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
        lineHeight: 18,
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
        fontFamily: "monospace",
        lineHeight: 17,
      }}
    >
      {children}
    </Text>
  );
}

export function Divider({ tokens }: { tokens: Tokens }) {
  return (
    <View
      style={{
        height: 1,
        backgroundColor: tokens.colors.border,
        width: "100%",
      }}
    />
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

export function TabRail({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 4, paddingVertical: 2 }}
    >
      {children}
    </ScrollView>
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
        paddingVertical: tokens.spacing[1.5],
        paddingHorizontal: tokens.spacing[3],
        borderRadius: tokens.radius.md,
        backgroundColor: active ? tokens.colors.surface2 : "transparent",
      }}
    >
      <Text
        style={{
          color: active
            ? tokens.colors.foreground
            : tokens.colors.foregroundMuted,
          fontSize: tokens.fontSize.base,
          fontWeight: active ? "600" : "normal",
        }}
      >
        {label}
      </Text>
      {count ? (
        <View
          style={{
            minWidth: 16,
            height: 16,
            paddingHorizontal: 4,
            borderRadius: 8,
            backgroundColor: tokens.colors.accent,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            style={{
              color: tokens.colors.accentForeground,
              fontSize: 10,
              fontWeight: "600",
            }}
          >
            {count}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  children,
  width = 640,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  width?: number;
}) {
  return (
    <Modal title={title} open={open} onOpenChange={onOpenChange}>
      <Modal.Content
        contentContainerStyle={{ width, maxWidth: "100%", gap: 12 }}
      >
        {children}
      </Modal.Content>
    </Modal>
  );
}

export function ConfirmInline({
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  tokens,
  destructive,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  tokens: Tokens;
  destructive?: boolean;
}) {
  return (
    <View
      style={{
        gap: tokens.spacing[2],
        borderWidth: 1,
        borderColor: destructive ? tokens.colors.danger : tokens.colors.border,
        borderRadius: tokens.radius.lg,
        padding: tokens.spacing[3],
      }}
    >
      <Text style={{ color: tokens.colors.foreground, fontWeight: "600" }}>
        {title}
      </Text>
      {description ? <Muted tokens={tokens}>{description}</Muted> : null}
      <View style={{ flexDirection: "row", gap: tokens.spacing[2] }}>
        <Button
          tokens={tokens}
          size="xs"
          variant={destructive ? "danger" : "default"}
          onPress={onConfirm}
        >
          {confirmLabel}
        </Button>
        <Button tokens={tokens} size="xs" variant="ghost" onPress={onCancel}>
          {cancelLabel}
        </Button>
      </View>
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
