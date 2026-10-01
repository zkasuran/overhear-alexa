// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. Public surface. Extracted to a standalone package, mcp-durable-stores.

export type { Scope } from "./scope.js";
export { identityScope, GLOBAL_SCOPE } from "./scope.js";

export type { Logger } from "./logger.js";
export { silentLogger } from "./logger.js";

export {
  DurableStoreError,
  TaskNotFoundError,
  IllegalTransitionError,
  NoTaskResultError,
  InvalidCursorError,
  QueueFullError,
  PayloadTooLargeError,
} from "./errors.js";

export {
  TASK_TTL_MAX_MS,
  DEFAULT_TASK_TTL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_LIST_PAGE_SIZE,
  MAX_LIST_PAGE_SIZE,
  MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_QUEUE_SIZE,
} from "./internal/limits.js";

export {
  TASK_STATUSES,
  isTerminalStatus,
  isLegalTransition,
  asTaskStatus,
} from "./internal/status.js";
export { randomBase62, newTaskId } from "./internal/ids.js";

export { SqliteEventStore } from "./sqlite/eventStore.js";
export type { SqliteEventStoreOptions } from "./sqlite/eventStore.js";
export { SqliteTaskStore } from "./sqlite/taskStore.js";
export type { SqliteTaskStoreOptions } from "./sqlite/taskStore.js";
export { SqliteTaskMessageQueue } from "./sqlite/messageQueue.js";
export type { SqliteTaskMessageQueueOptions } from "./sqlite/messageQueue.js";

export { DynamoEventStore } from "./dynamo/eventStore.js";
export { DynamoTaskStore } from "./dynamo/taskStore.js";
export { DynamoTaskMessageQueue } from "./dynamo/messageQueue.js";
export { createDynamoDocumentClient } from "./dynamo/common.js";
export type {
  DynamoStoreOptions,
  DynamoTaskStoreOptions,
  DynamoEventStoreOptions,
  DynamoTaskMessageQueueOptions,
} from "./dynamo/common.js";

export {
  runStoreConformance,
  conformanceChecks,
  assert,
  assertEqual,
  assertDeepEqual,
  assertRejects,
  isIso8601,
} from "./conformance.js";
export type {
  Stores,
  StoresFactory,
  ConformanceReport,
  ConformanceCheckResult,
  RunConformanceOptions,
} from "./conformance.js";
