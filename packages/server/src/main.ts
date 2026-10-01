// Runnable entry. Resolves config, builds the services and the durable stores for the run mode, wires
// the MCP server factory into the Hono app and serves it, then shuts down cleanly on a signal. This is
// the one module that composes everything; it reads nothing from the environment itself (config.ts
// owns that) and logs through the structured logger so stdout stays clean.

import { serve } from "@hono/node-server";
import { join } from "node:path";
import {
  SqliteEventStore,
  SqliteTaskMessageQueue,
  SqliteTaskStore,
  DynamoEventStore,
  DynamoTaskMessageQueue,
  DynamoTaskStore,
  createDynamoDocumentClient,
} from "@overhear/durable-stores";
import type { EventStore } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { TaskMessageQueue, TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks";
import { TASK_POLL_INTERVAL_MS, TASK_TTL_MAX_MS } from "@overhear/core";
import { loadConfig, printBanner } from "./config.js";
import { makeLogger } from "./log.js";
import { makeServices } from "./adapters/index.js";
import { createMcpServer } from "./mcp.js";
import { makeSessionRegistry } from "./sessions.js";
import { loadTokenFile, makeAuthVerifier } from "./auth.js";
import { makeQuotaTracker } from "./quota.js";
import { createApp } from "./http.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = makeLogger({ models: config.modelsMode, store: config.storeMode });
  printBanner(config, log);
  if (config.bindPublic) {
    log.warn("binding to a public interface; every request still needs a bearer token", {
      host: config.bind.host,
    });
  }

  const services = makeServices(config, log);
  const sessions = makeSessionRegistry();

  // Durable task stores, bound to the bearer principal through the session registry so a task belongs
  // to its owner rather than the transport session (see SECURITY.md). The event store is built per
  // session (makeEventStore) because the standalone SSE stream carries a fixed id, so one shared store
  // would mix two sessions' streams on replay.
  let taskStore: TaskStore & { close?: () => void };
  let taskMessageQueue: TaskMessageQueue & { close?: () => void };
  let makeEventStore: () => EventStore;
  if (config.storeMode === "aws") {
    const client = createDynamoDocumentClient({ region: config.region });
    const shared = new DynamoEventStore({ client, tableName: config.tables.events });
    taskStore = new DynamoTaskStore({
      client,
      tableName: config.tables.tasks,
      scope: sessions.scope,
      maxTtlMs: TASK_TTL_MAX_MS,
      defaultPollIntervalMs: TASK_POLL_INTERVAL_MS,
    });
    taskMessageQueue = new DynamoTaskMessageQueue({
      client,
      tableName: config.tables.tasks,
      scope: sessions.scope,
    });
    makeEventStore = () => shared;
  } else {
    taskStore = new SqliteTaskStore({
      path: join(config.dataDir, "tasks.sqlite"),
      scope: sessions.scope,
      maxTtlMs: TASK_TTL_MAX_MS,
      defaultPollIntervalMs: TASK_POLL_INTERVAL_MS,
    });
    taskMessageQueue = new SqliteTaskMessageQueue({
      path: join(config.dataDir, "queue.sqlite"),
      scope: sessions.scope,
    });
    makeEventStore = () => new SqliteEventStore({});
  }

  const stores = { taskStore, taskMessageQueue };
  const verifier = makeAuthVerifier(
    loadTokenFile(config.tokenFile, {
      // A committed fixture token is readable by the group in a dev checkout. Permit that only when
      // no real provider is in play; any aws run demands a 600 token file.
      allowInsecurePermissions: config.modelsMode === "mock" && config.storeMode === "local",
      log,
    }),
  );
  const quota = makeQuotaTracker(services.now);

  const app = createApp({
    config,
    log,
    sessions,
    verifier,
    quota,
    createServer: () => createMcpServer(services, stores, log),
    makeEventStore,
  });

  const server = serve(
    { fetch: app.fetch, hostname: config.bind.host, port: config.bind.port },
    (info) => log.info(`serving on http://${config.bind.host}:${info.port}/mcp`),
  );
  // Local dev hint, printed once. The token itself never reaches a log (see SECURITY.md).
  log.info("bearer token file for local dev", { tokenFile: config.tokenFile });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info("shutting down", { signal });
    server.close();
    await sessions.closeAll();
    await services.episodes.close().catch(() => undefined);
    taskStore.close?.();
    taskMessageQueue.close?.();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  makeLogger().error("fatal: server failed to start", { error: message });
  process.exit(1);
});
