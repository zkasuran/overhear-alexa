// Tasks runtime. The SDK does not run background work: a task tool's createTask persists a task record,
// kicks the work off without awaiting it, and returns a CreateTaskResult now. This module holds the one
// create-and-launch path every task tool uses, the speculative-render registry plan_episode uses, and
// the ttl cap. Progress and the final result are written back through the request-scoped task store, so
// a client that polls tasks/get and tasks/result sees them; the progress notification is best effort
// because the stream that carried the create response has already closed (see SECURITY.md for the
// bounded-work rules the tools enforce before launching).

import type {
  CreateTaskRequestHandlerExtra,
  CreateTaskOptions,
} from "@modelcontextprotocol/sdk/experimental/tasks";
import type { RequestTaskStore } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  CreateTaskResult,
  ProgressToken,
} from "@modelcontextprotocol/sdk/types.js";
import { TASK_POLL_INTERVAL_MS, TASK_TTL_MAX_MS } from "@overhear/core";
import type { Logger, Services } from "./contracts.js";
import { speakableError, textBlock } from "./tools/common.js";

/** The SDK neither defines nor reads this key; we set it so a voice client has a line to speak at once. */
export const MODEL_IMMEDIATE_RESPONSE = "io.modelcontextprotocol/model-immediate-response";

/** How long a speculative part-0 render is allowed to sit before it is cancelled if no render follows. */
export const SPECULATIVE_RENDER_TTL_MS = 120_000;

/** Emit a progress notification for a running task. Best effort: the create stream is already closed. */
export type SendProgress = (
  token: ProgressToken,
  progress: number,
  total: number,
  message: string,
) => Promise<void>;

/** The background work of a task. Returns the final CallToolResult; throwing marks the task failed. */
export type TaskWork = (ctx: {
  taskId: string;
  store: RequestTaskStore;
  progress: (progress: number, total: number, message: string) => Promise<void>;
}) => Promise<CallToolResult>;

/** Shared dependencies the task tools close over. Decoupled from the McpServer so it is unit-testable. */
export interface TaskEnv {
  services: Services;
  log: Logger;
  sendProgress: SendProgress;
  notifyResource: (episodeId: string) => Promise<void>;
  speculative: SpeculativeRegistry;
}

/** Cap a client-requested ttl at the ceiling. Returns undefined to let the store pick its default. */
export function cappedTtl(requested: number | undefined): number | undefined {
  if (requested === undefined || !Number.isFinite(requested)) return undefined;
  return Math.min(Math.max(0, Math.floor(requested)), TASK_TTL_MAX_MS);
}

/**
 * Create a task, launch the work without awaiting it, and return the CreateTaskResult. The work writes
 * its result (or a spoken failure) back through the request-scoped store. updateTaskStatus is driven on
 * each progress tick so a tasks/status notification fires; a send failure after the stream closed is
 * swallowed because the state was already persisted.
 */
export async function createAndLaunch(
  env: TaskEnv,
  extra: CreateTaskRequestHandlerExtra,
  immediate: string,
  progressToken: ProgressToken | undefined,
  work: TaskWork,
): Promise<CreateTaskResult> {
  const store = extra.taskStore;
  const ttl = cappedTtl(extra.taskRequestedTtl);
  const options: CreateTaskOptions = { pollInterval: TASK_POLL_INTERVAL_MS };
  if (ttl !== undefined) options.ttl = ttl;
  const task = await store.createTask(options);

  const progress = async (value: number, total: number, message: string): Promise<void> => {
    try {
      await store.updateTaskStatus(task.taskId, "working", message);
    } catch {
      env.log.warn("task status update failed", { taskId: task.taskId });
    }
    if (progressToken !== undefined) {
      await env.sendProgress(progressToken, value, total, message);
    }
  };

  void (async () => {
    try {
      const result = await work({ taskId: task.taskId, store, progress });
      await store.storeTaskResult(task.taskId, "completed", result);
    } catch (err) {
      const message = speakableError(err);
      env.log.error("task work failed", { taskId: task.taskId, error: message });
      try {
        await store.storeTaskResult(task.taskId, "failed", {
          content: [textBlock(message)],
          isError: true,
        });
      } catch {
        env.log.warn("storing failed task result failed", { taskId: task.taskId });
      }
    }
  })();

  return { task, _meta: { [MODEL_IMMEDIATE_RESPONSE]: immediate } };
}

interface SpeculativeHandle {
  cancel: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Tracks the speculative part-0 render plan_episode starts. A render_episode cancels the matching entry
 * before it begins; otherwise a timer cancels it after SPECULATIVE_RENDER_TTL_MS so a plan that is never
 * rendered does not keep voicing in the background.
 */
export class SpeculativeRegistry {
  readonly #handles = new Map<string, SpeculativeHandle>();

  start(episodeId: string, cancel: () => void, ttlMs: number = SPECULATIVE_RENDER_TTL_MS): void {
    this.cancel(episodeId);
    const timer = setTimeout(() => {
      this.#handles.delete(episodeId);
      cancel();
    }, ttlMs);
    if (typeof timer.unref === "function") timer.unref();
    this.#handles.set(episodeId, { cancel, timer });
  }

  cancel(episodeId: string): void {
    const handle = this.#handles.get(episodeId);
    if (handle === undefined) return;
    clearTimeout(handle.timer);
    this.#handles.delete(episodeId);
    handle.cancel();
  }
}
