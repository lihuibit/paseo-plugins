#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const home = process.env.PASEO_RELEASE_HOME ?? join(homedir(), ".paseo-plugin-test");
const port = process.env.PASEO_RELEASE_PORT ?? "6769";
const password = (await readFile(join(home, "local-credential"), "utf8")).trim();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  password,
  clientId: `task-board-health-${process.pid}`,
  reconnect: { enabled: false },
});

await client.connect();
try {
  const envelope = await client.invokePluginRpc(
    "agentstorm-task-board",
    "task-board.health",
    {},
  );
  if (!envelope?.ok) throw new Error(JSON.stringify(envelope));
  console.log(JSON.stringify(envelope.value, null, 2));
} finally {
  await client.close();
}
