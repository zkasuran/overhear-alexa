// Timeline math (pure). Derived from zkasuran/overhear (MiniMax Week, 2026-08) lib/audioEngine.ts
// buildTimeline, reworked for the part model: a part is a sequence of voiced lines with a fixed gap
// between them; an episode is a sequence of parts played back to back. All inputs in milliseconds.

export type LineTiming = { startMs: number; endMs: number };

/**
 * Lay out voiced lines end to end with `gapMs` of silence between them.
 * startOffsetMs shifts the whole part (e.g. past an intro sting). Returns one
 * timing per input duration, in order.
 */
export function layoutLines(
  durationsMs: readonly number[],
  gapMs: number,
  startOffsetMs = 0,
): LineTiming[] {
  if (gapMs < 0) throw new Error("layoutLines: gapMs must be >= 0");
  if (startOffsetMs < 0) throw new Error("layoutLines: startOffsetMs must be >= 0");
  const out: LineTiming[] = [];
  let cursor = startOffsetMs;
  for (let i = 0; i < durationsMs.length; i++) {
    const d = durationsMs[i] as number;
    if (!Number.isFinite(d) || d < 0)
      throw new Error("layoutLines: duration must be finite and >= 0");
    const startMs = cursor;
    const endMs = startMs + d;
    out.push({ startMs, endMs });
    cursor = endMs + gapMs; // trailing gap is not added after the last line by callers that slice
  }
  return out;
}

/** Total audible length of a part: end of its last line (no trailing gap). */
export function partDurationMs(timings: readonly LineTiming[]): number {
  if (timings.length === 0) return 0;
  return (timings[timings.length - 1] as LineTiming).endMs;
}

/**
 * Cumulative start offset (ms) of each part in playback order, given per-part audible seconds.
 * offsets[k] is where part k begins in the whole-episode timeline.
 */
export function episodeOffsetsMs(partSeconds: readonly number[]): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (const s of partSeconds) {
    if (!Number.isFinite(s) || s < 0)
      throw new Error("episodeOffsetsMs: seconds must be finite and >= 0");
    offsets.push(cursor);
    cursor += Math.round(s * 1000);
  }
  return offsets;
}

/** Clamp a requested offset into [0, maxMs]. Used by relative "back 30s" navigation. */
export function clampOffsetMs(requestedMs: number, maxMs: number): number {
  if (!Number.isFinite(requestedMs)) return 0;
  if (requestedMs < 0) return 0;
  if (requestedMs > maxMs) return maxMs;
  return Math.round(requestedMs);
}
