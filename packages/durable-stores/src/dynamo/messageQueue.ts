// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. The DynamoDB TaskMessageQueue twin. Tested only under OVERHEAR_LIVE_TESTS.

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { QueuedMessage, TaskMessageQueue } from "@modelcontextprotocol/sdk/experimental/tasks";
import type { Logger } from "../logger.js";
import type { Scope } from "../scope.js";
import type { DynamoTaskMessageQueueOptions } from "./common.js";
import { silentLogger } from "../logger.js";
import { identityScope } from "../scope.js";
import { DEFAULT_MAX_QUEUE_SIZE, MAX_PAYLOAD_BYTES } from "../internal/limits.js";
import { parseJson, serializeWithinLimit } from "../internal/json.js";
import { QueueFullError } from "../errors.js";
import { reqNumber, reqString } from "../internal/row.js";

// A zero-padded sequence, so the sort key is a String whose lexical order matches
// the numeric order. One sort-key type per table is a DynamoDB requirement.
function seqKey(seq: number): string {
  return seq.toString().padStart(18, "0");
}

/**
 * TaskMessageQueue on a DynamoDB table. Messages for one (scope, task) share a
 * partition and sort by a monotonic sequence, so a Query reads them in FIFO order.
 * A per-queue counter item hands out the sequence.
 */
export class DynamoTaskMessageQueue implements TaskMessageQueue {
  readonly #client: DynamoDBDocumentClient;
  readonly #table: string;
  readonly #scope: Scope;
  readonly #logger: Logger;
  readonly #maxMessageBytes: number;
  readonly #defaultMaxQueueSize: number;

  constructor(options: DynamoTaskMessageQueueOptions) {
    this.#client = options.client;
    this.#table = options.tableName;
    this.#scope = options.scope ?? identityScope;
    this.#logger = options.logger ?? silentLogger;
    this.#maxMessageBytes = options.maxMessageBytes ?? MAX_PAYLOAD_BYTES;
    this.#defaultMaxQueueSize = options.defaultMaxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  }

  async #nextSeq(scope: string, taskId: string): Promise<number> {
    const out = await this.#client.send(
      new UpdateCommand({
        TableName: this.#table,
        Key: { pk: `QC#${scope}#${taskId}`, sk: "C" },
        UpdateExpression: "ADD #seq :one",
        ExpressionAttributeNames: { "#seq": "seq" },
        ExpressionAttributeValues: { ":one": 1 },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return reqNumber(out.Attributes ?? {}, "seq");
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
    const countOut = await this.#client.send(
      new QueryCommand({
        TableName: this.#table,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `Q#${scope}#${taskId}` },
        Select: "COUNT",
      }),
    );
    if ((countOut.Count ?? 0) >= limit) {
      this.#logger.debug("queue full", { taskId, limit });
      throw new QueueFullError(taskId, limit);
    }
    const seq = await this.#nextSeq(scope, taskId);
    await this.#client.send(
      new PutCommand({
        TableName: this.#table,
        Item: { pk: `Q#${scope}#${taskId}`, sk: seqKey(seq), message: text },
      }),
    );
  }

  async dequeue(taskId: string, sessionId?: string): Promise<QueuedMessage | undefined> {
    const scope = await this.#scope(sessionId);
    const out = await this.#client.send(
      new QueryCommand({
        TableName: this.#table,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `Q#${scope}#${taskId}` },
        ScanIndexForward: true,
        Limit: 1,
      }),
    );
    const first = (out.Items ?? [])[0];
    if (first === undefined) {
      return undefined;
    }
    const sk = reqString(first, "sk");
    const message = parseJson(reqString(first, "message")) as QueuedMessage;
    await this.#client.send(
      new DeleteCommand({ TableName: this.#table, Key: { pk: `Q#${scope}#${taskId}`, sk } }),
    );
    return message;
  }

  async dequeueAll(taskId: string, sessionId?: string): Promise<QueuedMessage[]> {
    const scope = await this.#scope(sessionId);
    const messages: QueuedMessage[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const out = await this.#client.send(
        new QueryCommand({
          TableName: this.#table,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": `Q#${scope}#${taskId}` },
          ScanIndexForward: true,
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        }),
      );
      for (const item of out.Items ?? []) {
        messages.push(parseJson(reqString(item, "message")) as QueuedMessage);
        await this.#client.send(
          new DeleteCommand({
            TableName: this.#table,
            Key: { pk: `Q#${scope}#${taskId}`, sk: reqString(item, "sk") },
          }),
        );
      }
      startKey = out.LastEvaluatedKey;
    } while (startKey !== undefined);
    return messages;
  }
}
