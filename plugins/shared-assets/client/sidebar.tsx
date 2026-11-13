import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";

export function SharedAssetsSidebarItem({
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="LibraryBig"
      label="共享资产"
      active={currentScreen?.screenId === "shared-assets"}
      onPress={() => openScreen({ screenId: "shared-assets" })}
    />
  );
}
