// Render-ahead scheduler. Renders an episode's parts strictly in playback order, one at a time, so
// voicing never competes with itself. Each rendered part is persisted (EpisodeStore.putPart) and
// reported through onStatus. The prior transcript handed to each part is built from the parts already
// ready, so a part only ever sees dialogue that will play before it. Cancel stops before the next
// unrendered part is voiced; parts already ready stay ready.

import type { Episode, Part } from "@overhear/core";
import type { Services } from "../contracts.js";
import { renderPart } from "./pipeline.js";

export interface RenderHandle {
  /** Resolves when the episode is fully rendered or cancelled; rejects if a part fails. */
  done: Promise<void>;
  /** Stop before voicing the next unrendered part. The in-flight part is allowed to finish. */
  cancel: () => void;
}

type StatusSink = (p: Part) => void | Promise<void>;

export function renderEpisode(
  services: Services,
  episode: Episode,
  fromPart: number,
  onStatus: StatusSink,
): RenderHandle {
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
  };

  // Snapshot the parts in playback order. We update entries in place as they render so the next
  // part's prior transcript includes everything already voiced.
  const ordered = [...episode.parts].sort((a, b) => a.index - b.index);

  const done = (async (): Promise<void> => {
    for (let k = 0; k < ordered.length; k += 1) {
      const part = ordered[k];
      if (part === undefined) continue;
      if (cancelled) break;
      if (part.index < fromPart) continue;
      if (part.status === "ready") continue;

      const priorTranscript = buildPriorTranscript(ordered, part.index);
      const persist: StatusSink = async (p) => {
        await services.episodes.putPart(episode.principal, episode.id, p);
        await onStatus(p);
      };
      const rendered = await renderPart(services, episode, part, priorTranscript, persist);
      ordered[k] = rendered;
    }
  })();

  return { done, cancel };
}

/** Concatenate the lines of every ready part before `beforeIndex`, in playback order. */
function buildPriorTranscript(parts: readonly Part[], beforeIndex: number): string {
  const chunks: string[] = [];
  for (const p of parts) {
    if (p.index >= beforeIndex) continue;
    if (p.status !== "ready" || p.lines === undefined) continue;
    for (const ln of p.lines) chunks.push(`${ln.speaker}: ${ln.text}`);
  }
  return chunks.join("\n");
}
