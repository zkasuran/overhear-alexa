// Zod schemas shared by the tool handlers (input validation + MCP input/output schema) and the render
// pipeline (validating model JSON after extractJson). One source of truth so a cap can only be stated
// once and always matches core/ceilings. All caps import the ceilings constant, never a literal.

import { z } from "zod";
import {
  MINUTES_MIN,
  MINUTES_MAX,
  MAX_SOURCE_CHARS,
  MAX_FOCUS_CHARS,
  MAX_ANGLE_CHARS,
  MAX_QUERY_CHARS,
  MAX_QUESTION_CHARS,
  MAX_TITLE_CHARS,
  MAX_DEK_CHARS,
  MAX_LINE_CHARS,
  MAX_LINES_PER_PART,
  MAX_PARTS,
  RECAP_SECONDS_MIN,
  RECAP_SECONDS_MAX,
} from "@overhear/core";

export const FormatIdSchema = z.enum(["explainer", "debate", "cozy", "hype"]);
export const SpeakerSchema = z.enum(["host", "expert"]);
const Offset = z.object({ partId: z.string().min(1), offsetMs: z.number().int().min(0) });

// ---- Tool inputs (also used to build each tool's MCP inputSchema) ----

export const PlanEpisodeInput = z.object({
  source: z.object({
    kind: z.enum(["topic", "url", "text"]),
    value: z.string().min(1).max(MAX_SOURCE_CHARS),
  }),
  minutes: z.number().int().min(MINUTES_MIN).max(MINUTES_MAX).optional(),
  format: FormatIdSchema.default("explainer"),
  focus: z.string().max(MAX_FOCUS_CHARS).optional(),
});

export const RenderEpisodeInput = z.object({
  episodeId: z.string().min(1),
  fromPart: z.number().int().min(0).default(0),
});

export const GetEpisodeInput = z.object({
  episodeId: z.string().min(1),
  include: z.array(z.literal("lines")).optional(),
});

export const FindMomentInput = z.object({
  episodeId: z.string().min(1),
  query: z.string().min(1).max(MAX_QUERY_CHARS),
  from: Offset.optional(),
});

export const ExpandPartInput = z.object({
  episodeId: z.string().min(1),
  partId: z.string().min(1),
  angle: z.string().max(MAX_ANGLE_CHARS).optional(),
});

export const RecapInput = z.object({
  episodeId: z.string().min(1),
  upTo: Offset,
  seconds: z.number().int().min(RECAP_SECONDS_MIN).max(RECAP_SECONDS_MAX),
});

export const AskInput = z.object({
  episodeId: z.string().min(1),
  question: z.string().min(1).max(MAX_QUESTION_CHARS),
  at: Offset,
});

// ---- Model-output shapes (validated after extractJson) ----

export const PlanModelOutput = z.object({
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  dek: z.string().max(MAX_DEK_CHARS),
  parts: z
    .array(
      z.object({
        heading: z.string().min(1),
        summary: z.string().min(1),
        estSeconds: z.number().min(5).max(600),
      }),
    )
    .min(1)
    .max(MAX_PARTS),
});

export const ScriptModelOutput = z.object({
  lines: z
    .array(z.object({ speaker: SpeakerSchema, text: z.string().min(1).max(MAX_LINE_CHARS) }))
    .min(1)
    .max(MAX_LINES_PER_PART),
});

export const ExpandModelOutput = z.object({
  heading: z.string().min(1),
  lines: ScriptModelOutput.shape.lines,
});

export const AskModelOutput = z.object({
  answer: z.string().min(1),
  grounded: z.boolean(),
  citations: z.array(z.object({ quote: z.string().min(1).max(200) })).default([]),
});

export const RecapModelOutput = z.object({ text: z.string().min(1) });

export const FindModelOutput = z.object({
  partId: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reason: z.string().default(""),
});

export type PlanEpisodeInputT = z.infer<typeof PlanEpisodeInput>;
export type RenderEpisodeInputT = z.infer<typeof RenderEpisodeInput>;
export type GetEpisodeInputT = z.infer<typeof GetEpisodeInput>;
export type FindMomentInputT = z.infer<typeof FindMomentInput>;
export type ExpandPartInputT = z.infer<typeof ExpandPartInput>;
export type RecapInputT = z.infer<typeof RecapInput>;
export type AskInputT = z.infer<typeof AskInput>;
export type PlanModelOutputT = z.infer<typeof PlanModelOutput>;
export type ScriptModelOutputT = z.infer<typeof ScriptModelOutput>;
export type ExpandModelOutputT = z.infer<typeof ExpandModelOutput>;
export type AskModelOutputT = z.infer<typeof AskModelOutput>;
export type RecapModelOutputT = z.infer<typeof RecapModelOutput>;
export type FindModelOutputT = z.infer<typeof FindModelOutput>;
