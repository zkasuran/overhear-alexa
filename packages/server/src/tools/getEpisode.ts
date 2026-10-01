// get_episode (sync, taskSupport forbidden). A cheap owner-scoped read of an episode: the producer uses
// it to answer "how long is left". By default the per-line detail is dropped to keep the payload small;
// pass include ["lines"] to get the scripted lines too. A read for a non-owner returns "not found".

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GetEpisodeInput } from "../schemas.js";
import type { GetEpisodeInputT } from "../schemas.js";
import type { Services } from "../contracts.js";
import { EPISODE_OUTPUT } from "./outputs.js";
import { okResult, principalOf, toolError } from "./common.js";

/** Core of get_episode, independent of the MCP wiring so it is unit-testable with fakes. */
export async function runGetEpisode(
  services: Services,
  principal: string,
  input: GetEpisodeInputT,
): Promise<CallToolResult> {
  const episode = await services.episodes.getEpisode(principal, input.episodeId);
  if (episode === null) return toolError("I could not find that episode.");

  // Drop the owner field from the view; by default drop the per-line detail too to keep it small.
  const wantLines = input.include?.includes("lines") ?? false;
  const { principal: _owner, parts, ...rest } = episode;
  const view = {
    ...rest,
    parts: wantLines ? parts : parts.map(({ lines: _lines, ...part }) => part),
  };

  const ready = parts.filter((p) => p.status === "ready").length;
  return okResult(
    view as unknown as Record<string, unknown>,
    `"${episode.title}" has ${ready} of ${parts.length} parts ready.`,
  );
}

/** Register get_episode on the server. */
export function registerGetEpisode(server: McpServer, services: Services): void {
  server.registerTool(
    "get_episode",
    {
      title: "Get an episode",
      description:
        'Read an episode and its parts. Pass include ["lines"] for the scripted dialogue.',
      inputSchema: GetEpisodeInput.shape,
      outputSchema: EPISODE_OUTPUT,
    },
    async (args, extra) => {
      const principal = principalOf(extra);
      if (principal === undefined) return toolError("This request is not authenticated.");
      return runGetEpisode(services, principal, args);
    },
  );
}
