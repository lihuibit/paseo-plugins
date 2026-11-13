import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type PressableStateCallbackType,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { BoardStatus } from "../../shared/core/board/types";
import { BOARD_STATUS_LABELS } from "../../shared/core/board/types";
import type { Tokens } from "./tokens";

type ButtonVariant =
  "default" | "secondary" | "outline" | "ghost" | "destructive";
type ButtonSize = "xs" | "sm" | "md";

/**
 * The board UI uses Paseo's theme tokens through this hook rather than a
 * custom theme. Components receive `tokens` explicitly so the same component
 * can render on light and dark hosts.
 */
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
          : variant === "destructive"
            ? {
                background: tokens.colors.destructive,
                border: tokens.colors.destructive,
                text: tokens.colors.destructiveForeground,
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
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {icon ? <Icon name={icon} size={iconSize} color={palette.text} /> : null}
      {children !== undefined ? (
        <Text
          style={[
            {
              color: palette.text,
              fontSize,
              fontWeight: "normal",
            },
            textStyle,
          ]}
          numberOfLines={1}
        >
          {children}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function SearchField({
  value,
  onChangeText,
  placeholder,
  tokens,
  testID,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  tokens: Tokens;
  testID?: string;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: tokens.spacing[2],
        flex: 1,
        minWidth: 0,
        maxWidth: 420,
        paddingVertical: tokens.spacing[1.5],
        paddingHorizontal: tokens.spacing[3],
        borderRadius: tokens.radius.md,
        backgroundColor: focused
          ? tokens.colors.surface2
          : tokens.colors.surface1,
        borderWidth: 1,
        borderColor: focused
          ? tokens.colors.borderAccent
          : tokens.colors.border,
      }}
    >
      <Icon name="Search" size={14} color={tokens.colors.foregroundMuted} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        placeholderTextColor={tokens.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        testID={testID}
        style={{
          flex: 1,
          minWidth: 0,
          height: 20,
          padding: 0,
          outlineWidth: 0,
          outlineStyle: "solid",
          outlineColor: "transparent",
          color: tokens.colors.foreground,
          fontSize: tokens.fontSize.base,
        }}
      />
      {value.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="清除搜索"
          onPress={() => onChangeText("")}
          hitSlop={8}
        >
          <Icon name="X" size={14} color={tokens.colors.foregroundMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

export interface SegmentOption<Value extends string> {
  value: Value;
  label: string;
  icon?: string;
  disabled?: boolean;
  testID?: string;
}

export function SegmentedControl<Value extends string>({
  options,
  value,
  onValueChange,
  tokens,
  size = "sm",
  hideLabels,
  style,
}: {
  options: ReadonlyArray<SegmentOption<Value>>;
  value: Value;
  onValueChange: (value: Value) => void;
  tokens: Tokens;
  size?: "xs" | "sm" | "md";
  hideLabels?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const height = size === "xs" ? 28 : size === "sm" ? 32 : 44;
  const fontSize = size === "xs" ? tokens.fontSize.sm : tokens.fontSize.base;
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: tokens.spacing[1],
          minHeight: height,
        },
        style,
      ]}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled: option.disabled }}
            disabled={option.disabled}
            onPress={() => {
              if (!option.disabled && option.value !== value)
                onValueChange(option.value);
            }}
            testID={option.testID}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: tokens.spacing[1],
              height: height - (size === "md" ? 6 : 4),
              paddingHorizontal:
                size === "md" ? tokens.spacing[3] : tokens.spacing[2],
              borderRadius: size === "md" ? tokens.radius.lg : tokens.radius.md,
              backgroundColor: selected
                ? tokens.colors.surface3
                : "transparent",
              opacity: option.disabled ? 0.5 : 1,
            }}
          >
            {option.icon ? (
              <Icon
                name={option.icon}
                size={size === "xs" ? 12 : 14}
                color={
                  selected
                    ? tokens.colors.foreground
                    : tokens.colors.foregroundMuted
                }
              />
            ) : null}
            {hideLabels ? null : (
              <Text
                numberOfLines={1}
                style={{
                  color: selected
                    ? tokens.colors.foreground
                    : tokens.colors.foregroundMuted,
                  fontSize,
                }}
              >
                {option.label}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

export function SwitchControl({
  value,
  onValueChange,
  tokens,
  testID,
}: {
  value: boolean;
  onValueChange: (value: boolean) => void;
  tokens: Tokens;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      testID={testID}
      onPress={() => onValueChange(!value)}
      style={{
        width: 34,
        height: 20,
        borderRadius: 10,
        backgroundColor: value ? tokens.colors.accent : tokens.colors.surface1,
        borderWidth: 1,
        borderColor: value ? tokens.colors.accent : tokens.colors.border,
        position: "relative",
      }}
    >
      <View
        style={{
          position: "absolute",
          top: 1,
          left: value ? 15 : 1,
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: value
            ? tokens.colors.accentForeground
            : tokens.colors.surface0,
          borderWidth: 1,
          borderColor: tokens.colors.border,
        }}
      />
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  children,
  tokens,
}: {
  label?: string;
  hint?: string;
  children: ReactNode;
  tokens: Tokens;
}) {
  return (
    <View style={{ gap: tokens.spacing[2] }}>
      {label ? (
        <Text
          style={{
            color: tokens.colors.foregroundMuted,
            fontSize: tokens.fontSize.base,
          }}
        >
          {label}
        </Text>
      ) : null}
      {children}
      {hint ? (
        <Text
          style={{
            color: tokens.colors.foregroundMuted,
            fontSize: tokens.fontSize.sm,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function FormInput({
  value,
  onChangeText,
  placeholder,
  tokens,
  multiline,
  minHeight,
  editable = true,
  autoFocus,
  onFocus,
  onBlur,
  testID,
  style,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  tokens: Tokens;
  multiline?: boolean;
  minHeight?: number;
  editable?: boolean;
  autoFocus?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        {
          minHeight: minHeight ?? (multiline ? 88 : 32),
          paddingHorizontal: tokens.spacing[3],
          paddingVertical: multiline ? tokens.spacing[2] : 0,
          justifyContent: multiline ? "flex-start" : "center",
          borderRadius: tokens.radius.md,
          backgroundColor: tokens.colors.surface2,
          borderWidth: 1,
          borderColor: "transparent",
        },
        style,
      ]}
    >
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={tokens.colors.foregroundMuted}
        editable={editable}
        autoFocus={autoFocus}
        onFocus={onFocus}
        onBlur={onBlur}
        multiline={multiline}
        textAlignVertical={multiline ? "top" : "center"}
        testID={testID}
        style={{
          flex: 1,
          minWidth: 0,
          padding: 0,
          outlineWidth: 0,
          outlineStyle: "solid",
          outlineColor: "transparent",
          color: tokens.colors.foreground,
          fontSize: tokens.fontSize.base,
        }}
      />
    </View>
  );
}

export interface MenuOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  destructive?: boolean;
}

export interface MenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MenuRequest {
  title?: string;
  options: MenuOption[];
  selected?: string;
  /** Viewport coordinates of the control that opened the menu. */
  anchor?: MenuAnchor;
  onSelect: (value: string) => void;
}

function measureAnchor(
  ref: RefObject<View | null>,
  onMeasured: (anchor?: MenuAnchor) => void,
): void {
  const node = ref.current;
  if (!node || typeof node.measureInWindow !== "function") {
    onMeasured();
    return;
  }
  node.measureInWindow((x, y, width, height) => {
    onMeasured({ x, y, width, height });
  });
}

interface OverlayContextValue {
  openMenu: (request: MenuRequest) => void;
  closeMenu: () => void;
}

const OverlayContext = createContext<OverlayContextValue | null>(null);

export function useOverlayMenu(): OverlayContextValue {
  const value = useContext(OverlayContext);
  if (!value) throw new Error("OverlayMenuProvider is missing");
  return value;
}

export function OverlayMenuProvider({
  children,
  tokens,
}: {
  children: ReactNode;
  tokens: Tokens;
}) {
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [menuHeight, setMenuHeight] = useState<number | null>(null);
  const openMenu = useCallback((request: MenuRequest) => {
    setMenuHeight(null);
    setMenu(request);
  }, []);
  const closeMenu = useCallback(() => {
    setMenu((current) => (current ? null : current));
  }, []);
  const value = useMemo(() => ({ openMenu, closeMenu }), [openMenu, closeMenu]);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const overlayRef = useRef<View>(null);
  const [overlayOffset, setOverlayOffset] = useState({ x: 0, y: 0 });

  const measureOverlay = useCallback(() => {
    overlayRef.current?.measureInWindow((x, y) => {
      setOverlayOffset((current) =>
        current.x === x && current.y === y ? current : { x, y },
      );
    });
  }, []);

  useEffect(() => {
    measureOverlay();
  }, [measureOverlay, windowHeight, windowWidth]);

  useEffect(() => {
    setMenuHeight(null);
    measureOverlay();
  }, [measureOverlay, menu]);

  useEffect(() => {
    if (!menu || typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(null);
      }
    };
    const onScrollIntent = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-testid="overlay-menu"]')
      ) {
        return;
      }
      setMenu(null);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("wheel", onScrollIntent, { passive: true });
    window.addEventListener("touchmove", onScrollIntent, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", onScrollIntent);
      window.removeEventListener("touchmove", onScrollIntent);
    };
  }, [menu]);

  const geometry = useMemo(() => {
    if (!menu) return null;
    const margin = 8;
    const gap = 6;
    const width = Math.min(320, windowWidth - margin * 2);
    const estimatedHeight = Math.min(
      52 + menu.options.length * 40,
      440,
      windowHeight - margin * 2,
    );
    const height = menuHeight ?? estimatedHeight;
    const anchor = menu.anchor;
    const toSurface = (left: number, top: number) => ({
      left: left - overlayOffset.x,
      top: top - overlayOffset.y,
    });
    if (!anchor) {
      const position = toSurface(
        (windowWidth - width) / 2,
        (windowHeight - height) / 2,
      );
      return {
        left: position.left,
        top: position.top,
        width,
        maxHeight: height,
      };
    }
    const left = Math.min(
      Math.max(anchor.x + anchor.width / 2 - width / 2, margin),
      windowWidth - width - margin,
    );
    const below = anchor.y + anchor.height + gap;
    const above = anchor.y - gap;
    const fitsBelow = below + height <= windowHeight - margin;
    const fitsAbove = above - height >= margin;
    if (fitsBelow || !fitsAbove) {
      const windowTop = Math.max(
        margin,
        Math.min(below, windowHeight - margin - 96),
      );
      const position = toSurface(left, windowTop);
      return {
        left: position.left,
        top: position.top,
        width,
        maxHeight: Math.max(96, windowHeight - margin - windowTop),
      };
    }
    const position = toSurface(left, above - height);
    return {
      left: position.left,
      top: position.top,
      width,
      maxHeight: height,
    };
  }, [
    menu,
    menuHeight,
    overlayOffset.x,
    overlayOffset.y,
    windowHeight,
    windowWidth,
  ]);

  return (
    <OverlayContext.Provider value={value}>
      {children}
      <View
        ref={overlayRef}
        pointerEvents="box-none"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 2000,
        }}
      >
        {menu && geometry ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭菜单"
              onPress={() => setMenu(null)}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
              }}
            />
            <View
              testID="overlay-menu"
              onLayout={(event) => {
                const height = event.nativeEvent.layout.height;
                setMenuHeight((current) =>
                  current !== null && Math.abs(current - height) < 0.5
                    ? current
                    : height,
                );
              }}
              style={{
                position: "absolute",
                left: geometry.left,
                top: geometry.top,
                width: geometry.width,
                maxHeight: geometry.maxHeight,
                borderRadius: tokens.radius.xl,
                borderWidth: 1,
                borderColor: tokens.colors.border,
                backgroundColor: tokens.colors.surface0,
                overflow: "hidden",
                shadowColor: "#000",
                shadowOpacity: 0.18,
                shadowRadius: 18,
                shadowOffset: { width: 0, height: 8 },
                elevation: 12,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: tokens.spacing[4],
                  paddingVertical: tokens.spacing[3],
                  borderBottomWidth: 1,
                  borderBottomColor: tokens.colors.border,
                }}
              >
                <Text
                  style={{
                    flex: 1,
                    color: tokens.colors.foreground,
                    fontSize: tokens.fontSize.base,
                    fontWeight: "500",
                  }}
                >
                  {menu.title ?? "选择"}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="关闭"
                  onPress={() => setMenu(null)}
                  hitSlop={8}
                >
                  <Icon
                    name="X"
                    size={16}
                    color={tokens.colors.foregroundMuted}
                  />
                </Pressable>
              </View>
              <ScrollView style={{ flexGrow: 0 }}>
                {menu.options.map((option) => {
                  const selected = option.value === menu.selected;
                  return (
                    <Pressable
                      key={option.value}
                      accessibilityRole="button"
                      disabled={option.disabled}
                      onPress={() => {
                        if (option.disabled) return;
                        setMenu(null);
                        menu.onSelect(option.value);
                      }}
                      style={{
                        paddingHorizontal: tokens.spacing[4],
                        paddingVertical: tokens.spacing[2],
                        backgroundColor: selected
                          ? tokens.colors.surface2
                          : "transparent",
                        opacity: option.disabled ? 0.5 : 1,
                        gap: 2,
                      }}
                    >
                      <Text
                        style={{
                          color: option.destructive
                            ? tokens.colors.destructive
                            : tokens.colors.foreground,
                          fontSize: tokens.fontSize.base,
                        }}
                      >
                        {option.label}
                      </Text>
                      {option.description ? (
                        <Text
                          style={{
                            color: tokens.colors.foregroundMuted,
                            fontSize: tokens.fontSize.sm,
                          }}
                        >
                          {option.description}
                        </Text>
                      ) : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          </>
        ) : null}
      </View>
    </OverlayContext.Provider>
  );
}

export function SelectField({
  label,
  value,
  options,
  placeholder,
  onChange,
  tokens,
  disabled,
  hint,
  size = "sm",
  testID,
}: {
  label: string;
  value: string | null;
  options: MenuOption[];
  placeholder: string;
  onChange: (value: string) => void;
  tokens: Tokens;
  disabled?: boolean;
  hint?: string;
  size?: "sm" | "md";
  testID?: string;
}) {
  const { openMenu } = useOverlayMenu();
  const triggerRef = useRef<View>(null);
  const selected = options.find((option) => option.value === value);
  const height = size === "md" ? tokens.control.md : tokens.control.sm;
  return (
    <Field label={label} hint={hint} tokens={tokens}>
      <Pressable
        ref={triggerRef}
        accessibilityRole="button"
        accessibilityLabel={`${label}：${selected?.label ?? placeholder}`}
        disabled={disabled}
        testID={testID}
        onPress={() =>
          measureAnchor(triggerRef, (anchor) =>
            openMenu({
              title: label,
              options,
              selected: value ?? undefined,
              anchor,
              onSelect: onChange,
            }),
          )
        }
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: tokens.spacing[2],
          height,
          paddingHorizontal: tokens.spacing[3],
          borderRadius: size === "md" ? tokens.radius.lg : tokens.radius.md,
          backgroundColor: tokens.colors.surface2,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            minWidth: 0,
            color: selected
              ? tokens.colors.foreground
              : tokens.colors.foregroundMuted,
            fontSize: tokens.fontSize.base,
          }}
        >
          {selected?.label ?? placeholder}
        </Text>
        <Icon
          name="ChevronDown"
          size={14}
          color={tokens.colors.foregroundMuted}
        />
      </Pressable>
    </Field>
  );
}

export function Pill({
  label,
  active,
  onPress,
  tokens,
  icon,
  onRemove,
  disabled,
  testID,
}: {
  label: string;
  active?: boolean;
  onPress?: (anchor?: MenuAnchor) => void;
  tokens: Tokens;
  icon?: string;
  onRemove?: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  const triggerRef = useRef<View>(null);
  return (
    <Pressable
      ref={triggerRef}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || (!onPress && !onRemove)}
      onPress={
        onPress
          ? () => measureAnchor(triggerRef, (anchor) => onPress(anchor))
          : undefined
      }
      testID={testID}
      style={{
        height: 28,
        flexDirection: "row",
        alignItems: "center",
        gap: tokens.spacing[1],
        paddingLeft: tokens.spacing[3],
        paddingRight: onRemove ? tokens.spacing[1] : tokens.spacing[3],
        borderRadius: 14,
        borderWidth: 1,
        borderColor: active ? tokens.colors.surface3 : tokens.colors.border,
        backgroundColor: active ? tokens.colors.surface2 : "transparent",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon ? (
        <Icon name={icon} size={12} color={tokens.colors.foregroundMuted} />
      ) : null}
      <Text
        numberOfLines={1}
        style={{
          color: active
            ? tokens.colors.foreground
            : tokens.colors.foregroundMuted,
          fontSize: tokens.fontSize.sm,
          fontWeight: "500",
        }}
      >
        {label}
      </Text>
      {onRemove ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`移除标签 ${label}`}
          onPress={onRemove}
          hitSlop={6}
          style={{ padding: 2 }}
        >
          <Icon name="X" size={12} color={tokens.colors.foregroundMuted} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

export function SectionLabel({
  label,
  tokens,
}: {
  label: string;
  tokens: Tokens;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: tokens.spacing[2],
        paddingTop: tokens.spacing[2],
      }}
    >
      <Text
        style={{
          color: tokens.colors.foregroundMuted,
          fontSize: tokens.fontSize.sm,
          fontWeight: "500",
        }}
      >
        {label}
      </Text>
      <View
        style={{ flex: 1, height: 1, backgroundColor: tokens.colors.border }}
      />
    </View>
  );
}

export function statusDotColor(
  status: BoardStatus,
  tokens: Tokens,
): string | null {
  switch (status) {
    case "in_progress":
      return tokens.colors.statusDotRunning;
    case "in_review":
      return tokens.colors.statusDotWarning;
    case "blocked":
      return tokens.colors.statusDotDanger;
    case "done":
      return tokens.colors.statusDotSuccess;
    default:
      return null;
  }
}

export function StatusDot({
  status,
  tokens,
}: {
  status: BoardStatus;
  tokens: Tokens;
}) {
  const color = statusDotColor(status, tokens);
  if (!color) return null;
  return (
    <View
      style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }}
    />
  );
}

