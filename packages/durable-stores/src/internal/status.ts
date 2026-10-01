// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. The task status lifecycle, encoded once.

import type { TaskStatus } from "@modelcontextprotocol/sdk/types.js";

/** Every task status, in the order the spec lists them. */
export const TASK_STATUSES = [
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
] as const;

const TERMINAL = new Set<TaskStatus>(["completed", "failed", "cancelled"]);

/**
 * Legal transitions from the MCP 2025-11-25 Task Status Lifecycle. A task starts
 * in working. From a non-terminal status it may move to any status, which includes
 * staying put for a status-message refresh. A terminal status never transitions.
 */
const LEGAL: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  working: new Set<TaskStatus>(["working", "input_required", "completed", "failed", "cancelled"]),
  input_required: new Set<TaskStatus>([
    "working",
    "input_required",
    "completed",
    "failed",
    "cancelled",
  ]),
  completed: new Set<TaskStatus>(),
  failed: new Set<TaskStatus>(),
  cancelled: new Set<TaskStatus>(),
};

/** True when a status is terminal and must never change again. */
export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

/** True when a move from one status to another is allowed by the lifecycle. */
export function isLegalTransition(from: TaskStatus, to: TaskStatus): boolean {
  return LEGAL[from].has(to);
}

/** Narrows an arbitrary string to a TaskStatus or returns undefined. */
export function asTaskStatus(value: string): TaskStatus | undefined {
  return (TASK_STATUSES as readonly string[]).includes(value) ? (value as TaskStatus) : undefined;
}
