// SPDX-License-Identifier: Apache-2.0
// Part of @overhear/durable-stores. Optional structured logger, silent by default.

/**
 * Minimal structured logger. The stores never write to the console. They log
 * through this interface when a logger is supplied and stay silent otherwise.
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** A logger that drops every message. The default for every store. */
export const silentLogger: Logger = {
  debug() {},
  warn() {},
  error() {},
};
