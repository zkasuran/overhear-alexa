// Render pipeline: plan an episode outline, then render one part at a time (script, voice, mix,
// publish). Pure orchestration over the Services interfaces in contracts.ts; no concrete adapter is
// imported here, so the mock and AWS twins both drive it. The scheduler (scheduler.ts) calls
// renderPart in playback order; this file never schedules and never holds its own concurrency across
// parts. Model JSON is extracted with core extractJson and validated with the schemas.

import type { Episode, Part, Line, AudioRef, Source, FormatId } from "@overhear/core";
import {
  FORMATS,
  newEpisodeId,
  newPartId,
  newLineId,
  planPrompt,
  scriptPartPrompt,
  expandPrompt,
  extractJson,
  PART0_TARGET_SECONDS,
  PART_MAX_SECONDS,
  MODEL_TIMEOUT_MS,
  TTS_TIMEOUT_MS,
} from "@overhear/core";
import type { Services, SynthResult } from "../contracts.js";
import { PlanModelOutput, ScriptModelOutput, ExpandModelOutput } from "../schemas.js";
import { join } from "node:path";

/** A part reaches at most four voiced lines in flight at once. Voicing is the long pole; the
 * scheduler keeps parts serial so voicing never competes with itself across parts. */
const VOICE_CONCURRENCY = 4;

/** Called on every part status change so the caller can persist and report progress. */
type StatusSink = (p: Part) => void | Promise<void>;

