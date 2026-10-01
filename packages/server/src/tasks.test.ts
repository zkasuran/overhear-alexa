// Tasks runtime: create-and-launch writes progress and the final result back through the store, a
// throwing job is stored as a failed result with a spoken message, ttl is capped, and the speculative
// registry cancels on replace and on demand.

import { describe, it, expect } from "vitest";
import {
  MODEL_IMMEDIATE_RESPONSE,
  SpeculativeRegistry,
  cappedTtl,
  createAndLaunch,
} from "./tasks.js";
import type { TaskEnv, TaskWork } from "./tasks.js";
import { TASK_TTL_MAX_MS } from "@overhear/core";
import type { CreateTaskRequestHandlerExtra } from "@modelcontextprotocol/sdk/experimental/tasks";
import type { RequestTaskStore } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, Result, Task } from "@modelcontextprotocol/sdk/types.js";
import type { Logger, Services } from "./contracts.js";

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

function fakeStore(): {
  store: RequestTaskStore;
  results: Map<string, Result>;
  tasks: Map<string, Task>;
} {
  const tasks = new Map<string, Task>();
  const results = new Map<string, Result>();
  let seq = 0;
  const store: RequestTaskStore = {
    async createTask(opts) {
      const taskId = `task_${seq++}`;
      const now = new Date().toISOString();
      const task: Task = {
        taskId,
        status: "working",
        ttl: opts.ttl ?? null,
        createdAt: now,
        lastUpdatedAt: now,
        ...(opts.pollInterval !== undefined ? { pollInterval: opts.pollInterval } : {}),
      };
      tasks.set(taskId, task);
      return task;
    },
    async getTask(taskId) {
      const t = tasks.get(taskId);
      if (t === undefined) throw new Error("task not found");
      return t;
    },
    async storeTaskResult(taskId, status, result) {
      const t = tasks.get(taskId);
      if (t !== undefined) t.status = status;
      results.set(taskId, result);
    },
    async getTaskResult(taskId) {
      const r = results.get(taskId);
      if (r === undefined) throw new Error("no result");
      return r;
    },
    async updateTaskStatus(taskId, status, statusMessage) {
      const t = tasks.get(taskId);
      if (t !== undefined) {
        t.status = status;
        if (statusMessage !== undefined) t.statusMessage = statusMessage;
      }
    },
    async listTasks() {
      return { tasks: [...tasks.values()] };
    },
  };
  return { store, results, tasks };
}

function fakeEnv(): { env: TaskEnv; progress: number[] } {
  const progress: number[] = [];
  const env: TaskEnv = {
    services: {} as unknown as Services,
    log: noopLogger,
    sendProgress: async (_token, value) => {
      progress.push(value);
    },
    notifyResource: async () => {},
    speculative: new SpeculativeRegistry(),
  };
  return { env, progress };
}

function fakeExtra(store: RequestTaskStore, requestedTtl?: number): CreateTaskRequestHandlerExtra {
  return {
    taskStore: store,
    ...(requestedTtl !== undefined ? { taskRequestedTtl: requestedTtl } : {}),
    signal: new AbortController().signal,
    requestId: 1,
    sendNotification: async () => {},
    sendRequest: async () => ({}),
  } as unknown as CreateTaskRequestHandlerExtra;
}

async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for background work");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("createAndLaunch", () => {
  it("returns working at once, runs the work and stores the completed result", async () => {
    const { store, results } = fakeStore();
    const { env, progress } = fakeEnv();
    const work: TaskWork = async ({ progress: report }) => {
      await report(1, 2, "half way");
      return { structuredContent: { done: true }, content: [{ type: "text", text: "done" }] };
    };
    const created = await createAndLaunch(env, fakeExtra(store), "Starting now.", "tok", work);

    expect(created.task.status).toBe("working");
    expect(created.task.pollInterval).toBeGreaterThan(0);
    expect(created._meta?.[MODEL_IMMEDIATE_RESPONSE]).toBe("Starting now.");

    await waitFor(() => results.has(created.task.taskId));
    const result = (await store.getTaskResult(created.task.taskId)) as CallToolResult;
    expect(result.structuredContent?.done).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(progress).toEqual([1]);
  });

  it("stores a failed result with a spoken message when the work throws", async () => {
    const { store, results, tasks } = fakeStore();
    const { env } = fakeEnv();
    const work: TaskWork = async () => {
      throw new Error("I could not reach the voice service.");
    };
    const created = await createAndLaunch(env, fakeExtra(store), "Starting now.", undefined, work);

    await waitFor(() => results.has(created.task.taskId));
    const result = (await store.getTaskResult(created.task.taskId)) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.type === "text" ? result.content[0].text : "").toContain(
      "voice service",
    );
    expect(tasks.get(created.task.taskId)?.status).toBe("failed");
  });
});

describe("cappedTtl", () => {
  it("caps, floors and defaults", () => {
    expect(cappedTtl(undefined)).toBeUndefined();
    expect(cappedTtl(1_000)).toBe(1_000);
    expect(cappedTtl(TASK_TTL_MAX_MS + 1_000_000)).toBe(TASK_TTL_MAX_MS);
    expect(cappedTtl(-5)).toBe(0);
  });
});

describe("SpeculativeRegistry", () => {
  it("cancels on demand, is idempotent and cancels the prior entry on replace", () => {
    const reg = new SpeculativeRegistry();
    let first = 0;
    reg.start("e1", () => (first += 1), 10_000);
    reg.cancel("e1");
    reg.cancel("e1");
    expect(first).toBe(1);

    let a = 0;
    let b = 0;
    reg.start("e2", () => (a += 1), 10_000);
    reg.start("e2", () => (b += 1), 10_000);
    expect(a).toBe(1);
    reg.cancel("e2");
    expect(b).toBe(1);
  });
});
