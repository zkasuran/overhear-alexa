// expand_part (task, taskSupport required). Writes 45 to 120 seconds of new dialogue that continues the
// chosen part in the same two voices, inserts it directly after that part and renumbers the playback
// positions (ids stay stable), persists the episode and emits a manifest update. Capped at a fixed
// number of expansions per episode. A bad or non-owned id, or a hit on the cap, is a spoken tool error.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Part } from "@overhear/core";
import { MAX_EXPANSIONS } from "@overhear/core";
import { expandPart } from "../pipeline/pipeline.js";
import { ExpandPartInput } from "../schemas.js";
import type { TaskEnv } from "../tasks.js";
import { createAndLaunch } from "../tasks.js";
import { EXPAND_OUTPUT } from "./outputs.js";
import { okResult, principalOf } from "./common.js";

/** Insert newPart directly after the parent and renumber indexes. Ids are identity and do not change. */
export function insertAfter(parts: readonly Part[], parentPartId: string, newPart: Part): Part[] {
  const ordered = [...parts].sort((a, b) => a.index - b.index);
  const pos = ordered.findIndex((p) => p.partId === parentPartId);
  const insertAt = pos < 0 ? ordered.length : pos + 1;
  const merged = [...ordered.slice(0, insertAt), newPart, ...ordered.slice(insertAt)];
  return merged.map((part, index) => ({ ...part, index }));
}

/** Plain-text transcript of ready parts up to and including the parent, for continuity conditioning. */
export function transcriptUpTo(parts: readonly Part[], parentIndex: number): string {
  const chunks: string[] = [];
  for (const p of [...parts].sort((a, b) => a.index - b.index)) {
    if (p.index > parentIndex) break;
    if (p.status !== "ready" || p.lines === undefined) continue;
    for (const line of p.lines) chunks.push(`${line.speaker}: ${line.text}`);
  }
  return chunks.join("\n");
}

/** Register expand_part on the server. */
export function registerExpandPart(server: McpServer, env: TaskEnv): void {
  const { services } = env;
  server.experimental.tasks.registerToolTask(
    "expand_part",
    {
      title: "Expand a part",
      description:
        "Add a deeper follow-up to one part, inserted right after it. Long-running task.",
      inputSchema: ExpandPartInput.shape,
      outputSchema: EXPAND_OUTPUT,
      execution: { taskSupport: "required" },
    },
    {
      createTask: async (args, extra) => {
        const principal = principalOf(extra);
        if (principal === undefined) throw new Error("This request is not authenticated.");
        const episode = await services.episodes.getEpisode(principal, args.episodeId);
        if (episode === null) throw new Error("I could not find that episode.");
        const parent = episode.parts.find((p) => p.partId === args.partId);
        if (parent === undefined) throw new Error("I could not find that part of the episode.");
        const expansions = episode.parts.filter((p) => p.origin === "expansion").length;
        if (expansions >= MAX_EXPANSIONS) {
          throw new Error(`This episode already has the maximum of ${MAX_EXPANSIONS} follow-ups.`);
        }

        const immediate = `Writing a deeper take on "${parent.heading}" now.`;
        return createAndLaunch(
          env,
          extra,
          immediate,
          extra._meta?.progressToken,
          async ({ progress }) => {
            const transcript = transcriptUpTo(episode.parts, parent.index);
            const built = await expandPart(
              services,
              episode,
              parent.partId,
              args.angle,
              transcript,
              async (part) => {
                await progress(part.status === "ready" ? 1 : 0, 1, `follow-up ${part.status}`);
              },
            );

            const latest = (await services.episodes.getEpisode(principal, episode.id)) ?? episode;
            const parts = insertAfter(latest.parts, parent.partId, built);
            await services.episodes.patchEpisode(principal, episode.id, {
              parts,
              updatedAt: new Date(services.now()).toISOString(),
            });
            await env.notifyResource(episode.id);

            const inserted = parts.find((p) => p.partId === built.partId) ?? built;
            return okResult(
              { inserted: inserted as unknown as Record<string, unknown> },
              `Added "${inserted.heading}" after that part.`,
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