/** Clamp a model part estimate into the render-ahead budget [short cold open, part max]. */
function clampEst(seconds: number): number {
  if (seconds < PART0_TARGET_SECONDS) return PART0_TARGET_SECONDS;
  if (seconds > PART_MAX_SECONDS) return PART_MAX_SECONDS;
  return Math.round(seconds);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build an episode outline from the source. Calls the model, extracts and validates the plan JSON,
 * then returns an Episode whose parts are all pending. It does NOT persist and does NOT render: the
 * caller stores the episode and its source (EpisodeStore.createEpisode), then drives rendering
 * through the scheduler. renderPart reads the source back from the store, so the caller must persist
 * before rendering.
 */
export async function planEpisode(
  services: Services,
  input: { source: Source; format: FormatId; minutes: number; focus?: string; principal: string },
): Promise<Episode> {
  const prompt = planPrompt({
    sourceText: input.source.value,
    format: input.format,
    minutes: input.minutes,
    ...(input.focus !== undefined ? { focus: input.focus } : {}),
  });
  const raw = await services.model.generate(prompt, { timeoutMs: MODEL_TIMEOUT_MS });
  const plan = PlanModelOutput.parse(extractJson(raw));

  const parts: Part[] = plan.parts.map(
    (p, index): Part => ({
      index,
      partId: newPartId(),
      heading: p.heading,
      summary: p.summary,
      estSeconds: clampEst(p.estSeconds),
      origin: "plan",
      status: "pending",
    }),
  );

  const iso = new Date(services.now()).toISOString();
  const episode: Episode = {
    id: newEpisodeId(),
    principal: input.principal,
    title: plan.title,
    dek: plan.dek,
    format: input.format,
    ...(input.focus !== undefined ? { focus: input.focus } : {}),
    targetSeconds: input.minutes * 60,
    status: "planned",
    parts,
    sourceKind: input.source.kind,
    createdAt: iso,
    updatedAt: iso,
  };
  return episode;
}

/**
 * Render one planned part end to end: script, voice each line, mix with the format bed, publish the
 * audio and fill the per-line timings. Reports every status change through onStatus (scripting,
 * voicing, mixing, ready). On any failure it reports status "failed" and rethrows a clear Error.
 */
export async function renderPart(
  services: Services,
  episode: Episode,
  part: Part,
  priorTranscript: string,
  onStatus: StatusSink,
): Promise<Part> {
  try {
    let current: Part = { ...part, status: "scripting" };
    await onStatus(current);

    const sourceText = await services.episodes.getSource(episode.principal, episode.id);
    if (sourceText === null) {
      throw new Error(`source not found for episode ${episode.id}`);
    }

    const prompt = scriptPartPrompt({
      sourceText,
      episodeTitle: episode.title,
      format: episode.format,
      heading: part.heading,
      summary: part.summary,
      estSeconds: part.estSeconds,
      priorTranscript,
    });
    const raw = await services.model.generate(prompt, { timeoutMs: MODEL_TIMEOUT_MS });
    const script = ScriptModelOutput.parse(extractJson(raw));
    const lines: Line[] = script.lines.map((l) => ({
      lineId: newLineId(),
      speaker: l.speaker,
      text: l.text,
    }));

    current = { ...current, status: "voicing", lines };
    await onStatus(current);
    const synths = await synthLines(services, episode.format, lines);

    current = { ...current, status: "mixing" };
    await onStatus(current);
    const mixed = await mixAndStore(services, episode, part.partId, lines, synths);

    const ready: Part = { ...current, status: "ready", lines: mixed.lines, audio: mixed.audio };
    await onStatus(ready);
    return ready;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed: Part = { ...part, status: "failed" };
    await onStatus(failed);
    services.log.error("render part failed", {
      episodeId: episode.id,
      partId: part.partId,
      error: message,
    });
    throw new Error(`renderPart failed for part ${part.partId}: ${message}`);
  }
}

/**
 * Render a new expansion part that continues from a parent part. Same voice, mix and publish path as
 * renderPart. Returns a ready Part with origin "expansion" and expandsPartId set. Inserting it into
 * the episode and renumbering is the caller's job; the index here is provisional (parent + 1).
 */
export async function expandPart(
  services: Services,
  episode: Episode,
  parentPartId: string,
  angle: string | undefined,
  transcriptSoFar: string,
  onStatus: StatusSink,
): Promise<Part> {
  const parent = episode.parts.find((p) => p.partId === parentPartId);
  if (parent === undefined) {
    throw new Error(`expandPart: parent part ${parentPartId} not found`);
  }
  const partId = newPartId();
  const summary = angle !== undefined && angle.length > 0 ? angle : parent.heading;
  const base: Omit<Part, "status"> = {
    index: parent.index + 1,
    partId,
    heading: parent.heading,
    summary,
    estSeconds: parent.estSeconds,
    origin: "expansion",
    expandsPartId: parentPartId,
  };
  try {
    let current: Part = { ...base, status: "scripting" };
    await onStatus(current);

    const sourceText = await services.episodes.getSource(episode.principal, episode.id);
    if (sourceText === null) {
      throw new Error(`source not found for episode ${episode.id}`);
    }
    const prompt = expandPrompt({
      sourceText,
      format: episode.format,
      parentHeading: parent.heading,
      transcriptSoFar,
      ...(angle !== undefined ? { angle } : {}),
    });
    const raw = await services.model.generate(prompt, { timeoutMs: MODEL_TIMEOUT_MS });
    const parsed = ExpandModelOutput.parse(extractJson(raw));
    const lines: Line[] = parsed.lines.map((l) => ({
      lineId: newLineId(),
      speaker: l.speaker,
      text: l.text,
    }));

    current = { ...current, heading: parsed.heading, status: "voicing", lines };
    await onStatus(current);
    const synths = await synthLines(services, episode.format, lines);

    current = { ...current, status: "mixing" };
    await onStatus(current);
    const mixed = await mixAndStore(services, episode, partId, lines, synths);

    const ready: Part = {
      ...current,
      status: "ready",
      estSeconds: Math.max(1, Math.round(mixed.audio.seconds)),
      lines: mixed.lines,
      audio: mixed.audio,
    };
    await onStatus(ready);
    return ready;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed: Part = { ...base, status: "failed" };
    await onStatus(failed);
    services.log.error("expand part failed", {
      episodeId: episode.id,
      parentPartId,
      error: message,
    });
    throw new Error(`expandPart failed for parent ${parentPartId}: ${message}`);
  }
}

/** Voice every line with the format+speaker voice, up to VOICE_CONCURRENCY at a time, order kept. */
async function synthLines(
  services: Services,
  format: FormatId,
  lines: readonly Line[],
): Promise<SynthResult[]> {
  const voices = services.config.voices[format];
  const results = new Array<SynthResult>(lines.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= lines.length) return;
      const line = lines[i];
      if (line === undefined) continue; // unreachable: i < lines.length
      results[i] = await synthWithRetry(services, voices[line.speaker], line.text);
    }
  };
  const count = Math.min(VOICE_CONCURRENCY, lines.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < count; i += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/** One retry with a small jitter: generative TTS fails transiently more than it fails for good. */
async function synthWithRetry(
  services: Services,
  voiceId: string,
  text: string,
): Promise<SynthResult> {
  try {
    return await services.tts.synthesize(text, voiceId, { timeoutMs: TTS_TIMEOUT_MS });
  } catch {
    await sleep(10 + Math.floor(Math.random() * 40));
    return await services.tts.synthesize(text, voiceId, { timeoutMs: TTS_TIMEOUT_MS });
  }
}

/** Mix the voiced lines with the format bed, publish the audio and read back the per-line timings. */
async function mixAndStore(
  services: Services,
  episode: Episode,
  partId: string,
  lines: readonly Line[],
  synths: readonly SynthResult[],
): Promise<{ lines: Line[]; audio: AudioRef }> {
  const bedPath = join(services.config.bedsDir, `${episode.format}.mp3`);
  const mix = await services.mixer.mix({
    lines: synths.map((s) => ({ audio: s.audio })),
    gapMs: FORMATS[episode.format].gapMs,
    bedPath,
  });
  const key = await services.storage.putAudio(episode.id, partId, mix.mp3);
  const url = await services.storage.urlFor(key);
  const timed: Line[] = lines.map((ln, i) => {
    const t = mix.lineTimings[i];
    if (t === undefined) return ln;
    return { ...ln, startMs: t.startMs, endMs: t.endMs };
  });
  const audio: AudioRef = { url, seconds: mix.seconds, mime: "audio/mpeg" };
  return { lines: timed, audio };
}
