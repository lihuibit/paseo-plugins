import type {
  AgentSnapshotPayload,
  WorkspaceDescriptorPayload,
  WorkspaceProjectDescriptorPayload,
} from "@getpaseo/protocol/messages";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

export type PaseoApi = PluginHandlerContext["paseo"];
export type PaseoAgent = AgentSnapshotPayload;
export type PaseoAgentHandle = Awaited<
  ReturnType<PaseoApi["agents"]["create"]>
>;
export type PaseoProject = WorkspaceProjectDescriptorPayload;
export type PaseoWorkspace = WorkspaceDescriptorPayload;
