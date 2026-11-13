#!/usr/bin/env node

process.stdout.on("error", (error) => {
  if (error && error.code === "EPIPE") process.exit(0);
  throw error;
});

let main;
try {
  ({ main } = await import("../dist/main.js"));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `paseo-board: CLI is not built (${message}). Run "npm run build --workspace @agentstorm/board-cli".`,
  );
  process.exitCode = 1;
}

if (main) {
  process.exitCode = await main(process.argv.slice(2));
}
