import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TaskBoardScreen } from "./client/screen";
import { TaskBoardSidebarItem } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: "task-board",
    title: "任务",
    Component: TaskBoardScreen,
  });
  client.addSidebarHeaderItem({
    id: "task-board",
    title: "任务看板",
    Component: TaskBoardSidebarItem,
  });
  client.addCommandCenterItem({
    id: "task-board-open",
    title: "打开任务看板",
    icon: "SquareKanban",
    keywords: ["task", "board", "kanban", "任务", "看板"],
    context: "global",
    onSelect: (context) => context.openScreen({ screenId: "task-board" }),
  });
  client.addCommandCenterItem({
    id: "task-board-new",
    title: "新建看板任务",
    icon: "Plus",
    keywords: ["new task", "新建任务", "看板"],
    context: "workspace",
    onSelect: (context) =>
      context.openScreen({
        screenId: "task-board",
        params: { new: "1" },
      }),
  });
  return () => {};
}
