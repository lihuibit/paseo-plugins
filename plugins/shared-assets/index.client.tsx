import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SharedAssetsScreen } from "./client/screen";
import { SharedAssetsSidebarItem } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: "shared-assets",
    title: "共享资产",
    Component: SharedAssetsScreen,
  });
  client.addSidebarHeaderItem({
    id: "shared-assets",
    title: "共享资产",
    Component: SharedAssetsSidebarItem,
  });
  client.addCommandCenterItem({
    id: "shared-assets-open",
    title: "打开共享资产",
    icon: "LibraryBig",
    keywords: ["shared", "assets", "skills", "共享资产"],
    context: "global",
    onSelect: (context) => context.openScreen({ screenId: "shared-assets" }),
  });
  return () => {};
}
