// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. The DynamoDB EventStore twin. Tested only under OVERHEAR_LIVE_TESTS.

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  EventStore,
  EventId,
  StreamId,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../logger.js";
import type { DynamoEventStoreOptions } from "./common.js";
import { silentLogger } from "../logger.js";
import { MAX_PAYLOAD_BYTES } from "../internal/limits.js";
import { parseJson, serializeWithinLimit } from "../internal/json.js";
import { reqNumber, reqString } from "../internal/row.js";

const COUNTER_PK = "C#GLOBAL";
const COUNTER_SK = "C";

function formatEventId(seq: number): EventId {
  return seq.toString().padStart(18, "0");
}

/**
 * EventStore on a DynamoDB table. A global counter item hands out a monotonic
 * sequence, each event is stored under its stream and an index item maps an
 * event id back to its stream so getStreamIdForEventId never parses the id.
 */
export class DynamoEventStore implements EventStore {
  readonly #client: DynamoDBDocumentClient;
  readonly #table: string;
  readonly #logger: Logger;
  readonly #maxMessageBytes: number;

  constructor(options: DynamoEventStoreOptions) {
    this.#client = options.client;
    this.#table = options.tableName;
    this.#logger = options.logger ?? silentLogger;
    this.#maxMessageBytes = options.maxMessageBytes ?? MAX_PAYLOAD_BYTES;
  }

  async #nextSeq(): Promise<number> {
    const out = await this.#client.send(
      new UpdateCommand({
        TableName: this.#table,
        Key: { pk: COUNTER_PK, sk: COUNTER_SK },
        UpdateExpression: "ADD #seq :one",
        ExpressionAttributeNames: { "#seq": "seq" },
        ExpressionAttributeValues: { ":one": 1 },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return reqNumber(out.Attributes ?? {}, "seq");
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const text = serializeWithinLimit(message, this.#maxMessageBytes, "event message");
    const seq = await this.#nextSeq();
    const eventId = formatEventId(seq);
    // The sort key is the padded event id, so a string range query returns events
    // in sequence order and every item on the table shares one sort-key type.
    await this.#client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.#table,
              Item: { pk: `S#${streamId}`, sk: eventId, eventId, message: text },
            },
          },
          {
            Put: {
              TableName: this.#table,
              Item: { pk: `E#${eventId}`, sk: "E", streamId },
            },
          },
        ],
      }),
    );
    return eventId;
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    const out = await this.#client.send(
      new GetCommand({ TableName: this.#table, Key: { pk: `E#${eventId}`, sk: "E" } }),
    );
    if (out.Item === undefined) {
      return undefined;
    }
    return reqString(out.Item, "streamId");
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const anchor = await this.#client.send(
      new GetCommand({ TableName: this.#table, Key: { pk: `E#${lastEventId}`, sk: "E" } }),
    );
    if (anchor.Item === undefined) {
      return "";
    }
    const streamId = reqString(anchor.Item, "streamId");
    let startKey: Record<string, unknown> | undefined;
    do {
      const out = await this.#client.send(
        new QueryCommand({
          TableName: this.#table,
          KeyConditionExpression: "pk = :pk AND sk > :last",
          ExpressionAttributeValues: { ":pk": `S#${streamId}`, ":last": lastEventId },
          ScanIndexForward: true,
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        }),
      );
      for (const item of out.Items ?? []) {
        const message = parseJson(reqString(item, "message")) as JSONRPCMessage;
        await send(reqString(item, "eventId"), message);
      }
      startKey = out.LastEvaluatedKey;
    } while (startKey !== undefined);
    this.#logger.debug("replayed stream", { streamId });
    return streamId;
  }
}
