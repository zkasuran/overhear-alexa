// SPDX-License-Identifier: Apache-2.0
// Property and unit tests for SqliteTaskStore: lifecycle legality, restart, principal scope.

import { expect, test } from "vitest";
import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request as McpRequest, TaskStatus } from "@modelcontextprotocol/sdk/types.js";
import { SqliteTaskStore } from "./taskStore.js";
import { isTerminalStatus } from "../internal/status.js";
import { TASK_TTL_MAX_MS } from "../internal/limits.js";
import type { Scope } from "../scope.js";

const DUMMY_REQUEST: McpRequest = { method: "tools/call", params: { name: "demo", arguments: {} } };

test("createTask starts working, caps a huge ttl, keeps ISO timestamps", async () => {
  const store = new SqliteTaskStore();
  const t = await store.createTask({ ttl: 999_999_999 }, 1, DUMMY_REQUEST);
  expect(t.status).toBe("working");
  expect(t.ttl).toBe(TASK_TTL_MAX_MS);
  expect(Number.isNaN(Date.parse(t.createdAt))).toBe(false);
  expect(Number.isNaN(Date.parse(t.lastUpdatedAt))).toBe(false);
  store.close();
});

test("property: random status interleavings never perform an illegal transition", async () => {
  const statuses: TaskStatus[] = ["working", "input_required", "completed", "failed", "cancelled"];
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom(...statuses), { minLength: 1, maxLength: 30 }),
      async (ops) => {
        const store = new SqliteTaskStore();
        try {
          const t = await store.createTask({ ttl: null }, 1, DUMMY_REQUEST);
          let model: TaskStatus = "working";
          for (const target of ops) {
            if (isTerminalStatus(model)) {
              await expect(store.updateTaskStatus(t.taskId, target)).rejects.toThrow();
            } else {
              await store.updateTaskStatus(t.taskId, target);
              model = target;
            }
            const now = await store.getTask(t.taskId);
            expect(now?.status).toBe(model);
          }
        } finally {
          store.close();
        }
      },
    ),
    { numRuns: 150 },
  );
});

test("a task survives closing and reopening the sqlite file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-task-"));
  const path = join(dir, "tasks.db");
  try {
    const first = new SqliteTaskStore({ path });
    const created = await first.createTask({ ttl: null }, 1, DUMMY_REQUEST);
    await first.updateTaskStatus(created.taskId, "working", "halfway");
    first.close();

    const second = new SqliteTaskStore({ path });
    const reopened = await second.getTask(created.taskId);
    expect(reopened?.status).toBe("working");
    expect(reopened?.statusMessage).toBe("halfway");
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listTasks pages with opaque base64url cursors and rejects a cross-scope cursor", async () => {
  const store = new SqliteTaskStore({ pageSize: 2 });
  const created = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const t = await store.createTask({ ttl: 60_000 }, i, DUMMY_REQUEST, "A");
    created.add(t.taskId);
  }
  const seen = new Set<string>();
  let pages = 0;
  let cursorA: string | undefined;
  let cursor: string | undefined;
  do {
    const page = await store.listTasks(cursor, "A");
    pages += 1;
    for (const t of page.tasks) {
      seen.add(t.taskId);
    }
    if (page.nextCursor !== undefined) {
      expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      cursorA = page.nextCursor;
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  expect(seen.size).toBe(5);
  expect(pages).toBe(3);
  // A cursor minted under principal A must not be honoured under principal B.
  expect(cursorA).toBeDefined();
  await expect(store.listTasks(cursorA, "B")).rejects.toThrow();
  store.close();
});

test("a principal scope lets a reconnect under a new session find its own task", async () => {
  const scope: Scope = async (sid) =>
    sid === "sess-1" || sid === "sess-2" ? "principal-X" : (sid ?? "none");
  const store = new SqliteTaskStore({ scope });
  const t = await store.createTask({ ttl: 60_000 }, 1, DUMMY_REQUEST, "sess-1");
  const samePrincipal = await store.getTask(t.taskId, "sess-2");
  expect(samePrincipal?.taskId).toBe(t.taskId);
  const otherPrincipal = await store.getTask(t.taskId, "sess-other");
  expect(otherPrincipal).toBeNull();
  store.close();
});
