// SPDX-License-Identifier: Apache-2.0
// Runs the portable store conformance suite against the SQLite stores.

import { expect, test } from "vitest";
import { runStoreConformance } from "./conformance.js";
import { SqliteEventStore } from "./sqlite/eventStore.js";
import { SqliteTaskStore } from "./sqlite/taskStore.js";
import { SqliteTaskMessageQueue } from "./sqlite/messageQueue.js";

test("SQLite stores pass the full store conformance suite", async () => {
  const report = await runStoreConformance(() => ({
    event: new SqliteEventStore(),
    task: new SqliteTaskStore(),
    queue: new SqliteTaskMessageQueue(),
  }));
  const failures = report.results
    .filter((r) => !r.passed)
    .map((r) => `${r.name}: ${r.error ?? ""}`);
  expect(failures.join("\n")).toBe("");
  expect(report.ok).toBe(true);
  expect(report.passed).toBeGreaterThanOrEqual(20);
});

test("the suite reports a failure instead of hanging when a store misbehaves", async () => {
  // A broken task store that never isolates: it ignores the scope entirely.
  const report = await runStoreConformance(
    () => ({
      event: new SqliteEventStore(),
      task: new SqliteTaskStore({ scope: async () => "one-global-bucket" }),
      queue: new SqliteTaskMessageQueue({ scope: async () => "one-global-bucket" }),
    }),
    { isolation: true },
  );
  // Isolation checks must fail when every session collapses to one scope.
  expect(report.results.some((r) => r.group === "isolation" && !r.passed)).toBe(true);
});
