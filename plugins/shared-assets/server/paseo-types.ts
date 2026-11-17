import type {
  WorkspaceDescriptorPayload,
  WorkspaceProjectDescriptorPayload,
} from "@getpaseo/protocol/messages";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

export type PaseoApi = PluginHandlerContext["paseo"];
export type PaseoProject = WorkspaceProjectDescriptorPayload;
export type PaseoWorkspace = WorkspaceDescriptorPayload;
