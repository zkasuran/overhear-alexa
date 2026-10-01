import { describe, expect, it } from "vitest";
import { CONCURRENT_TASKS, EPISODES_PER_DAY, REQ_PER_MIN } from "@overhear/core";
import { makeQuotaTracker } from "./quota.js";

/** A quota tracker over a clock the test advances by hand. */
function fixedClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

describe("quota: episodes per day", () => {
  it("allows up to the daily limit then denies", () => {
    const clock = fixedClock();
    const q = makeQuotaTracker(clock.now);
    for (let i = 0; i < EPISODES_PER_DAY; i++) {
      expect(q.checkAndReserve("alice", "episode").ok).toBe(true);
    }
    expect(q.checkAndReserve("alice", "episode").ok).toBe(false);
  });

  it("resets after the day window elapses", () => {
    const clock = fixedClock();
    const q = makeQuotaTracker(clock.now);
    for (let i = 0; i < EPISODES_PER_DAY; i++) q.checkAndReserve("alice", "episode");
    expect(q.checkAndReserve("alice", "episode").ok).toBe(false);
    clock.advance(DAY_MS + 1);
    expect(q.checkAndReserve("alice", "episode").ok).toBe(true);
  });

  it("budgets each principal separately", () => {
    const clock = fixedClock();
    const q = makeQuotaTracker(clock.now);
    for (let i = 0; i < EPISODES_PER_DAY; i++) q.checkAndReserve("alice", "episode");
    expect(q.checkAndReserve("alice", "episode").ok).toBe(false);
    expect(q.checkAndReserve("bob", "episode").ok).toBe(true);
  });
});

describe("quota: requests per minute", () => {
  it("allows up to the limit then denies before resetting after a minute", () => {
    const clock = fixedClock();
    const q = makeQuotaTracker(clock.now);
    for (let i = 0; i < REQ_PER_MIN; i++) {
      expect(q.checkAndReserve("alice", "request").ok).toBe(true);
    }
    expect(q.checkAndReserve("alice", "request").ok).toBe(false);
    clock.advance(MINUTE_MS + 1);
    expect(q.checkAndReserve("alice", "request").ok).toBe(true);
  });
});

describe("quota: concurrent tasks", () => {
  it("caps concurrency and frees a slot on release", () => {
    const clock = fixedClock();
    const q = makeQuotaTracker(clock.now);
    const held = [];
    for (let i = 0; i < CONCURRENT_TASKS; i++) {
      const r = q.checkAndReserve("alice", "task");
      expect(r.ok).toBe(true);
      held.push(r);
    }
    expect(q.checkAndReserve("alice", "task").ok).toBe(false);
    expect(q.activeTasks("alice")).toBe(CONCURRENT_TASKS);
    held[0]?.release();
    expect(q.activeTasks("alice")).toBe(CONCURRENT_TASKS - 1);
    expect(q.checkAndReserve("alice", "task").ok).toBe(true);
  });

  it("ignores a double release", () => {
    const clock = fixedClock();
    const q = makeQuotaTracker(clock.now);
    const r = q.checkAndReserve("alice", "task");
    r.release();
    r.release();
    expect(q.activeTasks("alice")).toBe(0);
  });

  it("a denied reservation carries a safe no-op release", () => {
    const clock = fixedClock();
    const q = makeQuotaTracker(clock.now);
    for (let i = 0; i < CONCURRENT_TASKS; i++) q.checkAndReserve("alice", "task");
    const denied = q.checkAndReserve("alice", "task");
    expect(denied.ok).toBe(false);
    denied.release();
    expect(q.activeTasks("alice")).toBe(CONCURRENT_TASKS);
  });
});
