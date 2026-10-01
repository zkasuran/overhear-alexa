import { test, expect } from "vitest";
import {
  randomBase62,
  newEpisodeId,
  newPartId,
  newLineId,
  newSessionId,
  newTaskId,
  newMediaToken,
} from "./ids.js";

const BASE62 = /^[0-9A-Za-z]+$/;

test("randomBase62: exact length, base62 alphabet only", () => {
  for (const len of [1, 12, 16, 22, 40]) {
    const s = randomBase62(len);
    expect(s).toHaveLength(len);
    expect(s).toMatch(BASE62);
  }
});

test("randomBase62: rejects non-positive length", () => {
  expect(() => randomBase62(0)).toThrow(Error);
  expect(() => randomBase62(-5)).toThrow(Error);
});

test("id prefixes and shapes", () => {
  expect(newEpisodeId()).toMatch(/^ep_[0-9A-Za-z]{22}$/);
  expect(newPartId()).toMatch(/^pt_[0-9A-Za-z]{16}$/);
  expect(newLineId()).toMatch(/^ln_[0-9A-Za-z]{12}$/);
  expect(newSessionId()).toMatch(/^[0-9A-Za-z]{22}$/);
  expect(newTaskId()).toMatch(/^[0-9A-Za-z]{22}$/);
});

test("ids are unique across many draws (no obvious collisions)", () => {
  const n = 20_000;
  const set = new Set<string>();
  for (let i = 0; i < n; i++) set.add(newTaskId());
  expect(set.size).toBe(n);
});

test("newMediaToken carries at least the requested entropy", () => {
  const t = newMediaToken(16);
  expect(t).toMatch(BASE62);
  // 16 bytes = 128 bits; base62 chars ~5.95 bits each; need >= 22 chars.
  expect(t.length).toBeGreaterThanOrEqual(22);
});

test("rough uniformity of the first character (no modulo bias)", () => {
  const counts = new Map<string, number>();
  const draws = 62 * 400;
  for (let i = 0; i < draws; i++) {
    const c = randomBase62(1);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  // Every symbol should appear; expected ~400 each. Loose bound catches a biased map.
  expect(counts.size).toBe(62);
  for (const v of counts.values()) {
    expect(v).toBeGreaterThan(200);
    expect(v).toBeLessThan(650);
  }
});
