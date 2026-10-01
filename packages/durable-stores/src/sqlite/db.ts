// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. node:sqlite open helper, plus shared row readers.

import { DatabaseSync } from "node:sqlite";

export { reqString, reqNumber, optString, optNumber } from "../internal/row.js";
export type { SqlRow } from "../internal/row.js";

/**
 * Opens (or creates) a SQLite database. Pass ":memory:" for an ephemeral store
 * or a file path for one that survives a restart. WAL plus a busy timeout keep
 * two processes on one file from stepping on each other.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
