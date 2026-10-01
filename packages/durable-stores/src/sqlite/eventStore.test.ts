// SPDX-License-Identifier: Apache-2.0
// Property and unit tests for SqliteEventStore: replay correctness and id round-trips.

import { expect, test } from "vitest";
import fc from "fast-check";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { SqliteEventStore } from "./eventStore.js";

const msg = (method: string): JSONRPCMessage => ({ jsonrpc: "2.0", method });

test("the standalone _GET_stream id round-trips (the SDK example store bug)", async () => {
  const store = new SqliteEventStore();
  const id = await store.storeEvent("_GET_stream", msg("notifications/progress"));
  expect(await store.getStreamIdForEventId(id)).toBe("_GET_stream");
  store.close();
});

test("replay after an event replays only the later events of that stream, in order", async () => {
  const store = new SqliteEventStore();
  const a1 = await store.storeEvent("_GET_stream", msg("a1"));
  await store.storeEvent("other", msg("b1"));
  await store.storeEvent("_GET_stream", msg("a2"));
  const got: string[] = [];
  const stream = await store.replayEventsAfter(a1, {
    send: async (_id, m) => {
      got.push(JSON.stringify(m));
    },
  });
  expect(stream).toBe("_GET_stream");
  expect(got).toEqual([JSON.stringify(msg("a2"))]);
  store.close();
});

test("property: replay after ANY event id returns exactly that stream's later events in order", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom("_GET_stream", "s0", "s1", "x_y_z"), {
        minLength: 1,
        maxLength: 40,
      }),
      fc.nat(),
      async (streams, anchorPick) => {
        const store = new SqliteEventStore();
        try {
          const events: { id: string; stream: string }[] = [];
          for (let i = 0; i < streams.length; i++) {
            const stream = streams[i]!;
            const id = await store.storeEvent(stream, msg(`m${i}`));
            events.push({ id, stream });
          }
          const anchorIndex = anchorPick % events.length;
          const anchor = events[anchorIndex]!;
          const expected = events
            .slice(anchorIndex + 1)
            .filter((e) => e.stream === anchor.stream)
            .map((e) => e.id);
          const got: string[] = [];
          const returned = await store.replayEventsAfter(anchor.id, {
            send: async (id) => {
              got.push(id);
            },
          });
          expect(returned).toBe(anchor.stream);
          expect(got).toEqual(expected);
          expect(new Set(got).size).toBe(got.length);
        } finally {
          store.close();
        }
      },
    ),
    { numRuns: 100 },
  );
});

test("property: getStreamIdForEventId round-trips for every stored id", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom("_GET_stream", "_GET_stream_odd", "alpha", "a_b_c"), {
        minLength: 1,
        maxLength: 25,
      }),
      async (streams) => {
        const store = new SqliteEventStore();
        try {
          for (let i = 0; i < streams.length; i++) {
            const stream = streams[i]!;
            const id = await store.storeEvent(stream, msg(`m${i}`));
            expect(await store.getStreamIdForEventId(id)).toBe(stream);
          }
        } finally {
          store.close();
        }
      },
    ),
    { numRuns: 50 },
  );
});
