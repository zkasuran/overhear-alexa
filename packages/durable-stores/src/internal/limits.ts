// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. Ceilings in one place, imported never inlined.

/** Largest ttl a task may request, in milliseconds. One hour. A larger request is capped to this. */
export const TASK_TTL_MAX_MS = 3_600_000;

/** Default ttl applied when a task requests none (ttl undefined). Null requests stay unlimited. */
export const DEFAULT_TASK_TTL_MS = 3_600_000;

/** Default poll interval suggested to clients when a task sets none. */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** Default page size for listTasks. */
export const DEFAULT_LIST_PAGE_SIZE = 50;

/** Hard ceiling on a listTasks page size, so a caller cannot ask for an unbounded page. */
export const MAX_LIST_PAGE_SIZE = 500;

/** Byte ceiling on a single stored event or task result. Matches the transport body cap. */
export const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** Default per-task message queue ceiling when the caller passes no maxSize. */
export const DEFAULT_MAX_QUEUE_SIZE = 1_024;
