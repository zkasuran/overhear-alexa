// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. A durable EventStore on node:sqlite.

import type { DatabaseSync } from "node:sqlite";
import type {
  EventStore,
  EventId,
  StreamId,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../logger.js";
import { silentLogger } from "../logger.js";
import { MAX_PAYLOAD_BYTES } from "../internal/limits.js";
import { randomBase62 } from "../internal/ids.js";
import { parseJson, serializeWithinLimit } from "../internal/json.js";
import { openDatabase, reqNumber, reqString } from "./db.js";

export interface SqliteEventStoreOptions {
  /** File path for a durable store or ":memory:" (the default) for an ephemeral one. */
  path?: string;
  /** Optional logger. Silent by default. */
  logger?: Logger;
  /** Byte ceiling on a single stored message. Defaults to 4 MiB. */
  maxMessageBytes?: number;
}

// An 18-digit zero-padded sequence. The event id is monotonic within a stream and
// globally and the stream linkage is stored in the row, never parsed out of the id.
function formatEventId(seq: number): EventId {
  return seq.toString().padStart(18, "0");
}

/**
 * EventStore backed by SQLite. Fixes the two faults in the SDK example store: it
 * persists across a restart and it maps an event id back to its stream from a
 * stored column instead of splitting the id on "_", so the standalone "_GET_stream"
 * replays correctly.
 */
export class SqliteEventStore implements EventStore {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;
  readonly #maxMessageBytes: number;

  constructor(options: SqliteEventStoreOptions = {}) {
    this.#db = openDatabase(options.path ?? ":memory:");
    this.#logger = options.logger ?? silentLogger;
    this.#maxMessageBytes = options.maxMessageBytes ?? MAX_PAYLOAD_BYTES;
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS events (" +
        "seq INTEGER PRIMARY KEY, stream_id TEXT NOT NULL, event_id TEXT NOT NULL, message TEXT NOT NULL);" +
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_id ON events(event_id);" +
        "CREATE INDEX IF NOT EXISTS idx_events_stream ON events(stream_id, seq);",
    );
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const text = serializeWithinLimit(message, this.#maxMessageBytes, "event message");
    // Two steps in one write transaction: insert to claim a sequence, then stamp
    // the final event id from that sequence. BEGIN IMMEDIATE serializes writers.
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const pending = `pending-${randomBase62(24)}`;
      const info = this.#db
        .prepare("INSERT INTO events(stream_id, event_id, message) VALUES (?, ?, ?)")
        .run(streamId, pending, text);
      const seq = Number(info.lastInsertRowid);
      const eventId = formatEventId(seq);
      this.#db.prepare("UPDATE events SET event_id = ? WHERE seq = ?").run(eventId, seq);
      this.#db.exec("COMMIT");
      return eventId;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      this.#logger.error("storeEvent failed", { streamId });
      throw error;
    }
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    const row = this.#db.prepare("SELECT stream_id FROM events WHERE event_id = ?").get(eventId);
    if (row === undefined) {
      return undefined;
    }
    return reqString(row, "stream_id");
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const anchor = this.#db
      .prepare("SELECT seq, stream_id FROM events WHERE event_id = ?")
      .get(lastEventId);
    if (anchor === undefined) {
      // Unknown anchor: nothing to replay and no stream to map.
      return "";
    }
    const anchorSeq = reqNumber(anchor, "seq");
    const streamId = reqString(anchor, "stream_id");
    const rows = this.#db
      .prepare(
        "SELECT event_id, message FROM events WHERE stream_id = ? AND seq > ? ORDER BY seq ASC",
      )
      .all(streamId, anchorSeq);
    for (const row of rows) {
      const message = parseJson(reqString(row, "message")) as JSONRPCMessage;
      await send(reqString(row, "event_id"), message);
    }
    return streamId;
  }

  /** Closes the database handle. A file store stays on disk for the next open. */
  close(): void {
    this.#db.close();
  }
}
