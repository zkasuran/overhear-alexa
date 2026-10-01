import { test, expect } from "vitest";
import fc from "fast-check";
import { layoutLines, partDurationMs, episodeOffsetsMs, clampOffsetMs } from "./timeline.js";

test("layoutLines: sequential with gaps, no trailing gap in duration", () => {
  const t = layoutLines([1000, 2000, 500], 200);
  expect(t[0]).toEqual({ startMs: 0, endMs: 1000 });
  expect(t[1]).toEqual({ startMs: 1200, endMs: 3200 });
  expect(t[2]).toEqual({ startMs: 3400, endMs: 3900 });
  expect(partDurationMs(t)).toBe(3900);
});

test("layoutLines: start offset shifts the whole part", () => {
  const t = layoutLines([500], 200, 6000);
  expect(t[0]).toEqual({ startMs: 6000, endMs: 6500 });
});

test("layoutLines: rejects bad input", () => {
  expect(() => layoutLines([100], -1)).toThrow(Error);
  expect(() => layoutLines([-100], 10)).toThrow(Error);
  expect(() => layoutLines([Number.NaN], 10)).toThrow(Error);
});

test("partDurationMs: empty is zero", () => {
  expect(partDurationMs([])).toBe(0);
});

test("episodeOffsetsMs: cumulative, first is zero", () => {
  expect(episodeOffsetsMs([30, 60, 45])).toEqual([0, 30000, 90000]);
});

test("clampOffsetMs: clamps into range", () => {
  expect(clampOffsetMs(-5, 1000)).toBe(0);
  expect(clampOffsetMs(500, 1000)).toBe(500);
  expect(clampOffsetMs(5000, 1000)).toBe(1000);
  expect(clampOffsetMs(Number.NaN, 1000)).toBe(0);
});

// Property: timings are non-overlapping and strictly ordered; each line's span equals its duration.
test("layoutLines: monotonic, non-overlapping, span equals duration", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 60_000 }), { minLength: 1, maxLength: 30 }),
      fc.integer({ min: 0, max: 2000 }),
      (durations, gap) => {
        const t = layoutLines(durations, gap);
        expect(t).toHaveLength(durations.length);
        for (let i = 0; i < t.length; i++) {
          const span = t[i] as { startMs: number; endMs: number };
          expect(span.endMs - span.startMs).toBe(durations[i]);
          if (i > 0) {
            const prev = t[i - 1] as { endMs: number };
            expect(span.startMs).toBe(prev.endMs + gap);
          }
        }
      },
    ),
    { numRuns: 1000 },
  );
});
