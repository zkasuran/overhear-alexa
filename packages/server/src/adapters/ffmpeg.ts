// ffmpeg mixer: concat voiced lines with gaps, prepend an optional intro sting, lay an optional
// ducked bed under the voice, normalise to -16 LUFS integrated, emit MP3 128 kbps. S-11: every
// subprocess runs through execFile with an argv array, never a shell string and every path is a
// temp file we created, never user text. Timeline math comes from @overhear/core.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layoutLines } from "@overhear/core";
import type { Logger, Mixer, MixInput, MixResult } from "../contracts.js";

const FFMPEG = "/usr/bin/ffmpeg";
const FFPROBE = "/usr/bin/ffprobe";

const SAMPLE_RATE = 44100;
const MP3_BITRATE = "128k";
const BED_GAIN_DB = -22; // bed sits this far under the voice before ducking
const LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11"; // podcast integrated loudness
const NORM = `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Run a binary with an argv array. No shell, so no injection surface (S-11). */
function run(bin: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [...args],
      { maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${bin} failed: ${String(stderr || err.message).slice(-500)}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Container duration in seconds via ffprobe. Throws if the file is not readable audio. */
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
  const seconds = Number.parseFloat(out.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe returned no usable duration for ${file}`);
  }
  return seconds;
}

/** Build the filter_complex that concatenates lines (0..n-1) with gapMs silence between them and an
 * optional intro sting (input index n) prepended. Produces one labelled output stream [out]. */
function buildVoiceFilter(n: number, gapMs: number, hasSting: boolean): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(`[${i}:a]${NORM}[a${i}]`);
  const useGap = gapMs > 0 && n > 1;
  if (useGap) {
    const gapSec = (gapMs / 1000).toFixed(6);
    for (let j = 0; j < n - 1; j++) {
      parts.push(
        `aevalsrc=0|0:d=${gapSec}:s=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo[g${j}]`,
      );
    }
  }
  if (hasSting) parts.push(`[${n}:a]${NORM}[s]`);
  const seq: string[] = [];
  if (hasSting) seq.push("[s]");
  for (let i = 0; i < n; i++) {
    seq.push(`[a${i}]`);
    if (useGap && i < n - 1) seq.push(`[g${i}]`);
  }
  const chain = seq.join("");
  parts.push(
    seq.length === 1 ? `${chain}anull[out]` : `${chain}concat=n=${seq.length}:v=0:a=1[out]`,
  );
  return parts.join(";");
}

export function makeFfmpegMixer(log: Logger): Mixer {
  return {
    async mix(input: MixInput): Promise<MixResult> {
      const n = input.lines.length;
      if (n === 0) throw new Error("mix: no lines to mix");
      const startedAt = Date.now();
      const dir = await mkdtemp(join(tmpdir(), "overhear-mix-"));
      try {
        const lineFiles: string[] = [];
        for (let i = 0; i < n; i++) {
          const file = join(dir, `line-${i}.mp3`);
          const line = input.lines[i];
          if (line === undefined) throw new Error(`mix: missing line at index ${i}`);
          await writeFile(file, line.audio);
          lineFiles.push(file);
        }

        const lineSeconds: number[] = [];
        for (const file of lineFiles) lineSeconds.push(await probeSeconds(file));
        const stingSeconds = input.introStingPath ? await probeSeconds(input.introStingPath) : 0;

        const perLineDurationsMs = lineSeconds.map((s) => Math.round(s * 1000));
        const introStingDurationMs = Math.round(stingSeconds * 1000);
        const lineTimings = layoutLines(perLineDurationsMs, input.gapMs, introStingDurationMs);

        const voiceWav = join(dir, "voice.wav");
        const voiceArgs = ["-nostdin", "-hide_banner", "-v", "error", "-y"];
        for (const file of lineFiles) voiceArgs.push("-i", file);
        if (input.introStingPath) voiceArgs.push("-i", input.introStingPath);
        voiceArgs.push(
          "-filter_complex",
          buildVoiceFilter(n, input.gapMs, Boolean(input.introStingPath)),
          "-map",
          "[out]",
          "-c:a",
          "pcm_s16le",
          voiceWav,
        );
        await run(FFMPEG, voiceArgs);
        const voiceSeconds = await probeSeconds(voiceWav);

        const outMp3 = join(dir, "out.mp3");
        if (input.bedPath) {
          const fade = Math.min(1.5, Math.max(0.2, voiceSeconds / 4)).toFixed(6);
          const fadeOut = Math.max(0, voiceSeconds - Number.parseFloat(fade)).toFixed(6);
          const fc = [
            `[1:a]${NORM},asplit=2[vmain][vkey]`,
            `[0:a]${NORM},volume=${BED_GAIN_DB}dB[bedv]`,
            `[bedv]afade=t=in:st=0:d=${fade},afade=t=out:st=${fadeOut}:d=${fade}[bedf]`,
            `[bedf][vkey]sidechaincompress=threshold=0.02:ratio=6:attack=5:release=250[bedduck]`,
            `[vmain][bedduck]amix=inputs=2:duration=first:dropout_transition=0[mix]`,
            `[mix]${LOUDNORM}[outa]`,
          ].join(";");
          await run(FFMPEG, [
            "-nostdin",
            "-hide_banner",
            "-v",
            "error",
            "-y",
            "-stream_loop",
            "-1",
            "-i",
            input.bedPath,
            "-i",
            voiceWav,
            "-filter_complex",
            fc,
            "-map",
            "[outa]",
            "-c:a",
            "libmp3lame",
            "-b:a",
            MP3_BITRATE,
            outMp3,
          ]);
        } else {
          await run(FFMPEG, [
            "-nostdin",
            "-hide_banner",
            "-v",
            "error",
            "-y",
            "-i",
            voiceWav,
            "-af",
            LOUDNORM,
            "-c:a",
            "libmp3lame",
            "-b:a",
            MP3_BITRATE,
            outMp3,
          ]);
        }

        const seconds = await probeSeconds(outMp3);
        const mp3: Uint8Array = await readFile(outMp3);
        log.info("ffmpeg mix done", {
          lines: n,
          gapMs: input.gapMs,
          bed: Boolean(input.bedPath),
          sting: Boolean(input.introStingPath),
          seconds,
          ms: Date.now() - startedAt,
        });
        return { mp3, seconds, lineTimings };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
