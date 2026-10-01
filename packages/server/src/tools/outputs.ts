// Output schemas the tools advertise so a client sees each tool's structuredContent shape in tools/list.
// Enum-like fields use the exact value sets from the domain model, so a plain-tool result that the SDK
// validates against its schema (get_episode) always conforms. Kept here so the Part and audio shapes are
// written once and reused across the tools that return them.

import { z } from "zod";

export const audioOut = z.object({
  url: z.string(),
  seconds: z.number(),
  mime: z.literal("audio/mpeg"),
});

export const lineOut = z.object({
  lineId: z.string(),
  speaker: z.enum(["host", "expert"]),
  text: z.string(),
  startMs: z.number().optional(),
  endMs: z.number().optional(),
});

export const partOut = z.object({
  index: z.number().int(),
  partId: z.string(),
  heading: z.string(),
  summary: z.string(),
  estSeconds: z.number(),
  origin: z.enum(["plan", "expansion"]),
  expandsPartId: z.string().optional(),
  status: z.enum(["pending", "scripting", "voicing", "mixing", "ready", "failed"]),
  audio: audioOut.optional(),
  lines: z.array(lineOut).optional(),
});

export const citationOut = z.object({
  partId: z.string(),
  lineId: z.string(),
  quote: z.string(),
});

/** get_episode: an episode without its owner, parts carrying lines only when requested. */
export const EPISODE_OUTPUT = {
  id: z.string(),
  title: z.string(),
  dek: z.string(),
  format: z.enum(["explainer", "debate", "cozy", "hype"]),
  focus: z.string().optional(),
  targetSeconds: z.number(),
  status: z.enum(["planned", "rendering", "ready", "failed"]),
  parts: z.array(partOut),
  sourceKind: z.enum(["topic", "url", "text"]),
  createdAt: z.string(),
  updatedAt: z.string(),
};

/** render_episode: the finished episode's parts without per-line detail, plus the total audio length. */
export const RENDER_OUTPUT = {
  episodeId: z.string(),
  status: z.enum(["ready", "failed"]),
  parts: z.array(partOut),
  totalSeconds: z.number(),
};

/** expand_part: the inserted follow-up part. */
export const EXPAND_OUTPUT = { inserted: partOut };

/** recap: the spoken recap text and its audio. */
export const RECAP_OUTPUT = { text: z.string(), audio: audioOut };

/** ask: the grounded answer, its audio, and the transcript citations. */
export const ASK_OUTPUT = {
  answer: z.string(),
  speaker: z.enum(["host", "expert"]),
  audio: audioOut,
  citations: z.array(citationOut),
  grounded: z.boolean(),
};
