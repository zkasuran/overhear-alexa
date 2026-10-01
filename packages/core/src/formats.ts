// Ported from zkasuran/overhear (MiniMax Week, 2026-08) lib/voices.ts — kept the four
// format presets (names, tone, music seed) and dropped the MiniMax-specific voice ids.
// Provider voice selection (Polly generative ids, or MiniMax ids if D-5 flips) lives in
// config/default.ts, not here: core carries no provider detail.

import type { FormatId } from "./types.js";

export type FormatPreset = {
  id: FormatId;
  label: string;
  blurb: string;
  hostName: string;
  expertName: string;
  /** Seed appended to the theme-bed / music style prompt. */
  musicSeed: string;
  /** Short mood word for the cached bed under dialogue. */
  bedMood: string;
  /** Steers the script model's tone. */
  tone: string;
  /** Silence between consecutive lines when mixing, in ms (format-specific pacing). */
  gapMs: number;
};

export const FORMATS: Record<FormatId, FormatPreset> = {
  explainer: {
    id: "explainer",
    label: "Curious explainer",
    blurb: "A warm host and a sharp expert unpack one idea end to end.",
    hostName: "Ava",
    expertName: "Theo",
    musicSeed:
      "warm indie-pop podcast theme, bright synths, light drums, upbeat, catchy, mid tempo",
    bedMood: "warm",
    tone: "friendly, curious, plain-spoken; the host asks great questions, the expert answers with vivid concrete detail",
    gapMs: 220,
  },
  debate: {
    id: "debate",
    label: "Two-sided debate",
    blurb: "Two voices argue the strongest case on each side, fairly.",
    hostName: "Nadia",
    expertName: "Marcus",
    musicSeed: "tense cinematic underscore, pulsing strings, low percussion, serious, building",
    bedMood: "tense",
    tone: "sharp but respectful; each speaker steel-mans one side, concedes real points, no strawmen",
    gapMs: 180,
  },
  cozy: {
    id: "cozy",
    label: "Cozy wind-down",
    blurb: "A calm, unhurried take for a walk or the end of the day.",
    hostName: "Elena",
    expertName: "Sam",
    musicSeed: "gentle lofi ambient, soft piano, mellow beat, warm, relaxed, slow tempo",
    bedMood: "mellow",
    tone: "soft, reflective, unhurried; short sentences, lots of imagery, nothing frantic",
    gapMs: 350,
  },
  hype: {
    id: "hype",
    label: "Hype trailer",
    blurb: "A punchy, high-energy trailer that makes the idea feel huge.",
    hostName: "Zoe",
    expertName: "Rex",
    musicSeed: "epic trailer build, big drums, rising synth, energetic, triumphant, fast tempo",
    bedMood: "epic",
    tone: "punchy and vivid; short hype lines, big stakes, momentum that keeps building",
    gapMs: 200,
  },
};

export const DEFAULT_FORMAT: FormatId = "explainer";
