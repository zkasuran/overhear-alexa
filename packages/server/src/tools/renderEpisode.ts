// render_episode (task, taskSupport required). Persists a task bound to the caller, launches the render
// scheduler without awaiting it, and returns a CreateTaskResult now with a spoken immediate line. Parts
// are playable before the task completes: the client watches the manifest resource and the progress
// notifications. The task result is the "everything is done" signal, not the "you may start" signal. A
// bad or non-owned episode id is reported as a spoken tool error.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { renderEpisode } from "../pipeline/scheduler.js";
import { RenderEpisodeInput } from "../schemas.js";
import type { TaskEnv } from "../tasks.js";
import { createAndLaunch } from "../tasks.js";
import { RENDER_OUTPUT } from "./outputs.js";
import { okResult, orderedParts, principalOf } from "./common.js";

/** Register render_episode on the server. */
export function registerRenderEpisode(server: McpServer, env: TaskEnv): void {
  const { services } = env;
  server.experimental.tasks.registerToolTask(
    "render_episode",
    {
      title: "Render an episode",
      description: "Script, voice and mix the planned parts in playback order. Long-running task.",
      inputSchema: RenderEpisodeInput.shape,
      outputSchema: RENDER_OUTPUT,
      execution: { taskSupport: "required" },
    },
    {
      createTask: async (args, extra) => {
        const principal = principalOf(extra);
        if (principal === undefined) throw new Error("This request is not authenticated.");
        const episode = await services.episodes.getEpisode(principal, args.episodeId);
        if (episode === null) throw new Error("I could not find that episode.");

        // Take over from any speculative part-0 render started at plan time.
        env.speculative.cancel(episode.id);

        const total = episode.parts.length;
        const estMinutes = Math.max(1, Math.round(episode.targetSeconds / 60));
        const immediate = `Starting ${episode.title} now, about ${estMinutes} minutes across ${total} parts.`;

        return createAndLaunch(
          env,
          extra,
          immediate,
          extra._meta?.progressToken,
          async ({ progress }) => {
            const nowIso = (): string => new Date(services.now()).toISOString();
            await services.episodes.patchEpisode(principal, episode.id, {
              status: "rendering",
              updatedAt: nowIso(),
            });

            const readyIds = new Set<string>();
            const handle = renderEpisode(services, episode, args.fromPart, async (part) => {
              if (part.status === "ready") readyIds.add(part.partId);
              await env.notifyResource(episode.id);
              await progress(
                readyIds.size,
                total,
                `part ${part.index} ${part.status}: ${part.heading}`,
              );
            });
            await handle.done;

            const latest = (await services.episodes.getEpisode(principal, episode.id)) ?? episode;
            const allReady =
              latest.parts.length > 0 && latest.parts.every((p) => p.status === "ready");
            await services.episodes.patchEpisode(principal, episode.id, {
              status: allReady ? "ready" : "failed",
              updatedAt: nowIso(),
            });

            const parts = orderedParts(latest).map(({ lines: _lines, ...part }) => part);
            const totalSeconds = parts.reduce((sum, p) => sum + (p.audio ? p.audio.seconds : 0), 0);
            return okResult(
              { episodeId: episode.id, status: allReady ? "ready" : "failed", parts, totalSeconds },
              allReady ? `All ${total} parts are ready.` : "Some parts could not be rendered.",
            );
          },
        );
      },
      getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
      getTaskResult: async (_args, extra) =>
        (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult,
    },
  );
}
