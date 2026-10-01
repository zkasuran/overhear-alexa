// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. Typed errors, never a bare throw of a string.

import type { TaskStatus } from "@modelcontextprotocol/sdk/types.js";

/** Base class for every error this library throws. */
export class DurableStoreError extends Error {}

/** A task id was not found under the resolved scope. */
export class TaskNotFoundError extends DurableStoreError {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
    this.taskId = taskId;
  }
}

/** An attempt to move a task through a status change the spec forbids. */
export class IllegalTransitionError extends DurableStoreError {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly taskId: string;
  constructor(from: TaskStatus, to: TaskStatus, taskId: string) {
    super(`illegal task status transition ${from} to ${to} for task ${taskId}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
    this.taskId = taskId;
  }
}

/** A result was requested for a task that has not stored one yet. */
export class NoTaskResultError extends DurableStoreError {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`task has no stored result: ${taskId}`);
    this.name = "NoTaskResultError";
    this.taskId = taskId;
  }
}

/** A pagination cursor did not decode or belonged to another scope. */
export class InvalidCursorError extends DurableStoreError {
  constructor() {
    super("invalid pagination cursor");
    this.name = "InvalidCursorError";
  }
}

/** An enqueue would push the per-task queue past its ceiling. */
export class QueueFullError extends DurableStoreError {
  readonly taskId: string;
  readonly maxSize: number;
  constructor(taskId: string, maxSize: number) {
    super(`task message queue is full for ${taskId} (max ${maxSize})`);
    this.name = "QueueFullError";
    this.taskId = taskId;
    this.maxSize = maxSize;
  }
}

/** A serialized payload exceeded the configured byte ceiling. */
export class PayloadTooLargeError extends DurableStoreError {
  readonly bytes: number;
  readonly maxBytes: number;
  constructor(label: string, bytes: number, maxBytes: number) {
    super(`${label} is too large: ${bytes} bytes exceeds ceiling of ${maxBytes}`);
    this.name = "PayloadTooLargeError";
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}
