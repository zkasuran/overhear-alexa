// Real ffmpeg mix test: generate short MP3 tones with lavfi, feed their bytes to the mixer and prove
// the output is a valid MP3 whose duration matches sum(lines)+gaps and whose lineTimings line up with
// the real concat offsets. No shell strings: every ffmpeg/ffprobe call goes through execFile.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeFfmpegMixer } from "./ffmpeg.js";
import type { Logger } from "../contracts.js";

const FFMPEG = "/usr/bin/ffmpeg";
const FFPROBE = "/usr/bin/ffprobe";

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${bin}: ${String(stderr || err.message)}`));
        else resolve(stdout);
      },
    );
  });
}

async function genSine(file: string, seconds: number, freq: number): Promise<void> {
  await run(FFMPEG, [
    "-nostdin",
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${freq}:duration=${seconds}`,
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    file,
  ]);
}

async function probeSeconds(file: string): Promise<number> {
  const out = await run(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  return Number.parseFloat(out.trim());
}

function nullLogger(): Logger {
  const l: Logger = { info: () => {}, warn: () => {}, error: () => {}, child: () => l };
  return l;
}

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "overhear-mix-test-"));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("makeFfmpegMixer", () => {
  it("mixes voice-only lines with gaps into a valid MP3 whose timings match the concat", async () => {
    const specs = [
      { s: 0.6, f: 440 },
      { s: 0.9, f: 550 },
      { s: 1.2, f: 660 },
    ];
    const files: string[] = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      if (spec === undefined) throw new Error("bad spec");
      const file = join(dir, `voice-src-${i}.mp3`);
      await genSine(file, spec.s, spec.f);
      files.push(file);
    }
    const expectedMs: number[] = [];
    const lines: { audio: Uint8Array }[] = [];
    for (const file of files) {
      expectedMs.push(Math.round((await probeSeconds(file)) * 1000));
      lines.push({ audio: await readFile(file) });
    }

    const gapMs = 250;
    const result = await makeFfmpegMixer(nullLogger()).mix({ lines, gapMs });

    // Valid, non-empty MP3 that ffprobe can read a duration from.
    expect(result.mp3.byteLength).toBeGreaterThan(0);
    const outFile = join(dir, "voice-out.mp3");
    await writeFile(outFile, result.mp3);
    const probed = await probeSeconds(outFile);
    expect(Number.isFinite(probed)).toBe(true);
    expect(probed).toBeGreaterThan(0);

    // Output length is close to sum(line durations) + gaps between them.
    const expectedSeconds =
      expectedMs.reduce((a, b) => a + b, 0) / 1000 + ((specs.length - 1) * gapMs) / 1000;
    expect(Math.abs(probed - expectedSeconds)).toBeLessThan(0.4);
    expect(Math.abs(result.seconds - probed)).toBeLessThan(0.1);

    // One timing per line, starting at 0, monotonic, non-overlapping, exact gap, exact span.
    expect(result.lineTimings).toHaveLength(specs.length);
    expect(result.lineTimings[0]?.startMs).toBe(0);
    for (let i = 0; i < result.lineTimings.length; i++) {
      const t = result.lineTimings[i];
      if (t === undefined) throw new Error("missing timing");
      expect(t.endMs - t.startMs).toBe(expectedMs[i]);
      if (i > 0) {
        const prev = result.lineTimings[i - 1];
        if (prev === undefined) throw new Error("missing prev timing");
        expect(t.startMs).toBeGreaterThanOrEqual(prev.endMs);
        expect(t.startMs - prev.endMs).toBe(gapMs);
      }
    }
  });

  it("prepends the intro sting so the first line starts after it", async () => {
    const stingFile = join(dir, "sting.mp3");
    await genSine(stingFile, 0.5, 330);
    const stingMs = Math.round((await probeSeconds(stingFile)) * 1000);

    const l0 = join(dir, "sting-line-0.mp3");
    await genSine(l0, 0.7, 440);
    const lines = [{ audio: await readFile(l0) }];

    const result = await makeFfmpegMixer(nullLogger()).mix({
      lines,
      gapMs: 200,
      introStingPath: stingFile,
    });
    expect(result.mp3.byteLength).toBeGreaterThan(0);
    expect(result.lineTimings).toHaveLength(1);
    expect(result.lineTimings[0]?.startMs).toBe(stingMs);
    expect(result.seconds).toBeGreaterThan(0.7);
  });

  it("lays a ducked bed under the voice and still produces a valid MP3", async () => {
    const bedFile = join(dir, "bed.mp3");
    await genSine(bedFile, 2.0, 180);

    const a = join(dir, "bed-line-0.mp3");
    const b = join(dir, "bed-line-1.mp3");
    await genSine(a, 0.6, 440);
    await genSine(b, 0.9, 520);
    const expectedMs = [
      Math.round((await probeSeconds(a)) * 1000),
      Math.round((await probeSeconds(b)) * 1000),
    ];
    const lines = [{ audio: await readFile(a) }, { audio: await readFile(b) }];

    const gapMs = 200;
    const result = await makeFfmpegMixer(nullLogger()).mix({ lines, gapMs, bedPath: bedFile });

    expect(result.mp3.byteLength).toBeGreaterThan(0);
    const outFile = join(dir, "bed-out.mp3");
    await writeFile(outFile, result.mp3);
    const probed = await probeSeconds(outFile);
    expect(probed).toBeGreaterThan(0);

    // amix duration=first keeps the output at the voice length, not the longer bed.
    const expectedSeconds = (expectedMs[0]! + expectedMs[1]!) / 1000 + gapMs / 1000;
    expect(Math.abs(probed - expectedSeconds)).toBeLessThan(0.4);
    expect(result.lineTimings).toHaveLength(2);
    expect(result.lineTimings[1]!.startMs - result.lineTimings[0]!.endMs).toBe(gapMs);
  });
});
