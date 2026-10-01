// Acceptance test for the mock TtsAdapter (./tts.ts). Proves the mock emits REAL mp3 bytes a judge can
// hear, sized to the text, deterministic (cacheable) and clamped. ffprobe reads the duration off the
// actual bytes so the length claim is measured, not trusted. The live Polly path is not exercised here
// (it needs AWS creds and spend; OVERHEAR_LIVE_TESTS covers that elsewhere).

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { makePollyTts } from "../polly.js";
import type { Logger } from "../../contracts.js";
import { estimateSeconds, makeMockTts } from "./tts.js";

const silentLog: Logger = {
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLog;
  },
};

const execFileAsync = promisify(execFile);

/** Measure duration off real bytes, the same way the pipeline will, independent of the adapter. */
async function probeSeconds(bytes: Uint8Array): Promise<number> {
  const file = join(tmpdir(), `overhear-tts-test-${randomBytes(8).toString("hex")}.mp3`);
  await writeFile(file, bytes);
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    return Number.parseFloat(stdout.trim());
  } finally {
    await rm(file, { force: true });
  }
}

/** True for an ID3-tagged or frame-sync mp3 header. Enough to tell real audio from a text stub. */
function looksLikeMp3(b: Uint8Array): boolean {
  const b0 = b[0];
  const b1 = b[1];
  const b2 = b[2];
  if (b0 === undefined || b1 === undefined || b2 === undefined) return false;
  const id3 = b0 === 0x49 && b1 === 0x44 && b2 === 0x33; // "ID3"
  const frameSync = b0 === 0xff && (b1 & 0xe0) === 0xe0; // 11 sync bits
  return id3 || frameSync;
}

describe("mock tts", () => {
  const tts = makeMockTts();

  it("produces non-empty real mp3 bytes", async () => {
    const r = await tts.synthesize("A short recorded sample for the judge to hear.", "Ruth");
    expect(r.mime).toBe("audio/mpeg");
    expect(r.audio.byteLength).toBeGreaterThan(0);
    expect(looksLikeMp3(r.audio)).toBe(true);
    expect(await probeSeconds(r.audio)).toBeGreaterThan(0);
  });

  it("measured duration is within 0.3s of the estimate", async () => {
    const text = "This line has a handful of words to size the clip just so.";
    const r = await tts.synthesize(text, "Matthew");
    expect(r.seconds).toBe(estimateSeconds(text));
    const probed = await probeSeconds(r.audio);
    expect(Math.abs(probed - r.seconds)).toBeLessThanOrEqual(0.3);
  });

  it("is byte-identical for the same input (cache)", async () => {
    const text = "Deterministic output means the cache can replay it exactly.";
    const a = await tts.synthesize(text, "Joanna");
    const b = await tts.synthesize(text, "Joanna");
    expect(Buffer.from(b.audio).equals(Buffer.from(a.audio))).toBe(true);
    expect(b.seconds).toBe(a.seconds);
  });

  it("varies the bytes by voice", async () => {
    const text = "Same words, different voice, different tone.";
    const a = await tts.synthesize(text, "Ruth");
    const b = await tts.synthesize(text, "Stephen");
    expect(Buffer.from(b.audio).equals(Buffer.from(a.audio))).toBe(false);
    expect(b.seconds).toBe(a.seconds); // length tracks the words, not the voice
  });

  it("longer text yields longer audio", async () => {
    const short = await tts.synthesize(
      "Ten quick words make a short little sample clip right now.",
      "Ruth",
    );
    const longText = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const long = await tts.synthesize(longText, "Ruth");
    expect(long.seconds).toBeGreaterThan(short.seconds);
    const [ps, pl] = await Promise.all([probeSeconds(short.audio), probeSeconds(long.audio)]);
    expect(pl).toBeGreaterThan(ps);
  });

  it("respects the 1..30s clamp", async () => {
    const tiny = await tts.synthesize("hi", "Ruth"); // 1 word => below the floor
    expect(tiny.seconds).toBe(1);
    expect(estimateSeconds("")).toBe(1);
    const hugeText = Array.from({ length: 200 }, () => "word").join(" "); // ~77s raw => above the ceiling
    const huge = await tts.synthesize(hugeText, "Ruth");
    expect(huge.seconds).toBe(30);
    expect(Math.abs((await probeSeconds(tiny.audio)) - 1)).toBeLessThanOrEqual(0.3);
    expect(Math.abs((await probeSeconds(huge.audio)) - 30)).toBeLessThanOrEqual(0.3);
  });
});

describe("polly tts (offline wiring)", () => {
  // Builds the adapter and asserts its shape. The live SynthesizeSpeech call needs AWS creds and spend,
  // so it is not exercised here (OVERHEAR_LIVE_TESTS covers that). Constructing the client is offline:
  // credentials resolve lazily on send, so this proves the module loads, resolves and wires up.
  it("exposes a synthesize function without touching the network", () => {
    const tts = makePollyTts("us-east-1", silentLog);
    expect(typeof tts.synthesize).toBe("function");
  });
});
