// Per-principal, in-process usage limits. Three budgets, all keyed by the bearer principal so one
// caller cannot spend another's allowance (see SECURITY.md): episodes per rolling day, concurrent
// tasks and tool invocations per rolling minute. `checkAndReserve` both tests and claims a slot and
// returns a `release` for the one budget that needs it (concurrent tasks); the time-windowed budgets
// return a no-op release because they age out on their own. The clock is injected so tests advance it.

import { CONCURRENT_TASKS, EPISODES_PER_DAY, REQ_PER_MIN } from "@overhear/core";

export type QuotaKind = "episode" | "task" | "request";

export interface Reservation {
  /** True when the slot was granted. When false the caller must refuse the operation. */
  ok: boolean;
  /** Frees a concurrent slot. A no-op for the time-windowed budgets. Safe to call more than once. */
  release: () => void;
}

export interface QuotaTracker {
  checkAndReserve(principal: string, kind: QuotaKind): Reservation;
  /** Current concurrent-task count for a principal. For tests and health reporting. */
  activeTasks(principal: string): number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const NOOP = (): void => {};
const DENIED: Reservation = { ok: false, release: NOOP };

/** Drop timestamps at or before the window cutoff, keeping the array sorted and bounded. */
function withinWindow(stamps: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  let first = 0;
  while (first < stamps.length && (stamps[first] ?? 0) <= cutoff) first += 1;
  return first === 0 ? stamps : stamps.slice(first);
}

export function makeQuotaTracker(now: () => number = () => Date.now()): QuotaTracker {
  const episodeStamps = new Map<string, number[]>();
  const requestStamps = new Map<string, number[]>();
  const active = new Map<string, number>();

  function reserveWindow(
    store: Map<string, number[]>,
    principal: string,
    windowMs: number,
    limit: number,
  ): Reservation {
    const t = now();
    const kept = withinWindow(store.get(principal) ?? [], windowMs, t);
    if (kept.length >= limit) {
      store.set(principal, kept);
      return DENIED;
    }
    kept.push(t);
    store.set(principal, kept);
    return { ok: true, release: NOOP };
  }

  return {
    checkAndReserve(principal, kind) {
      if (kind === "episode") {
        return reserveWindow(episodeStamps, principal, DAY_MS, EPISODES_PER_DAY);
      }
      if (kind === "request") {
        return reserveWindow(requestStamps, principal, MINUTE_MS, REQ_PER_MIN);
      }
      const count = active.get(principal) ?? 0;
      if (count >= CONCURRENT_TASKS) return DENIED;
      active.set(principal, count + 1);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        active.set(principal, Math.max(0, (active.get(principal) ?? 0) - 1));
      };
      return { ok: true, release };
    },
    activeTasks(principal) {
      return active.get(principal) ?? 0;
    },
  };
}
