// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. A durable, principal-scoped TaskStore on node:sqlite.

import type { DatabaseSync } from "node:sqlite";
import type { CreateTaskOptions, TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks";
import type {
  Request as McpRequest,
  RequestId,
  Result,
  Task,
  TaskStatus,
} from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../logger.js";
import type { Scope } from "../scope.js";
import { silentLogger } from "../logger.js";
import { identityScope } from "../scope.js";
import {
  DEFAULT_LIST_PAGE_SIZE,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TASK_TTL_MS,
  MAX_LIST_PAGE_SIZE,
  MAX_PAYLOAD_BYTES,
  TASK_TTL_MAX_MS,
} from "../internal/limits.js";
import { asTaskStatus, isLegalTransition, isTerminalStatus } from "../internal/status.js";
import { newTaskId } from "../internal/ids.js";
import { capTtl } from "../internal/ttl.js";
import { decodeCursor, encodeCursor } from "../internal/cursor.js";
import { parseJson, serializeWithinLimit } from "../internal/json.js";
import { IllegalTransitionError, NoTaskResultError, TaskNotFoundError } from "../errors.js";
import { openDatabase, optNumber, optString, reqNumber, reqString, type SqlRow } from "./db.js";

export interface SqliteTaskStoreOptions {
  /** File path for a durable store or ":memory:" (the default) for an ephemeral one. */
  path?: string;
  /** Resolver from session id to principal. Defaults to identity (the session id). */
  scope?: Scope;
  /** Optional logger. Silent by default. */
  logger?: Logger;
  /** Largest ttl a task may keep, in ms. A larger request is capped. */
  maxTtlMs?: number;
  /** ttl applied when a task requests none. */
  defaultTtlMs?: number;
  /** Poll interval suggested when a task sets none. */
  defaultPollIntervalMs?: number;
  /** listTasks page size. */
  pageSize?: number;
  /** Byte ceiling on a stored result or request. */
  maxResultBytes?: number;
}

/**
 * TaskStore backed by SQLite. Unlike the SDK InMemory store it survives a restart,
 * scopes every row by a resolved principal so one principal cannot see another's
 * tasks, enforces the status lifecycle, caps ttl and pages with opaque cursors.
 */
export class SqliteTaskStore implements TaskStore {
  readonly #db: DatabaseSync;
  readonly #scope: Scope;
  readonly #logger: Logger;
  readonly #maxTtlMs: number;
  readonly #defaultTtlMs: number;
  readonly #defaultPollIntervalMs: number;
  readonly #pageSize: number;
  readonly #maxResultBytes: number;

  constructor(options: SqliteTaskStoreOptions = {}) {
    this.#db = openDatabase(options.path ?? ":memory:");
    this.#scope = options.scope ?? identityScope;
    this.#logger = options.logger ?? silentLogger;
    this.#maxTtlMs = options.maxTtlMs ?? TASK_TTL_MAX_MS;
    this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TASK_TTL_MS;
    this.#defaultPollIntervalMs = options.defaultPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#pageSize = Math.min(
      Math.max(1, options.pageSize ?? DEFAULT_LIST_PAGE_SIZE),
      MAX_LIST_PAGE_SIZE,
    );
    this.#maxResultBytes = options.maxResultBytes ?? MAX_PAYLOAD_BYTES;
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS tasks (" +
        "rowid_key INTEGER PRIMARY KEY, scope TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL, " +
        "ttl INTEGER, created_at TEXT NOT NULL, last_updated_at TEXT NOT NULL, poll_interval INTEGER, " +
        "status_message TEXT, result_json TEXT, request_json TEXT, request_id_json TEXT, context_json TEXT, " +
        "expires_at_ms INTEGER);" +
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_scope_task ON tasks(scope, task_id);" +
        "CREATE INDEX IF NOT EXISTS idx_tasks_scope_order ON tasks(scope, rowid_key);",
    );
  }

  #rowToTask(row: SqlRow): Task {
    const status = asTaskStatus(reqString(row, "status"));
    if (status === undefined) {
      throw new TypeError("stored task has an unknown status");
    }
    const ttl = optNumber(row, "ttl");
    const task: Task = {
      taskId: reqString(row, "task_id"),
      status,
      ttl: ttl === undefined ? null : ttl,
      createdAt: reqString(row, "created_at"),
      lastUpdatedAt: reqString(row, "last_updated_at"),
    };
    const poll = optNumber(row, "poll_interval");
    if (poll !== undefined) {
      task.pollInterval = poll;
    }
    const statusMessage = optString(row, "status_message");
    if (statusMessage !== undefined) {
      task.statusMessage = statusMessage;
    }
    return task;
  }

  #selectRow(scope: string, taskId: string): SqlRow | undefined {
    return this.#db
      .prepare("SELECT * FROM tasks WHERE scope = ? AND task_id = ?")
      .get(scope, taskId);
  }

  async createTask(
    taskParams: CreateTaskOptions,
    requestId: RequestId,
    request: McpRequest,
    sessionId?: string,
  ): Promise<Task> {
    const scope = await this.#scope(sessionId);
    const taskId = newTaskId();
    const ttl = capTtl(taskParams.ttl, this.#maxTtlMs, this.#defaultTtlMs);
    const now = new Date();
    const createdAt = now.toISOString();
    const pollInterval = taskParams.pollInterval ?? this.#defaultPollIntervalMs;
    const expiresAtMs = ttl === null ? null : now.getTime() + ttl;
    const requestJson = serializeWithinLimit(request, this.#maxResultBytes, "task request");
    const requestIdJson = JSON.stringify(requestId);
    const contextJson =
      taskParams.context === undefined ? null : JSON.stringify(taskParams.context);
    this.#db
      .prepare(
        "INSERT INTO tasks(scope, task_id, status, ttl, created_at, last_updated_at, poll_interval, " +
          "status_message, result_json, request_json, request_id_json, context_json, expires_at_ms) " +
          "VALUES (?, ?, 'working', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)",
      )
      .run(
        scope,
        taskId,
        ttl,
        createdAt,
        createdAt,
        pollInterval,
        requestJson,
        requestIdJson,
        contextJson,
        expiresAtMs,
      );
    this.#logger.debug("task created", { taskId });
    return { taskId, status: "working", ttl, createdAt, lastUpdatedAt: createdAt, pollInterval };
  }

  async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    const scope = await this.#scope(sessionId);
    const row = this.#selectRow(scope, taskId);
    return row === undefined ? null : this.#rowToTask(row);
  }

  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    const scope = await this.#scope(sessionId);
    const row = this.#selectRow(scope, taskId);
    if (row === undefined) {
      throw new TaskNotFoundError(taskId);
    }
    const current = asTaskStatus(reqString(row, "status"));
    if (current === undefined) {
      throw new TypeError("stored task has an unknown status");
    }
    if (!isLegalTransition(current, status)) {
      this.#logger.debug("rejected illegal transition", { taskId, from: current, to: status });
      throw new IllegalTransitionError(current, status, taskId);
    }
    const lastUpdatedAt = new Date().toISOString();
    if (statusMessage === undefined) {
      this.#db
        .prepare("UPDATE tasks SET status = ?, last_updated_at = ? WHERE scope = ? AND task_id = ?")
        .run(status, lastUpdatedAt, scope, taskId);
    } else {
      this.#db
        .prepare(
          "UPDATE tasks SET status = ?, status_message = ?, last_updated_at = ? WHERE scope = ? AND task_id = ?",
        )
        .run(status, statusMessage, lastUpdatedAt, scope, taskId);
    }
  }

  async storeTaskResult(
    taskId: string,
    status: "completed" | "failed",
    result: Result,
    sessionId?: string,
  ): Promise<void> {
    const scope = await this.#scope(sessionId);
    const row = this.#selectRow(scope, taskId);
    if (row === undefined) {
      throw new TaskNotFoundError(taskId);
    }
    const current = asTaskStatus(reqString(row, "status"));
    if (current === undefined) {
      throw new TypeError("stored task has an unknown status");
    }
    if (isTerminalStatus(current)) {
      this.#logger.debug("rejected result on terminal task", { taskId, from: current, to: status });
      throw new IllegalTransitionError(current, status, taskId);
    }
    const resultJson = serializeWithinLimit(result, this.#maxResultBytes, "task result");
    const lastUpdatedAt = new Date().toISOString();
    this.#db
      .prepare(
        "UPDATE tasks SET status = ?, result_json = ?, last_updated_at = ? WHERE scope = ? AND task_id = ?",
      )
      .run(status, resultJson, lastUpdatedAt, scope, taskId);
  }

  async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    const scope = await this.#scope(sessionId);
    const row = this.#selectRow(scope, taskId);
    if (row === undefined) {
      throw new TaskNotFoundError(taskId);
    }
    const resultJson = optString(row, "result_json");
    if (resultJson === undefined) {
      throw new NoTaskResultError(taskId);
    }
    return parseJson(resultJson) as Result;
  }

  async listTasks(
    cursor?: string,
    sessionId?: string,
  ): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const scope = await this.#scope(sessionId);
    const afterKey = cursor === undefined ? 0 : decodeCursor(scope, cursor);
    const rows = this.#db
      .prepare(
        "SELECT * FROM tasks WHERE scope = ? AND rowid_key > ? ORDER BY rowid_key ASC LIMIT ?",
      )
      .all(scope, afterKey, this.#pageSize + 1);
    const page = rows.slice(0, this.#pageSize);
    const tasks = page.map((row) => this.#rowToTask(row));
    if (rows.length > this.#pageSize) {
      const lastRow = page[page.length - 1];
      if (lastRow !== undefined) {
        return { tasks, nextCursor: encodeCursor(scope, reqNumber(lastRow, "rowid_key")) };
      }
    }
    return { tasks };
  }

  /** Deletes tasks whose ttl has elapsed. Opt-in: reads never auto-prune. Returns the count removed. */
  pruneExpired(nowMs: number = Date.now()): number {
    const info = this.#db
      .prepare("DELETE FROM tasks WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ?")
      .run(nowMs);
    return Number(info.changes);
  }

  /** Closes the database handle. A file store stays on disk for the next open. */
  close(): void {
    this.#db.close();
  }
}