export function StatusMenuTrigger({
  status,
  onPress,
  tokens,
  disabled,
  testID,
}: {
  status: BoardStatus;
  onPress: (anchor?: MenuAnchor) => void;
  tokens: Tokens;
  disabled?: boolean;
  testID?: string;
}) {
  const triggerRef = useRef<View>(null);
  return (
    <Pressable
      ref={triggerRef}
      accessibilityRole="button"
      accessibilityLabel="切换任务状态"
      disabled={disabled}
      onPress={() => measureAnchor(triggerRef, onPress)}
      testID={testID}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: tokens.spacing[1],
        height: 28,
        paddingHorizontal: tokens.spacing[2],
        borderRadius: tokens.radius.md,
        borderWidth: 1,
        borderColor: tokens.colors.border,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        style={{
          color: tokens.colors.foregroundMuted,
          fontSize: tokens.fontSize.sm,
        }}
      >
        {BOARD_STATUS_LABELS[status]}
      </Text>
      <Icon
        name="ChevronDown"
        size={12}
        color={tokens.colors.foregroundMuted}
      />
    </Pressable>
  );
}

export function StatusBadge({
  label,
  tokens,
}: {
  label: string;
  tokens: Tokens;
}) {
  return (
    <View
      style={{
        borderRadius: tokens.radius.base,
        backgroundColor: `${tokens.colors.destructive}1f`,
        paddingHorizontal: tokens.spacing[1.5],
        paddingVertical: 1,
        alignSelf: "flex-start",
      }}
    >
      <Text
        style={{
          color: tokens.colors.destructive,
          fontSize: tokens.fontSize.sm,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

export function Alert({
  variant,
  title,
  description,
  tokens,
}: {
  variant: "error" | "success";
  title: string;
  description?: string;
  tokens: Tokens;
}) {
  const color =
    variant === "error"
      ? tokens.colors.destructive
      : tokens.colors.statusDotSuccess;
  return (
    <View
      style={{
        gap: tokens.spacing[1],
        padding: tokens.spacing[3],
        borderRadius: tokens.radius.lg,
        borderWidth: 1,
        borderColor: color,
        backgroundColor: tokens.colors.surface1,
      }}
    >
      <Text
        style={{ color, fontSize: tokens.fontSize.base, fontWeight: "500" }}
      >
        {title}
      </Text>
      {description ? (
        <Text
          style={{
            color: tokens.colors.foreground,
            fontSize: tokens.fontSize.sm,
          }}
        >
          {description}
        </Text>
      ) : null}
    </View>
  );
}

export function Hint({
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
        fontSize: tokens.fontSize.sm,
        lineHeight: Math.round(tokens.fontSize.sm * 1.4),
      }}
    >
      {children}
    </Text>
  );
}

export function Sheet({
  visible,
  title,
  onClose,
  children,
  footer,
  tokens,
  compact,
  width = 720,
  height,
  testID,
  scrollable = true,
  contentStyle,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  tokens: Tokens;
  compact: boolean;
  width?: number;
  height?: number;
  testID?: string;
  scrollable?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const overlay = useContext(OverlayContext);
  if (!visible) return null;
  const body = (
    <View style={{ gap: tokens.spacing[3], flexGrow: 1 }}>{children}</View>
  );
  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1000,
        backgroundColor: "rgba(0,0,0,0.32)",
        alignItems: "center",
        justifyContent: compact ? "flex-end" : "center",
      }}
    >
      <View
        testID={testID}
        style={{
          width: compact ? "100%" : width,
          maxWidth: compact ? "100%" : "94%",
          height: compact ? "92%" : height,
          maxHeight: compact ? "92%" : "88%",
          borderRadius: compact ? 0 : tokens.radius.xl,
          borderTopLeftRadius: tokens.radius.xl,
          borderTopRightRadius: tokens.radius.xl,
          borderWidth: 1,
          borderColor: tokens.colors.border,
          backgroundColor: tokens.colors.surface0,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: tokens.spacing[6],
            paddingVertical: tokens.spacing[6],
            gap: tokens.spacing[2],
          }}
        >
          <Text
            style={{
              flex: 1,
              color: tokens.colors.foreground,
              fontSize: tokens.fontSize.lg,
              fontWeight: "500",
            }}
          >
            {title}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭"
            onPress={onClose}
            hitSlop={8}
          >
            <Icon name="X" size={16} color={tokens.colors.foregroundMuted} />
          </Pressable>
        </View>
        {scrollable ? (
          <ScrollView
            style={{ flex: 1 }}
            onScroll={overlay?.closeMenu}
            scrollEventThrottle={16}
            contentContainerStyle={[
              {
                paddingHorizontal: tokens.spacing[6],
                paddingBottom: tokens.spacing[4],
                gap: tokens.spacing[3],
              },
              contentStyle,
            ]}
          >
            {body}
          </ScrollView>
        ) : (
          <View
            style={[
              {
                flex: 1,
                paddingHorizontal: tokens.spacing[6],
                paddingBottom: tokens.spacing[4],
              },
              contentStyle,
            ]}
          >
            {body}
          </View>
        )}
        {footer ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: tokens.spacing[2],
              paddingHorizontal: tokens.spacing[6],
              paddingVertical: tokens.spacing[4],
            }}
          >
            {footer}
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function Loading({ tokens }: { tokens: Tokens }) {
  return <ActivityIndicator color={tokens.colors.foregroundMuted} />;
}
