// Text to speech via Amazon Polly generative engine (TtsAdapter in ../contracts.ts). One line of
// script in, one mp3 clip out. Duration is measured off the real bytes with ffprobe rather than
// guessed, so mix timing reads a true length. The mock twin lives in mock/tts.ts
// and is what the judge default (OVERHEAR_MODELS=mock) runs; this path needs AWS creds and spends.

import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import type { VoiceId } from "@aws-sdk/client-polly";
import { TTS_TIMEOUT_MS, randomBase62 } from "@overhear/core";
import type { Logger, SynthResult, TtsAdapter } from "../contracts.js";

const execFileAsync = promisify(execFile);

/** Measure a media file's duration in seconds with ffprobe. argv array, never a shell string. */
async function probeDurationSeconds(file: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe returned no usable duration (got ${JSON.stringify(stdout.trim())})`);
  }
  return seconds;
}

/** Build the Polly-backed TtsAdapter. Region picks the Polly endpoint; log is the structured sink. */
export function makePollyTts(region: string, log: Logger): TtsAdapter {
  const client = new PollyClient({ region });
  const l = log.child({ adapter: "polly", region });

  async function synthesize(
    text: string,
    voiceId: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<SynthResult> {
    const timeoutMs = opts?.timeoutMs ?? TTS_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = (): void => controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref();
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    let audio: Uint8Array;
    try {
      const out = await client.send(
        new SynthesizeSpeechCommand({
          Engine: "generative",
          OutputFormat: "mp3",
          SampleRate: "24000",
          VoiceId: voiceId as VoiceId,
          Text: text,
        }),
        { abortSignal: controller.signal },
      );
      if (!out.AudioStream) throw new Error("Polly returned no AudioStream");
      audio = await out.AudioStream.transformToByteArray();
    } catch (err) {
      if (timedOut) {
        l.warn("synthesize timed out", { voiceId, timeoutMs });
        throw new Error(`Polly synthesize timed out after ${timeoutMs}ms`);
      }
      l.warn("synthesize failed", {
        voiceId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
      if (opts?.signal) opts.signal.removeEventListener("abort", onExternalAbort);
    }

    if (audio.byteLength === 0) throw new Error("Polly returned empty audio");

    // Write the real bytes to a temp file and measure them; a true length beats a guess for mix timing.
    const file = join(tmpdir(), `overhear-polly-${randomBase62(16)}.mp3`);
    let seconds: number;
    try {
      await writeFile(file, audio);
      seconds = await probeDurationSeconds(file);
    } finally {
      await rm(file, { force: true });
    }

    l.info("synthesize ok", { voiceId, bytes: audio.byteLength, seconds });
    return { audio, seconds, mime: "audio/mpeg" };
  }

  return { synthesize };
}
