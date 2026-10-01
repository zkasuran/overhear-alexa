// Entry point. Loads config, connects the MCP client to the episode server, reads the run mode, then
// starts the WebSocket and media surfaces. This is the only module allowed to log through the console
// directly (via the logger it constructs) and to read the process environment (via loadConfig).

import { loadConfig, bannerLines } from "./config.js";
import { consoleLogger } from "./log.js";
import { OverhearClient } from "./mcp-client.js";
import { fetchRunMode, startServer } from "./server.js";

async function main(): Promise<void> {
  const log = consoleLogger();
  const config = loadConfig();
  for (const line of bannerLines(config)) log.info(line);

  const client = new OverhearClient(config.serverUrl, config.token, log);
  await client.connect();
  const mode = await fetchRunMode(config.serverOrigin, log);
  log.info("run mode", mode);

  const server = await startServer(client, config, log, mode);

  const shutdown = (): void => {
    log.info("shutting down");
    void server.close().then(() => client.close());
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  consoleLogger().error("fatal", { error: String(err) });
  process.exitCode = 1;
});
