// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. Typed readers over a plain row record.

/** A row as a store backend returns it: a plain record of output values. */
export type SqlRow = Record<string, unknown>;

/** Reads a required string column or throws when the shape is wrong. */
export function reqString(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new TypeError(`expected string in column ${column}`);
  }
  return value;
}

/** Reads a required numeric column, coercing a bigint down to a number. */
export function reqNumber(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new TypeError(`expected number in column ${column}`);
}

/** Reads an optional string column, returning undefined for NULL or absent. */
export function optString(row: SqlRow, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError(`expected string or null in column ${column}`);
  }
  return value;
}

/** Reads an optional numeric column, returning undefined for NULL or absent. */
export function optNumber(row: SqlRow, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new TypeError(`expected number or null in column ${column}`);
}
