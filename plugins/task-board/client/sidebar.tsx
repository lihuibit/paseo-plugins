import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { listRpc } from "../shared/contracts";

export function TaskBoardSidebarItem({
  currentScreen,
  openScreen,
  theme,
}: PluginSidebarItemProps) {
  const list = useRpc(listRpc);
  const [attention, setAttention] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const envelope = await list({ includeFinished: false });
      if (!active || !envelope.ok) return;
      setAttention(
        (envelope.value.counts.in_review ?? 0) +
          (envelope.value.counts.blocked ?? 0),
      );
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [list]);

  return (
    <SidebarRow
      icon="CheckSquare"
      label="任务"
      active={currentScreen?.screenId === "task-board"}
      onPress={() => openScreen({ screenId: "task-board" })}
      trailing={
        attention ? (
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 11,
              minWidth: 18,
              textAlign: "right",
            }}
          >
            {attention}
          </Text>
        ) : null
      }
    />
  );
}
