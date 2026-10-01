// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. Shared pieces for the DynamoDB store twins.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Logger } from "../logger.js";
import type { Scope } from "../scope.js";
import { InvalidCursorError } from "../errors.js";

/** Options every DynamoDB store accepts. The caller owns the document client and the table. */
export interface DynamoStoreOptions {
  /** A DynamoDB document client, already configured for the target region or endpoint. */
  client: DynamoDBDocumentClient;
  /** The table name. The store never creates it. */
  tableName: string;
  /** Optional logger. Silent by default. */
  logger?: Logger;
}

/** Task-store options add the scope resolver and the ttl ceilings. */
export interface DynamoTaskStoreOptions extends DynamoStoreOptions {
  scope?: Scope;
  maxTtlMs?: number;
  defaultTtlMs?: number;
  defaultPollIntervalMs?: number;
  pageSize?: number;
  maxResultBytes?: number;
}

/** Queue options add the scope resolver and the queue ceilings. */
export interface DynamoTaskMessageQueueOptions extends DynamoStoreOptions {
  scope?: Scope;
  maxMessageBytes?: number;
  defaultMaxQueueSize?: number;
}

/** Event-store options add the message ceiling. Streams carry their own scope. */
export interface DynamoEventStoreOptions extends DynamoStoreOptions {
  maxMessageBytes?: number;
}

/** Builds a document client from a plain client config. A convenience for callers that have none. */
export function createDynamoDocumentClient(
  config: DynamoDBClientConfig = {},
): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient(config), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/** True when an error is the conditional-write failure DynamoDB raises on a lost race. */
export function isConditionalCheckFailed(error: unknown): boolean {
  return error instanceof ConditionalCheckFailedException;
}

/** Encodes a DynamoDB LastEvaluatedKey into an opaque base64url cursor. */
export function encodeKeyCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

/** Decodes a cursor and checks it belongs to this scope or throws InvalidCursorError. */
export function decodeKeyCursor(scope: string, cursor: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new InvalidCursorError();
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new InvalidCursorError();
  }
  const key = parsed as Record<string, unknown>;
  if (key["pk"] !== scope) {
    throw new InvalidCursorError();
  }
  return key;
}
