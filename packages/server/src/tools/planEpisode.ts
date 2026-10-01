// plan_episode (sync, taskSupport forbidden). Turns a source into a titled outline in one model call,
// persists the episode and its source (the pipeline does neither), kicks a speculative part-0 render so
// the first audio is ready fast, and returns the outline. A URL source is fetched first through the
// SSRF-guarded fetcher. The per-principal daily quota is enforced here from the episode count; a client
// that also wants a hook can layer one in front. Input and ceiling violations are spoken tool errors.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Episode, Source } from "@overhear/core";
import { EPISODES_PER_DAY, MAX_SOURCE_CHARS, MINUTES_MAX, MINUTES_MIN } from "@overhear/core";
import { planEpisode } from "../pipeline/pipeline.js";
import { renderEpisode } from "../pipeline/scheduler.js";
import { PlanEpisodeInput } from "../schemas.js";
import type { PlanEpisodeInputT } from "../schemas.js";
import type { TaskEnv } from "../tasks.js";
import { okResult, principalOf, toolError } from "./common.js";

/** Target length when the client names none. Elicitation of a missing value is a client-side stretch. */
const DEFAULT_MINUTES = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

const PLAN_OUTPUT_SHAPE = {
  episodeId: z.string(),
  title: z.string(),
  dek: z.string(),
  parts: z.array(
    z.object({
      index: z.number().int(),
      partId: z.string(),
      heading: z.string(),
      summary: z.string(),
      estSeconds: z.number(),
    }),
  ),
  totalEstSeconds: z.number(),
  speakable: z.string(),
};

/** Core of plan_episode, independent of the MCP wiring so it is unit-testable with fakes. */
export async function runPlanEpisode(
  env: TaskEnv,
  principal: string,
  input: PlanEpisodeInputT,
): Promise<CallToolResult> {
  const { services } = env;

  const since = new Date(services.now() - DAY_MS).toISOString();
  const used = await services.episodes.countEpisodesSince(principal, since);
  if (used >= EPISODES_PER_DAY) {
    return toolError(`You have reached the limit of ${EPISODES_PER_DAY} episodes for today.`);
  }

  let sourceText: string;
  if (input.source.kind === "url") {
    try {
      const fetched = await services.fetch.fetchUrl(input.source.value);
      sourceText = fetched.text.slice(0, MAX_SOURCE_CHARS);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "the link could not be read";
      return toolError(`I could not read that link: ${reason}`);
    }
    if (sourceText.trim().length === 0) {
      return toolError("That link had no readable text to build an episode from.");
    }
  } else {
    sourceText = input.source.value;
  }

  const minutes = Math.min(Math.max(input.minutes ?? DEFAULT_MINUTES, MINUTES_MIN), MINUTES_MAX);
  const source: Source = { kind: input.source.kind, value: sourceText };

  const episode = await planEpisode(services, {
    source,
    format: input.format,
    minutes,
    ...(input.focus !== undefined ? { focus: input.focus } : {}),
    principal,
  });
  await services.episodes.createEpisode(episode, sourceText);

  startSpeculativeRender(env, episode);

  const totalEstSeconds = episode.parts.reduce((sum, p) => sum + p.estSeconds, 0);
  const structuredContent = {
    episodeId: episode.id,
    title: episode.title,
    dek: episode.dek,
    parts: episode.parts.map((p) => ({
      index: p.index,
      partId: p.partId,
      heading: p.heading,
      summary: p.summary,
      estSeconds: p.estSeconds,
    })),
    totalEstSeconds,
    speakable: `Here is ${episode.title}, about ${minutes} minutes across ${episode.parts.length} parts.`,
  };
  return okResult(
    structuredContent,
    `Planned "${episode.title}" in ${episode.parts.length} parts. Say render to start the audio.`,
  );
}

/** Render only part 0 ahead of a render_episode call, then stop. Cancelled by render_episode or a timer. */
function startSpeculativeRender(env: TaskEnv, episode: Episode): void {
  const episodeId = episode.id;
  const handle = renderEpisode(env.services, episode, 0, async (part) => {
    await env.notifyResource(episodeId);
    if (part.index === 0 && part.status === "ready") env.speculative.cancel(episodeId);
  });
  handle.done.catch(() => env.log.warn("speculative part-0 render failed", { episodeId }));
  env.speculative.start(episodeId, handle.cancel);
}

/** Register plan_episode on the server. */
export function registerPlanEpisode(server: McpServer, env: TaskEnv): void {
  server.registerTool(
    "plan_episode",
    {
      title: "Plan an episode",
      description: "Turn a topic, URL or text into a titled two-host outline in one pass.",
      inputSchema: PlanEpisodeInput.shape,
      outputSchema: PLAN_OUTPUT_SHAPE,
    },
    async (args, extra) => {
      const principal = principalOf(extra);
      if (principal === undefined) return toolError("This request is not authenticated.");
      return runPlanEpisode(env, principal, args);
    },
  );
}
