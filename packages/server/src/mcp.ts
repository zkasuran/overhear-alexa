// The MCP server definition: it builds the McpServer, wires the durable task store and message queue,
// registers the seven tools, the resources and the prompts, attaches per-tool icons through a low-level
// tools/list override (the high-level API does not serialize icons), and returns a server ready for the
// HTTP layer to connect to a transport. The HTTP layer owns the transport and the event store and calls
// this factory per session (the stores are shared and bind each task to the caller through their scope
// resolver). See SECURITY.md for the owner-scoping and bounded-work rules the tools enforce.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  Icon,
  ListToolsRequest,
  ListToolsResult,
  ProgressToken,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { TaskMessageQueue, TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks";
import type { EventStore } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { TASK_POLL_INTERVAL_MS } from "@overhear/core";
import type { Logger, Services } from "./contracts.js";
import { ResourceSubscriptions, registerResources, touchEpisodeResources } from "./resources.js";
import { SpeculativeRegistry } from "./tasks.js";
import type { TaskEnv } from "./tasks.js";
import { registerPrompts } from "./prompts.js";
import { registerPlanEpisode } from "./tools/planEpisode.js";
import { registerGetEpisode } from "./tools/getEpisode.js";
import { registerFindMoment } from "./tools/findMoment.js";
import { registerRenderEpisode } from "./tools/renderEpisode.js";
import { registerExpandPart } from "./tools/expandPart.js";
import { registerRecap } from "./tools/recap.js";
import { registerAsk } from "./tools/ask.js";

/**
 * The task stores the HTTP layer constructs once and hands to this factory per session. Only the task
 * store and the message queue reach the McpServer; the event store is a per-session transport concern
 * (the standalone SSE stream carries a fixed id, so one shared event store would mix two sessions on
 * replay), so it is created by the HTTP layer and attached to the transport, not passed here.
 */
export interface McpStores {
  taskStore: TaskStore;
  taskMessageQueue: TaskMessageQueue;
  eventStore?: EventStore;
}

const SERVER_INFO = { name: "overhear", version: "1.0.0", title: "Overhear" } as const;

const INSTRUCTIONS =
  "Overhear turns a topic, link or text into a two-host audio episode you steer by voice. Call plan_episode to get an outline, render_episode to produce the audio, find_moment to jump around, expand_part to go deeper, and recap or ask while listening.";

/** Load the SVG icons as data URIs, keyed by file name. Best effort: missing assets just mean no icon. */
function loadIcons(log: Logger): Map<string, Icon[]> {
  const icons = new Map<string, Icon[]>();
  let dir: string;
  let files: string[];
  try {
    dir = fileURLToPath(new URL("../../../docs/assets/icons/", import.meta.url));
    files = readdirSync(dir).filter((name) => name.endsWith(".svg"));
  } catch {
    log.warn("icon assets not found; tools and resources will have no icons");
    return icons;
  }
  for (const file of files) {
    try {
      const svg = readFileSync(join(dir, file));
      const src = `data:image/svg+xml;base64,${svg.toString("base64")}`;
      icons.set(file.slice(0, -4), [{ src, mimeType: "image/svg+xml", sizes: ["any"] }]);
    } catch {
      log.warn("icon read failed", { file });
    }
  }
  return icons;
}

type ListToolsHandler = (
  request: ListToolsRequest,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => Promise<ListToolsResult>;

/**
 * Attach per-tool icons by wrapping the tools/list handler the SDK installed. The high-level API never
 * serializes icons (SEP-973), so we merge an icon descriptor per tool from the static map. If the SDK
 * handler cannot be read, tools/list is left exactly as the SDK built it (valid, icons omitted).
 */
function applyIconOverride(
  server: McpServer,
  icons: ReadonlyMap<string, Icon[]>,
  log: Logger,
): void {
  if (icons.size === 0) return;
  const low = server.server;
  const registry = (low as unknown as { _requestHandlers?: Map<string, ListToolsHandler> })
    ._requestHandlers;
  const original = registry?.get("tools/list");
  if (original === undefined) {
    log.warn("tools/list handler not available; tool icons not attached");
    return;
  }
  low.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const base = await original(request, extra);
    const tools = base.tools.map((tool) => {
      const ic = icons.get(tool.name);
      return ic ? { ...tool, icons: ic } : tool;
    });
    return { ...base, tools };
  });
}

/**
 * Build the Overhear MCP server. The returned server is ready to connect to a transport. The task store
 * and message queue are wired into the server options so the SDK serves tasks/get, tasks/result,
 * tasks/list and tasks/cancel; the event store travels to the transport, which the HTTP layer owns.
 */
export function createMcpServer(services: Services, stores: McpStores, log: Logger): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: INSTRUCTIONS,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: true, listChanged: false },
      prompts: { listChanged: false },
      logging: {},
      tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
    },
    taskStore: stores.taskStore,
    taskMessageQueue: stores.taskMessageQueue,
    defaultTaskPollInterval: TASK_POLL_INTERVAL_MS,
  });

  const subscriptions = new ResourceSubscriptions();
  const icons = loadIcons(log);

  const sendProgress = async (
    token: ProgressToken,
    progress: number,
    total: number,
    message: string,
  ): Promise<void> => {
    try {
      await server.server.notification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      });
    } catch {
      log.warn("progress notification failed");
    }
  };

  const env: TaskEnv = {
    services,
    log,
    sendProgress,
    notifyResource: (episodeId) => touchEpisodeResources(server, subscriptions, episodeId, log),
    speculative: new SpeculativeRegistry(),
  };

  registerPlanEpisode(server, env);
  registerGetEpisode(server, services);
  registerFindMoment(server, services);
  registerRenderEpisode(server, env);
  registerExpandPart(server, env);
  registerRecap(server, env);
  registerAsk(server, env);

  registerResources(server, services, subscriptions, icons, log);
  registerPrompts(server, log);
  applyIconOverride(server, icons, log);

  log.info("mcp server built", { tools: 7, store: services.config.storeMode });
  return server;
}
