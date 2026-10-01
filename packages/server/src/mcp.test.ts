// createMcpServer builds a server that constructs cleanly and, over an in-memory transport, advertises
// the seven tools with the right task support and icons, the four prompts, the resource templates, and
// serves the formats resource. Owner-scoped tool calls are covered by the per-tool core tests, since the
// in-memory transport carries no bearer principal.

import { afterAll, describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  SqliteEventStore,
  SqliteTaskMessageQueue,
  SqliteTaskStore,
} from "@overhear/durable-stores";
import { createMcpServer } from "./mcp.js";
import type { McpStores } from "./mcp.js";
import type { Logger, Services } from "./contracts.js";

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

const services = { config: { storeMode: "local" } } as unknown as Services;

function makeStores(): McpStores & { close: () => void } {
  const taskStore = new SqliteTaskStore({ path: ":memory:" });
  const eventStore = new SqliteEventStore({ path: ":memory:" });
  const taskMessageQueue = new SqliteTaskMessageQueue({ path: ":memory:" });
  return {
    taskStore,
    taskMessageQueue,
    eventStore,
    close: () => {
      taskStore.close();
      eventStore.close();
      taskMessageQueue.close();
    },
  };
}

const openStores: Array<{ close: () => void }> = [];
afterAll(() => {
  for (const s of openStores) s.close();
});

describe("createMcpServer", () => {
  it("constructs without throwing", () => {
    const stores = makeStores();
    openStores.push(stores);
    const server = createMcpServer(services, stores, noopLogger);
    expect(server).toBeInstanceOf(McpServer);
    expect(server.server).toBeDefined();
  });

  it("advertises the full surface over an in-memory transport", async () => {
    const stores = makeStores();
    openStores.push(stores);
    const server = createMcpServer(services, stores, noopLogger);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "ask",
      "expand_part",
      "find_moment",
      "get_episode",
      "plan_episode",
      "recap",
      "render_episode",
    ]);

    const byName = new Map(tools.tools.map((t) => [t.name, t]));
    expect(byName.get("plan_episode")?.execution?.taskSupport).toBe("forbidden");
    expect(byName.get("get_episode")?.execution?.taskSupport).toBe("forbidden");
    expect(byName.get("find_moment")?.execution?.taskSupport).toBe("forbidden");
    expect(byName.get("render_episode")?.execution?.taskSupport).toBe("required");
    expect(byName.get("expand_part")?.execution?.taskSupport).toBe("required");
    expect(byName.get("recap")?.execution?.taskSupport).toBe("optional");
    expect(byName.get("ask")?.execution?.taskSupport).toBe("optional");

    // Icons are attached through the tools/list override.
    expect((byName.get("plan_episode")?.icons ?? []).length).toBeGreaterThan(0);
    expect((byName.get("render_episode")?.icons ?? []).length).toBeGreaterThan(0);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual([
      "brief_me",
      "debate_it",
      "hype_it",
      "wind_down",
    ]);

    const templates = await client.listResourceTemplates();
    const templateUris = templates.resourceTemplates.map((t) => t.uriTemplate);
    expect(templateUris).toContain("overhear://episodes/{id}/manifest");
    expect(templateUris).toContain("overhear://episodes/{id}/transcript");
    expect(templateUris).toContain("overhear://episodes/{id}/source");

    const formats = await client.readResource({ uri: "overhear://formats" });
    const first = formats.contents[0];
    const text = first !== undefined && "text" in first ? first.text : "{}";
    const parsed = JSON.parse(text) as { formats: unknown[] };
    expect(parsed.formats).toHaveLength(4);

    // Subscribing to a manifest is accepted (the low-level handler is registered).
    await expect(
      client.subscribeResource({ uri: "overhear://episodes/ep_demo/manifest" }),
    ).resolves.toBeDefined();

    await client.close();
    await server.close();
  });
});
