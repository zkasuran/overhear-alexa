// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. The DynamoDB TaskStore twin. Tested only under OVERHEAR_LIVE_TESTS.

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
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
import type { DynamoTaskStoreOptions } from "./common.js";
import { decodeKeyCursor, encodeKeyCursor, isConditionalCheckFailed } from "./common.js";
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
import { asTaskStatus } from "../internal/status.js";
import { newTaskId } from "../internal/ids.js";
import { capTtl } from "../internal/ttl.js";
import { parseJson, serializeWithinLimit } from "../internal/json.js";
import { IllegalTransitionError, NoTaskResultError, TaskNotFoundError } from "../errors.js";
import { optNumber, optString, reqString, type SqlRow } from "../internal/row.js";

/**
 * TaskStore on a DynamoDB table. Partition key `pk` is the resolved scope, sort
 * key `sk` is the task id, so a Query reads exactly one principal's tasks. Legal
 * transitions are enforced with conditional writes and the `expiresAt` attribute
 * drives DynamoDB TTL cleanup. Configure TTL on the table against `expiresAt`.
 */
export class DynamoTaskStore implements TaskStore {
  readonly #client: DynamoDBDocumentClient;
  readonly #table: string;
  readonly #scope: Scope;
  readonly #logger: Logger;
  readonly #maxTtlMs: number;
  readonly #defaultTtlMs: number;
  readonly #defaultPollIntervalMs: number;
  readonly #pageSize: number;
  readonly #maxResultBytes: number;

  constructor(options: DynamoTaskStoreOptions) {
    this.#client = options.client;
    this.#table = options.tableName;
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
  }

  #itemToTask(item: SqlRow): Task {
    const status = asTaskStatus(reqString(item, "st"));
    if (status === undefined) {
      throw new TypeError("stored task has an unknown status");
    }
    const ttl = optNumber(item, "ttlMs");
    const task: Task = {
      taskId: reqString(item, "sk"),
      status,
      ttl: ttl === undefined ? null : ttl,
      createdAt: reqString(item, "createdAt"),
      lastUpdatedAt: reqString(item, "updatedAt"),
    };
    const poll = optNumber(item, "pollInterval");
    if (poll !== undefined) {
      task.pollInterval = poll;
    }
    const statusMessage = optString(item, "statusMsg");
    if (statusMessage !== undefined) {
      task.statusMessage = statusMessage;
    }
    return task;
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
    const requestJson = serializeWithinLimit(request, this.#maxResultBytes, "task request");
    const expiresAt = ttl === null ? undefined : Math.floor((now.getTime() + ttl) / 1000);
    await this.#client.send(
      new PutCommand({
        TableName: this.#table,
        Item: {
          pk: scope,
          sk: taskId,
          st: "working",
          ttlMs: ttl,
          createdAt,
          updatedAt: createdAt,
          pollInterval,
          requestJson,
          requestIdJson: JSON.stringify(requestId),
          contextJson: taskParams.context === undefined ? null : JSON.stringify(taskParams.context),
          ...(expiresAt === undefined ? {} : { expiresAt }),
        },
        ConditionExpression: "attribute_not_exists(sk)",
      }),
    );
    this.#logger.debug("task created", { taskId });
    return { taskId, status: "working", ttl, createdAt, lastUpdatedAt: createdAt, pollInterval };
  }

  async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    const scope = await this.#scope(sessionId);
    const out = await this.#client.send(
      new GetCommand({ TableName: this.#table, Key: { pk: scope, sk: taskId } }),
    );
    return out.Item === undefined ? null : this.#itemToTask(out.Item);
  }

  async #currentStatus(scope: string, taskId: string): Promise<TaskStatus> {
    const out = await this.#client.send(
      new GetCommand({ TableName: this.#table, Key: { pk: scope, sk: taskId } }),
    );
    if (out.Item === undefined) {
      throw new TaskNotFoundError(taskId);
    }
    const status = asTaskStatus(reqString(out.Item, "st"));
    if (status === undefined) {
      throw new TypeError("stored task has an unknown status");
    }
    return status;
  }

  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    const scope = await this.#scope(sessionId);
    const now = new Date().toISOString();
    const setMsg = statusMessage !== undefined;
    try {
      await this.#client.send(
        new UpdateCommand({
          TableName: this.#table,
          Key: { pk: scope, sk: taskId },
          UpdateExpression: setMsg
            ? "SET st = :status, statusMsg = :msg, updatedAt = :now"
            : "SET st = :status, updatedAt = :now",
          ConditionExpression: "attribute_exists(sk) AND (st = :working OR st = :inputReq)",
          ExpressionAttributeValues: {
            ":status": status,
            ":now": now,
            ":working": "working",
            ":inputReq": "input_required",
            ...(setMsg ? { ":msg": statusMessage } : {}),
          },
        }),
      );
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        const current = await this.#currentStatus(scope, taskId);
        throw new IllegalTransitionError(current, status, taskId);
      }
      throw error;
    }
  }

  async storeTaskResult(
    taskId: string,
    status: "completed" | "failed",
    result: Result,
    sessionId?: string,
  ): Promise<void> {
    const scope = await this.#scope(sessionId);
    const resultJson = serializeWithinLimit(result, this.#maxResultBytes, "task result");
    const now = new Date().toISOString();
    try {
      await this.#client.send(
        new UpdateCommand({
          TableName: this.#table,
          Key: { pk: scope, sk: taskId },
          UpdateExpression: "SET st = :status, resultJson = :result, updatedAt = :now",
          ConditionExpression: "attribute_exists(sk) AND (st = :working OR st = :inputReq)",
          ExpressionAttributeValues: {
            ":status": status,
            ":result": resultJson,
            ":now": now,
            ":working": "working",
            ":inputReq": "input_required",
          },
        }),
      );
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        const current = await this.#currentStatus(scope, taskId);
        throw new IllegalTransitionError(current, status, taskId);
      }
      throw error;
    }
  }

  async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    const scope = await this.#scope(sessionId);
    const out = await this.#client.send(
      new GetCommand({ TableName: this.#table, Key: { pk: scope, sk: taskId } }),
    );
    if (out.Item === undefined) {
      throw new TaskNotFoundError(taskId);
    }
    const resultJson = optString(out.Item, "resultJson");
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
    const startKey = cursor === undefined ? undefined : decodeKeyCursor(scope, cursor);
    const out = await this.#client.send(
      new QueryCommand({
        TableName: this.#table,
        KeyConditionExpression: "pk = :scope",
        ExpressionAttributeValues: { ":scope": scope },
        Limit: this.#pageSize,
        ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
      }),
    );
    const items = out.Items ?? [];
    const tasks = items.map((item) => this.#itemToTask(item));
    if (out.LastEvaluatedKey !== undefined) {
      return { tasks, nextCursor: encodeKeyCursor(out.LastEvaluatedKey) };
    }
    return { tasks };
  }
}
