import { createBoardClient } from "./client.js";
import { runCli, type CliDeps, type CliIO } from "./cli.js";

export async function main(argv: string[]): Promise<number> {
  const io: CliIO = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    isTTY: Boolean(process.stdout.isTTY),
    columns: process.stdout.columns ?? 100,
  };
  const deps: CliDeps = {
    createClient: createBoardClient,
    env: process.env,
  };
  return runCli(argv, io, deps);
}
