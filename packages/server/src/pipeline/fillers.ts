// Per-format stall fillers. When part k+1 is not ready as part k ends, the player loops the format
// bed under a short pre-rendered host line ("more on that in a second") so there is never silence.
// Six lines per format in that format's tone, voiced once at boot and cached. Pure data plus two
// small functions so the set is testable without a running TTS.

import type { Services, SynthResult } from "../contracts.js";
import type { FormatId } from "@overhear/core";
import { FORMAT_IDS, TTS_TIMEOUT_MS } from "@overhear/core";

/** A cached filler clip. Alias of the TTS result so a fake adapter in a test satisfies it too. */
export type SynthResultLike = SynthResult;

export const FILLERS_PER_FORMAT = 6;

/** Six short "hold on" lines per format, written in the format's own voice. No stage directions. */
export const FILLER_LINES: Record<FormatId, readonly string[]> = {
  explainer: [
    "Give me one second, the next part is almost ready.",
    "Hang tight, I am lining up what comes next.",
    "Nearly there, the next bit is worth the short wait.",
    "One moment while I pull the next piece together.",
    "Almost set, let me cue up the next part for you.",
    "Stay with me, more on that in just a second.",
  ],
  debate: [
    "One moment, the next argument is coming right up.",
    "Hold that thought, the other side is nearly ready.",
    "Give me a second, I want to get this point right.",
    "Almost there, the next exchange is loading.",
    "Stay with it, the rebuttal lands in a moment.",
    "Short pause, then we pick the debate back up.",
  ],
  cozy: [
    "Take a breath, the next part arrives in a moment.",
    "No rush, we will drift into the next bit shortly.",
    "Settle in, there is a little more coming soon.",
    "Just a soft pause before we carry on.",
    "Stay cozy, the next piece is on its way.",
    "Give it a moment, we are nearly there.",
  ],
  hype: [
    "Hold up, the next part is about to hit.",
    "Stay locked in, this is just getting started.",
    "One beat, then we go even bigger.",
    "Almost there, the next drop is loading.",
    "Do not move, more fire is seconds away.",
    "Quick breath, then we crank it back up.",
  ],
};

export function fillerLines(format: FormatId): readonly string[] {
  return FILLER_LINES[format];
}

/** Voice every filler once in the format's host voice. Call at boot; cache the result. */
export async function renderFillers(services: Services): Promise<Map<FormatId, SynthResultLike[]>> {
  const out = new Map<FormatId, SynthResultLike[]>();
  for (const format of FORMAT_IDS) {
    const voiceId = services.config.voices[format].host;
    const clips: SynthResultLike[] = [];
    for (const text of FILLER_LINES[format]) {
      clips.push(await services.tts.synthesize(text, voiceId, { timeoutMs: TTS_TIMEOUT_MS }));
    }
    out.set(format, clips);
  }
  return out;
}

/** Pick a cached filler clip for a format, rotating by `n`. Returns undefined if none are cached. */
export function pickFiller(
  clips: ReadonlyMap<FormatId, readonly SynthResultLike[]>,
  format: FormatId,
  n = 0,
): SynthResultLike | undefined {
  const arr = clips.get(format);
  if (arr === undefined || arr.length === 0) return undefined;
  const idx = ((n % arr.length) + arr.length) % arr.length;
  return arr[idx];
}
