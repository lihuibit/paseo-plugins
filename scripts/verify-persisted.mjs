import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { readFile } from "node:fs/promises";
const home = process.env.E2E_PASEO_HOME ?? "/home/ubuntu/.paseo-dev";
const port = process.env.E2E_PASEO_PORT ?? "6767";
const projectId = process.env.E2E_PROJECT_ID ?? "prj_a8ff4ccb22d60287";
const workspaceId = process.env.E2E_WORKSPACE_ID ?? "wks_de5b6f178e4150c4";
const password = (await readFile(`${home}/local-credential`, "utf8")).trim();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  password,
  clientId: "shared-assets-persist",
  reconnect: { enabled: false },
});
await client.connect();
const call = async (method, input = {}) => {
  const envelope = await client.invokePluginRpc(
    "agentstorm-shared-assets",
    method,
    input,
  );
  if (!envelope?.ok) throw new Error(JSON.stringify(envelope));
  return envelope.value;
};
const result = {
  pid: process.pid,
  projects: (await call("shared-assets.projects.list")).find(
    (entry) => entry.projectId === projectId,
  ),
  status: await call("shared-assets.status", { projectId }),
  skills: await call("shared-assets.skills.list", { projectId, workspaceId }),
  instructions: await call("shared-assets.instructions.status", {
    projectId,
    workspaceId,
  }),
  knowledge: await call("shared-assets.assets.read", {
    projectId,
    assetId: "knowledge/deploy.md",
  }),
};
console.log(JSON.stringify(result, null, 2));
await client.close();
