// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. A portable conformance suite any store can run on itself.

import { performance } from "node:perf_hooks";
import type { EventStore } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type {
  QueuedMessage,
  TaskMessageQueue,
  TaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks";
import type { JSONRPCMessage, Request as McpRequest } from "@modelcontextprotocol/sdk/types.js";

/** The three stores under test, built fresh for each check. */
export interface Stores {
  event: EventStore;
  task: TaskStore;
  queue: TaskMessageQueue;
}

/** Produces a fresh, empty set of stores. Called once per check so state never leaks. */
export type StoresFactory = () => Stores | Promise<Stores>;

/** The result of one named check. */
export interface ConformanceCheckResult {
  name: string;
  group: "event" | "task" | "queue" | "isolation";
  passed: boolean;
  durationMs: number;
  error?: string;
}

/** The result of a whole run. */
export interface ConformanceReport {
  results: ConformanceCheckResult[];
  passed: number;
  failed: number;
  ok: boolean;
}

/** Options for a run. */
export interface RunConformanceOptions {
  /** Run the principal-isolation checks. Needs a store that honours the scope resolver. Default true. */
  isolation?: boolean;
  /** Throw with a summary when any check fails, instead of only reporting. Default false. */
  throwOnFailure?: boolean;
}

interface Check {
  name: string;
  group: ConformanceCheckResult["group"];
  run: (stores: Stores) => Promise<void>;
}

/** Throws a labelled error unless the condition holds. */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

/** Throws unless two scalars are identical. */
export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

/** Throws unless two values serialize to the same JSON. */
export function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: values differ`);
  }
}

/** Throws unless the given async function rejects. */
export async function assertRejects(fn: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(`expected a rejection: ${message}`);
}

/** True when a string parses as an ISO 8601 date-time. */
export function isIso8601(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && /\dT\d/.test(value);
}

const DUMMY_REQUEST: McpRequest = { method: "tools/call", params: { name: "demo", arguments: {} } };

function notification(method: string): JSONRPCMessage {
  return { jsonrpc: "2.0", method };
}

function queued(method: string): QueuedMessage {
  return { type: "notification", timestamp: Date.now(), message: { jsonrpc: "2.0", method } };
}

function qMethod(message: QueuedMessage | undefined): string | undefined {
  if (message === undefined) {
    return undefined;
  }
  const inner = message.message;
  return "method" in inner ? inner.method : undefined;
}

function closeStores(stores: Stores): void {
  for (const store of [stores.event, stores.task, stores.queue]) {
    const maybe = store as unknown as { close?: () => void };
    if (typeof maybe.close === "function") {
      maybe.close();
    }
  }
}

const eventChecks: Check[] = [
  {
    name: "event: storeEvent returns an id and getStreamIdForEventId round-trips",
    group: "event",
    run: async ({ event }) => {
      const id = await event.storeEvent("stream-a", notification("notifications/progress"));
      assert(typeof id === "string" && id.length > 0, "event id is a non-empty string");
      const mapped = await event.getStreamIdForEventId?.(id);
      assertEqual(mapped, "stream-a", "event id maps back to its stream");
    },
  },
  {
    name: "event: getStreamIdForEventId handles the standalone _GET_stream id",
    group: "event",
    run: async ({ event }) => {
      const id = await event.storeEvent("_GET_stream", notification("notifications/message"));
      const mapped = await event.getStreamIdForEventId?.(id);
      assertEqual(mapped, "_GET_stream", "the leading-underscore stream maps back correctly");
    },
  },
  {
    name: "event: replay returns only later events of the same stream in order",
    group: "event",
    run: async ({ event }) => {
      const first = await event.storeEvent("stream-a", notification("a1"));
      await event.storeEvent("stream-a", notification("a2"));
      await event.storeEvent("stream-a", notification("a3"));
      const replayed: string[] = [];
      const streamId = await event.replayEventsAfter(first, {
        send: async (_id, message) => {
          replayed.push(JSON.stringify(message));
        },
      });
      assertEqual(streamId, "stream-a", "replay returns the anchor stream id");
      assertEqual(replayed.length, 2, "replay returns exactly the two later events");
      assertDeepEqual(
        replayed,
        [JSON.stringify(notification("a2")), JSON.stringify(notification("a3"))],
        "replay is in order",
      );
    },
  },
  {
    name: "event: replay excludes other streams and never duplicates",
    group: "event",
    run: async ({ event }) => {
      const a1 = await event.storeEvent("stream-a", notification("a1"));
      await event.storeEvent("stream-b", notification("b1"));
      await event.storeEvent("stream-a", notification("a2"));
      await event.storeEvent("stream-b", notification("b2"));
      const ids: string[] = [];
      await event.replayEventsAfter(a1, {
        send: async (id) => {
          ids.push(id);
        },
      });
      assertEqual(ids.length, 1, "only the one later event of stream-a is replayed");
      assertEqual(new Set(ids).size, ids.length, "no event id is replayed twice");
    },
  },
  {
    name: "event: replay after an unknown id returns no events",
    group: "event",
    run: async ({ event }) => {
      let sent = 0;
      await event.replayEventsAfter("no-such-event", {
        send: async () => {
          sent += 1;
        },
      });
      assertEqual(sent, 0, "an unknown anchor replays nothing");
    },
  },
];

const taskChecks: Check[] = [
  {
    name: "task: createTask starts working with ISO timestamps",
    group: "task",
    run: async ({ task }) => {
      const created = await task.createTask({ ttl: 60_000 }, 1, DUMMY_REQUEST);
      assertEqual(created.status, "working", "a new task is working");
      assert(typeof created.taskId === "string" && created.taskId.length > 0, "task id present");
      assert(isIso8601(created.createdAt), "createdAt is ISO 8601");
      assert(isIso8601(created.lastUpdatedAt), "lastUpdatedAt is ISO 8601");
    },
  },
  {
    name: "task: ttl is capped and null stays null",
    group: "task",
    run: async ({ task }) => {
      const capped = await task.createTask({ ttl: 999_999_999 }, 1, DUMMY_REQUEST);
      assert(capped.ttl !== null && capped.ttl < 999_999_999, "a huge ttl is capped down");
      const unlimited = await task.createTask({ ttl: null }, 2, DUMMY_REQUEST);
      assertEqual(unlimited.ttl, null, "a null ttl stays unlimited");
    },
  },
  {
    name: "task: getTask returns null for an unknown id",
    group: "task",
    run: async ({ task }) => {
      assertEqual(await task.getTask("missing"), null, "unknown task is null");
    },
  },
  {
    name: "task: legal lifecycle working to input_required to working to completed",
    group: "task",
    run: async ({ task }) => {
      const t = await task.createTask({ ttl: 60_000 }, 1, DUMMY_REQUEST);
      await task.updateTaskStatus(t.taskId, "input_required", "need input");
      await task.updateTaskStatus(t.taskId, "working");
      await task.storeTaskResult(t.taskId, "completed", {
        content: [{ type: "text", text: "done" }],
      });
      const final = await task.getTask(t.taskId);
      assertEqual(final?.status, "completed", "the task ends completed");
    },
  },
  {
    name: "task: terminal status is immutable",
    group: "task",
    run: async ({ task }) => {
      const t = await task.createTask({ ttl: 60_000 }, 1, DUMMY_REQUEST);
      await task.storeTaskResult(t.taskId, "completed", { content: [] });
      await assertRejects(
        () => task.updateTaskStatus(t.taskId, "working"),
        "cannot leave a terminal status",
      );
    },
  },
  {
    name: "task: storeTaskResult twice is rejected",
    group: "task",
    run: async ({ task }) => {
      const t = await task.createTask({ ttl: 60_000 }, 1, DUMMY_REQUEST);
      await task.storeTaskResult(t.taskId, "completed", { content: [] });
      await assertRejects(
        () => task.storeTaskResult(t.taskId, "failed", { content: [] }),
        "cannot store a result twice",
      );
    },
  },
  {
    name: "task: cancelled stays cancelled",
    group: "task",
    run: async ({ task }) => {
      const t = await task.createTask({ ttl: 60_000 }, 1, DUMMY_REQUEST);
      await task.updateTaskStatus(t.taskId, "cancelled");
      await assertRejects(
        () => task.updateTaskStatus(t.taskId, "working"),
        "cancelled is terminal",
      );
      assertEqual((await task.getTask(t.taskId))?.status, "cancelled", "it is still cancelled");
    },
  },
  {
    name: "task: storeTaskResult then getTaskResult round-trips",
    group: "task",
    run: async ({ task }) => {
      const t = await task.createTask({ ttl: 60_000 }, 1, DUMMY_REQUEST);
      const result = { content: [{ type: "text", text: "payload" }], structuredContent: { n: 7 } };
      await task.storeTaskResult(t.taskId, "completed", result);
      assertDeepEqual(
        await task.getTaskResult(t.taskId),
        result,
        "the stored result comes back intact",
      );
    },
  },
  {
    name: "task: getTaskResult before a result throws",
    group: "task",
    run: async ({ task }) => {
      const t = await task.createTask({ ttl: 60_000 }, 1, DUMMY_REQUEST);
      await assertRejects(() => task.getTaskResult(t.taskId), "no result yet");
    },
  },
  {
    name: "task: listTasks pages every task exactly once",
    group: "task",
    run: async ({ task }) => {
      const created = new Set<string>();
      for (let i = 0; i < 7; i++) {
        const t = await task.createTask({ ttl: 60_000 }, i, DUMMY_REQUEST);
        created.add(t.taskId);
      }
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await task.listTasks(cursor);
        for (const t of page.tasks) {
          assert(!seen.has(t.taskId), "a task is listed only once");
          seen.add(t.taskId);
        }
        if (page.nextCursor !== undefined) {
          assert(
            typeof page.nextCursor === "string" && page.nextCursor.length > 0,
            "cursor is a non-empty string",
          );
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      assertEqual(seen.size, created.size, "every created task is listed");
    },
  },
];

const queueChecks: Check[] = [
  {
    name: "queue: enqueue then dequeue is FIFO",
    group: "queue",
    run: async ({ queue }) => {
      await queue.enqueue("task-1", queued("m1"));
      await queue.enqueue("task-1", queued("m2"));
      const first = await queue.dequeue("task-1");
      const second = await queue.dequeue("task-1");
      assertEqual(qMethod(first), "m1", "the first message out is the first in");
      assertEqual(qMethod(second), "m2", "the second message out is the second in");
    },
  },
  {
    name: "queue: dequeueAll drains in order",
    group: "queue",
    run: async ({ queue }) => {
      await queue.enqueue("task-1", queued("m1"));
      await queue.enqueue("task-1", queued("m2"));
      const all = await queue.dequeueAll("task-1");
      assertEqual(all.length, 2, "dequeueAll returns both messages");
      assertEqual(qMethod(all[0]), "m1", "dequeueAll preserves order");
      assertEqual(
        (await queue.dequeue("task-1")) ?? undefined,
        undefined,
        "the queue is empty after a drain",
      );
    },
  },
  {
    name: "queue: dequeue on an empty queue returns undefined",
    group: "queue",
    run: async ({ queue }) => {
      assertEqual(
        (await queue.dequeue("empty")) ?? undefined,
        undefined,
        "empty dequeue is undefined",
      );
    },
  },
  {
    name: "queue: enqueue past maxSize throws",
    group: "queue",
    run: async ({ queue }) => {
      await queue.enqueue("task-1", queued("m1"), undefined, 2);
      await queue.enqueue("task-1", queued("m2"), undefined, 2);
      await assertRejects(
        () => queue.enqueue("task-1", queued("m3"), undefined, 2),
        "a full queue rejects",
      );
    },
  },
];

const isolationChecks: Check[] = [
  {
    name: "isolation: a task under principal A is invisible to principal B",
    group: "isolation",
    run: async ({ task }) => {
      const a = await task.createTask({ ttl: 60_000 }, 1, DUMMY_REQUEST, "principal-A");
      assertEqual(await task.getTask(a.taskId, "principal-B"), null, "B cannot read A's task");
      await assertRejects(
        () => task.getTaskResult(a.taskId, "principal-B"),
        "B cannot read A's result",
      );
      await assertRejects(
        () => task.updateTaskStatus(a.taskId, "cancelled", undefined, "principal-B"),
        "B cannot cancel A's task",
      );
    },
  },
  {
    name: "isolation: listTasks under B excludes A's tasks",
    group: "isolation",
    run: async ({ task }) => {
      const a = await task.createTask({ ttl: 60_000 }, 1, DUMMY_REQUEST, "principal-A");
      const page = await task.listTasks(undefined, "principal-B");
      assert(!page.tasks.some((t) => t.taskId === a.taskId), "B's list excludes A's task");
    },
  },
  {
    name: "isolation: a queue under A is not drained by B",
    group: "isolation",
    run: async ({ queue }) => {
      await queue.enqueue("shared-task", queued("secret"), "principal-A");
      assertEqual(
        (await queue.dequeue("shared-task", "principal-B")) ?? undefined,
        undefined,
        "B gets nothing",
      );
      const back = await queue.dequeue("shared-task", "principal-A");
      assertEqual(qMethod(back), "secret", "A still has its message");
    },
  },
];

/** The full ordered list of checks for a run. */
export function conformanceChecks(options: RunConformanceOptions = {}): Check[] {
  const isolation = options.isolation ?? true;
  return [...eventChecks, ...taskChecks, ...queueChecks, ...(isolation ? isolationChecks : [])];
}

/**
 * Runs the conformance suite against the stores produced by makeStores. Fresh
 * stores are built for every check, so no state leaks between checks. Returns a
 * report and throws a summary when throwOnFailure is set and any check fails.
 */
export async function runStoreConformance(
  makeStores: StoresFactory,
  options: RunConformanceOptions = {},
): Promise<ConformanceReport> {
  const results: ConformanceCheckResult[] = [];
  for (const check of conformanceChecks(options)) {
    const started = performance.now();
    let stores: Stores | undefined;
    let error: string | undefined;
    try {
      stores = await makeStores();
      await check.run(stores);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (stores !== undefined) {
        closeStores(stores);
      }
    }
    const durationMs = performance.now() - started;
    results.push({
      name: check.name,
      group: check.group,
      passed: error === undefined,
      durationMs,
      ...(error === undefined ? {} : { error }),
    });
  }
  const failed = results.filter((r) => !r.passed).length;
  const report: ConformanceReport = {
    results,
    passed: results.length - failed,
    failed,
    ok: failed === 0,
  };
  if ((options.throwOnFailure ?? false) && failed > 0) {
    const lines = results
      .filter((r) => !r.passed)
      .map((r) => `  ${r.name}: ${r.error ?? "failed"}`)
      .join("\n");
    throw new Error(`store conformance failed (${failed}/${results.length}):\n${lines}`);
  }
  return report;
}
