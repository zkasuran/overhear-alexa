// Shared domain model. Indexes are positions; ids are identity. partId and lineId are
// what citations point at. No I/O here, no model/provider types.

export type FormatId = "explainer" | "debate" | "cozy" | "hype";

export type Speaker = "host" | "expert";

export type SourceKind = "topic" | "url" | "text";
export type Source = { kind: SourceKind; value: string };

export type EpisodeStatus = "planned" | "rendering" | "ready" | "failed";
export type PartStatus = "pending" | "scripting" | "voicing" | "mixing" | "ready" | "failed";
export type PartOrigin = "plan" | "expansion";

export type AudioRef = {
  url: string; // presigned (aws) or local /media/{token} URL
  seconds: number;
  mime: "audio/mpeg";
};

export type Line = {
  lineId: string;
  speaker: Speaker;
  text: string;
  startMs?: number; // filled after mixing
  endMs?: number;
};

export type Part = {
  index: number; // 0-based playback position, re-numbered on insert
  partId: string; // stable id, survives re-numbering
  heading: string; // spoken by the producer when listing the outline
  summary: string; // one sentence, used by find_moment and recap
  estSeconds: number;
  origin: PartOrigin;
  expandsPartId?: string; // set when origin = "expansion"
  status: PartStatus;
  audio?: AudioRef;
  lines?: Line[]; // present once scripted
};

export type Episode = {
  id: string; // ep_ + 22 chars base62, CSPRNG
  principal: string; // owner (bearer token principal)
  title: string; // <= MAX_TITLE_CHARS
  dek: string; // <= MAX_DEK_CHARS
  format: FormatId;
  focus?: string;
  targetSeconds: number;
  status: EpisodeStatus;
  parts: Part[]; // ordered; expansions inserted, never appended blindly
  sourceKind: SourceKind;
  createdAt: string; // ISO 8601
  updatedAt: string;
};

/** The manifest resource is an Episode without per-line detail. */
export type PartManifest = Omit<Part, "lines">;
export type EpisodeManifest = Omit<Episode, "parts" | "principal"> & {
  parts: PartManifest[];
};

/** A citation into the transcript, produced by `ask`. */
export type Citation = { partId: string; lineId: string; quote: string };

/** A resolved position in an episode, produced by `find_moment`. */
export type Moment = {
  partId: string;
  index: number;
  offsetMs: number;
  heading: string;
  confidence: number; // 0..1
  reason: string;
};

export const FORMAT_IDS: readonly FormatId[] = ["explainer", "debate", "cozy", "hype"];

export function isFormatId(v: unknown): v is FormatId {
  return typeof v === "string" && (FORMAT_IDS as readonly string[]).includes(v);
}
