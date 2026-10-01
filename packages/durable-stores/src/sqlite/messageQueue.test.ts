// SPDX-License-Identifier: Apache-2.0
// Property and unit tests for SqliteTaskMessageQueue: FIFO, ceilings, isolation, restart.

import { expect, test } from "vitest";
import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueuedMessage } from "@modelcontextprotocol/sdk/experimental/tasks";
import { SqliteTaskMessageQueue } from "./messageQueue.js";

const queued = (method: string): QueuedMessage => ({
  type: "notification",
  timestamp: Date.now(),
  message: { jsonrpc: "2.0", method },
});

const methodOf = (message: QueuedMessage | undefined): string | undefined =>
  message !== undefined && "method" in message.message ? message.message.method : undefined;

test("enqueue then dequeue is FIFO and empties to undefined", async () => {
  const q = new SqliteTaskMessageQueue();
  await q.enqueue("t1", queued("a"));
  await q.enqueue("t1", queued("b"));
  expect(methodOf(await q.dequeue("t1"))).toBe("a");
  expect(methodOf(await q.dequeue("t1"))).toBe("b");
  expect(await q.dequeue("t1")).toBeUndefined();
  q.close();
});

test("enqueue past maxSize throws", async () => {
  const q = new SqliteTaskMessageQueue();
  await q.enqueue("t1", queued("a"), undefined, 2);
  await q.enqueue("t1", queued("b"), undefined, 2);
  await expect(q.enqueue("t1", queued("c"), undefined, 2)).rejects.toThrow();
  q.close();
});

test("a queue is scoped by principal", async () => {
  const q = new SqliteTaskMessageQueue();
  await q.enqueue("shared", queued("secret"), "principal-A");
  expect(await q.dequeue("shared", "principal-B")).toBeUndefined();
  expect(methodOf(await q.dequeue("shared", "principal-A"))).toBe("secret");
  q.close();
});

test("queued messages survive closing and reopening the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-queue-"));
  const path = join(dir, "queue.db");
  try {
    const first = new SqliteTaskMessageQueue({ path });
    await first.enqueue("t1", queued("persisted"));
    first.close();
    const second = new SqliteTaskMessageQueue({ path });
    expect(methodOf(await second.dequeue("t1"))).toBe("persisted");
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("property: dequeueAll returns every enqueued message once, in order", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 0, maxLength: 30 }),
      async (methods) => {
        const q = new SqliteTaskMessageQueue();
        try {
          for (const method of methods) {
            await q.enqueue("t1", queued(method));
          }
          const drained = await q.dequeueAll("t1");
          expect(drained.map((m) => methodOf(m))).toEqual(methods);
          expect(await q.dequeue("t1")).toBeUndefined();
        } finally {
          q.close();
        }
      },
    ),
    { numRuns: 60 },
  );
});
