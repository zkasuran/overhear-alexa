// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. A durable, per-task FIFO message queue on node:sqlite.

import type { DatabaseSync } from "node:sqlite";
import type { QueuedMessage, TaskMessageQueue } from "@modelcontextprotocol/sdk/experimental/tasks";
import type { Logger } from "../logger.js";
import type { Scope } from "../scope.js";
import { silentLogger } from "../logger.js";
import { identityScope } from "../scope.js";
import { DEFAULT_MAX_QUEUE_SIZE, MAX_PAYLOAD_BYTES } from "../internal/limits.js";
import { parseJson, serializeWithinLimit } from "../internal/json.js";
import { QueueFullError } from "../errors.js";
import { openDatabase, reqNumber, reqString } from "./db.js";

export interface SqliteTaskMessageQueueOptions {
  /** File path for a durable queue or ":memory:" (the default) for an ephemeral one. */
  path?: string;
  /** Resolver from session id to principal. Defaults to identity (the session id). */
  scope?: Scope;
  /** Optional logger. Silent by default. */
  logger?: Logger;
  /** Byte ceiling on a single queued message. */
  maxMessageBytes?: number;
  /** Ceiling applied when enqueue is called without a maxSize. */
  defaultMaxQueueSize?: number;
}

/**
 * TaskMessageQueue backed by SQLite. Messages are FIFO per task, scoped by the
 * resolved principal so one principal cannot drain another's queue. Durable across
 * a restart, which the SDK InMemory queue is not.
 */
export class SqliteTaskMessageQueue implements TaskMessageQueue {
  readonly #db: DatabaseSync;
  readonly #scope: Scope;
  readonly #logger: Logger;
  readonly #maxMessageBytes: number;
  readonly #defaultMaxQueueSize: number;

  constructor(options: SqliteTaskMessageQueueOptions = {}) {
    this.#db = openDatabase(options.path ?? ":memory:");
    this.#scope = options.scope ?? identityScope;
    this.#logger = options.logger ?? silentLogger;
    this.#maxMessageBytes = options.maxMessageBytes ?? MAX_PAYLOAD_BYTES;
    this.#defaultMaxQueueSize = options.defaultMaxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS queue (" +
        "seq INTEGER PRIMARY KEY, scope TEXT NOT NULL, task_id TEXT NOT NULL, message TEXT NOT NULL);" +
        "CREATE INDEX IF NOT EXISTS idx_queue_task ON queue(scope, task_id, seq);",
    );
  }

  async enqueue(
    taskId: string,
    message: QueuedMessage,
    sessionId?: string,
    maxSize?: number,
  ): Promise<void> {
    const scope = await this.#scope(sessionId);
    const text = serializeWithinLimit(message, this.#maxMessageBytes, "queued message");
    const limit = maxSize ?? this.#defaultMaxQueueSize;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const countRow = this.#db
        .prepare("SELECT COUNT(*) AS n FROM queue WHERE scope = ? AND task_id = ?")
        .get(scope, taskId);
      const count = countRow === undefined ? 0 : reqNumber(countRow, "n");
      if (count >= limit) {
        this.#db.exec("ROLLBACK");
        this.#logger.debug("queue full", { taskId, limit });
        throw new QueueFullError(taskId, limit);
      }
      this.#db
        .prepare("INSERT INTO queue(scope, task_id, message) VALUES (?, ?, ?)")
        .run(scope, taskId, text);
      this.#db.exec("COMMIT");
    } catch (error) {
      if (!(error instanceof QueueFullError)) {
        this.#db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  async dequeue(taskId: string, sessionId?: string): Promise<QueuedMessage | undefined> {
    const scope = await this.#scope(sessionId);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db
        .prepare(
          "SELECT seq, message FROM queue WHERE scope = ? AND task_id = ? ORDER BY seq ASC LIMIT 1",
        )
        .get(scope, taskId);
      if (row === undefined) {
        this.#db.exec("COMMIT");
        return undefined;
      }
      const seq = reqNumber(row, "seq");
      const message = parseJson(reqString(row, "message")) as QueuedMessage;
      this.#db.prepare("DELETE FROM queue WHERE seq = ?").run(seq);
      this.#db.exec("COMMIT");
      return message;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  async dequeueAll(taskId: string, sessionId?: string): Promise<QueuedMessage[]> {
    const scope = await this.#scope(sessionId);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#db
        .prepare("SELECT message FROM queue WHERE scope = ? AND task_id = ? ORDER BY seq ASC")
        .all(scope, taskId);
      const messages = rows.map((row) => parseJson(reqString(row, "message")) as QueuedMessage);
      this.#db.prepare("DELETE FROM queue WHERE scope = ? AND task_id = ?").run(scope, taskId);
      this.#db.exec("COMMIT");
      return messages;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Closes the database handle. A file store stays on disk for the next open. */
  close(): void {
    this.#db.close();
  }
}
